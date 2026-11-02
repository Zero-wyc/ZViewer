/**
 * Piik `/signal` 的最小客户端。
 *
 * 只做三件事：拿凭证、连 WS、把消息分发出去。共享那套（屏幕发布、路由
 * 重排、质量证据）都不在这里——语音只需要同一条连接上的 `room-voice-*`。
 *
 * 为什么不用 socket.io：Piik 的客户端写死了 `/signal` 这个裸 WebSocket，
 * 而语音的拓扑与节点身份由 Piik 的 `signal.Server` 维护。在 socket.io 上
 * 复刻一层只会得到两个真相来源。
 */
import { apiFetch, safeJson } from '@/lib/api'
import {
  DEFAULT_ROUTE_POLICY,
  SIGNALING_PROTOCOL,
  decodeServerMessage,
  type PiikAuthenticated,
  type PiikClientMessage,
  type PiikIceConfig,
  type PiikServerMessage,
} from './protocol'

/** 服务端在 8 秒内没有回 `authenticated` 就认为这条连接废了。 */
const AUTHENTICATION_TIMEOUT_MS = 8_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 8_000

export type SignalStatus =
  'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface SignalCredentials {
  roomId: string
  role: 'host' | 'viewer'
  token?: string
  viewerGrant?: string
  iceConfig: PiikIceConfig
}

interface SignalHandlers {
  onStatus: (status: SignalStatus) => void
  onMessage: (message: PiikServerMessage) => void
  /** 认证失败等不可重试的错误。 */
  onFatal: (code: string, message: string) => void
}

/** WS 关闭码：会话被同一身份的另一次连接顶替，重连没有意义。 */
const CLOSE_SESSION_REPLACED = 4001

export function signalUrl(): string {
  const url = new URL('/signal', window.location.href)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** 向 ZViewer 换一份 Piik 语音凭证（同时刷新 `/signal` 的站点通行证）。 */
export async function requestVoiceCredentials(
  roomID: string
): Promise<SignalCredentials> {
  const response = await apiFetch('/api/voice/piik/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: roomID }),
  })
  const payload = await safeJson<{
    success?: boolean
    roomId?: string
    role?: string
    token?: string
    viewerGrant?: string
    iceConfig?: PiikIceConfig
    error?: string
    message?: string
  }>(response, {})
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || payload.error || '无法获取语音凭证')
  }
  return {
    roomId: String(payload.roomId ?? ''),
    role: payload.role === 'host' ? 'host' : 'viewer',
    token: payload.token,
    viewerGrant: payload.viewerGrant,
    iceConfig: payload.iceConfig ?? { iceServers: [] },
  }
}

function clientId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  )
}

export class PiikSignal {
  private readonly roomID: string
  private readonly handlers: SignalHandlers
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private authTimer: number | null = null
  private reconnectTimer: number | null = null
  private readonly clientId = clientId()

  peerId = ''
  authenticated: PiikAuthenticated | null = null

  constructor(roomID: string, handlers: SignalHandlers) {
    this.roomID = roomID
    this.handlers = handlers
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.peerId !== ''
  }

  async start(): Promise<void> {
    if (this.stopped || this.socket) return
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    this.peerId = ''
    this.authenticated = null
    if (socket && socket.readyState <= WebSocket.OPEN)
      socket.close(1000, 'client-stop')
    this.handlers.onStatus('closed')
  }

  send(message: PiikClientMessage): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  // ==================== 内部 ====================

  private async connect(): Promise<void> {
    if (this.stopped) return
    let credentials: SignalCredentials
    try {
      credentials = await requestVoiceCredentials(this.roomID)
    } catch (error) {
      this.handlers.onFatal(
        'CREDENTIALS',
        error instanceof Error ? error.message : '无法获取语音凭证'
      )
      return
    }
    if (this.stopped) return

    const socket = new WebSocket(signalUrl())
    this.socket = socket
    socket.onopen = () => this.authenticate(socket, credentials)
    socket.onmessage = (event) => this.receive(String(event.data))
    socket.onclose = (event) => this.closed(event.code)
    socket.onerror = () => {
      // 具体原因由 onclose 给出，这里不重复上报。
    }
  }

  private authenticate(
    socket: WebSocket,
    credentials: SignalCredentials
  ): void {
    this.armAuthTimer(socket)
    const base = {
      type: 'authenticate' as const,
      protocol: SIGNALING_PROTOCOL,
      roomId: credentials.roomId,
      clientId: this.clientId,
    }
    const message: PiikClientMessage =
      credentials.role === 'host'
        ? {
            ...base,
            role: 'host',
            token: credentials.token ?? '',
            // 语音不需要共享画布，roomOnly 让服务端只维护房间与会话，
            // 不因为「没有 shareGeneration」把房主判成异常状态。
            roomOnly: true,
            roomSession: true,
            // 语音不涉及画布，但仍要把拓扑策略说清楚：服务端会按它决定
            // 是否允许观众互助。与 Piik 默认值一致。
            routePolicy: DEFAULT_ROUTE_POLICY,
          }
        : { ...base, role: 'viewer', viewerGrant: credentials.viewerGrant }
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message))
  }

  private armAuthTimer(socket: WebSocket): void {
    this.clearAuthTimer()
    this.authTimer = window.setTimeout(() => {
      this.authTimer = null
      if (this.socket === socket && !this.peerId)
        socket.close(4000, 'auth-timeout')
    }, AUTHENTICATION_TIMEOUT_MS)
  }

  private receive(raw: string): void {
    const message = decodeServerMessage(raw)
    if (!message) return
    if (message.type === 'authenticated') {
      this.clearAuthTimer()
      this.peerId = String((message as PiikAuthenticated).peerId ?? '')
      this.authenticated = message as PiikAuthenticated
      this.attempt = 0
      this.handlers.onStatus('open')
    }
    this.handlers.onMessage(message)
  }

  private closed(code: number): void {
    this.socket = null
    this.peerId = ''
    this.authenticated = null
    this.clearAuthTimer()
    if (this.stopped) {
      this.handlers.onStatus('closed')
      return
    }
    if (code === CLOSE_SESSION_REPLACED || code === 1008) {
      this.handlers.onFatal('SESSION_CLOSED', '同账号在别处开始了语音')
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.attempt += 1
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.attempt - 1),
      RECONNECT_MAX_MS
    )
    this.handlers.onStatus('reconnecting')
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      window.clearTimeout(this.authTimer)
      this.authTimer = null
    }
  }

  private clearTimers(): void {
    this.clearAuthTimer()
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
