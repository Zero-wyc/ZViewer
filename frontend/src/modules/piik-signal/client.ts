/**
 * Piik `/signal` 的连接层：握手、重连、帧分发。
 *
 * 共享和语音共用这一份。为什么不用 socket.io：Piik 的客户端写死了 `/signal`
 * 这个裸 WebSocket，而拓扑与节点身份由 Piik 的 `signal.Server` 维护。在
 * socket.io 上复刻一层只会得到两个真相来源。
 *
 * 这一层不构造认证帧——房主与观众的字段差异、共享与语音的 `roomOnly` 差异
 * 都由调用方决定，它只负责「连上、把帧发出去、把帧收回来」。
 */
import { t } from '@/i18n'
import {
  FATAL_AUTH_CODES,
  decodeServerMessage,
  type PiikAuthenticated,
  type PiikServerMessage,
} from './protocol.ts'
/** 服务端在 8 秒内没有回 `authenticated` 就认为这条连接废了。 */
const AUTHENTICATION_TIMEOUT_MS = 8_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 8_000
/** 换凭证失败的退避上限：按 1/2/4/8 秒退避，约两分钟。 */
const MAX_CREDENTIAL_RETRIES = 30

/** WS 关闭码：会话被同一身份的另一次连接顶替，重连没有意义。 */ const CLOSE_SESSION_REPLACED = 4001
/** 协议错误（服务端判定消息不合法）。 */
const CLOSE_INVALID_MESSAGE = 1008

export type SignalStatus =
  'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface PiikSignalHandlers {
  onStatus?: (status: SignalStatus) => void
  onMessage: (message: PiikServerMessage) => void
  /** 认证失败等不可重试的错误。 */
  onFatal?: (code: string, message: string) => void
}

export interface PiikSignalClientOptions extends PiikSignalHandlers {
  /**
   * 换一次凭证并返回 authenticate 帧。
   *
   * 每次（重）连都会调用：REST 那一步顺带刷新 `/signal` 的站点通行证，
   * 缓存凭证反而会在空房回收后撞上 INVALID_TOKEN。
   */
  authenticate: () => Promise<unknown>
}

/**
 * 凭证错误里「还在等」的那一类。
 *
 * 约定：调用方抛错时挂 `retriable: true`——只有它知道这个 409 是「房主还没开播」
 * （等一会儿就好）还是别的冲突。连接层不认识业务错误类型，只看这个标记。
 */
function isWaiting(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { retriable?: unknown }).retriable === true
  )
}

export function signalUrl(): string {
  const url = new URL('/signal', window.location.href)
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/** 32 位十六进制的不透明 id，服务端用 `ValidOpaqueID` 校验。 */
export function clientId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  )
}

export class PiikSignalClient {
  private readonly options: PiikSignalClientOptions
  private socket: WebSocket | null = null
  private stopped = false
  private attempt = 0
  private authTimer: number | null = null
  private reconnectTimer: number | null = null
  /**
   * 多个订阅者共用一条连接。
   *
   * 共享与语音在同一次页面会话里必须走同一条 `/signal`——Piik 每个房间只认
   * 一个 host 连接，各开一条会撞 HOST_ALREADY_CONNECTED，后连的那个（语音）
   * 直接不可用。消息按 `type` 各自收窄，认不出的忽略。
   */
  private readonly messageListeners = new Set<
    (message: PiikServerMessage) => void
  >()
  private readonly statusListeners = new Set<(status: SignalStatus) => void>()
  private readonly fatalListeners = new Set<
    (code: string, message: string) => void
  >()
  private lastStatus: SignalStatus = 'idle'

  peerId = ''
  authenticated: PiikAuthenticated | null = null

  constructor(options: PiikSignalClientOptions) {
    this.options = options
    this.messageListeners.add(options.onMessage)
    if (options.onStatus) this.statusListeners.add(options.onStatus)
    if (options.onFatal) this.fatalListeners.add(options.onFatal)
  }

  /**
   * 挂到这条连接上收消息。
   *
   * 状态不做自动回放：回放发生在构造函数返回之前，调用方那边的
   * `const signal = new PiikSignal(...)` 还没赋值，回调里用 `signal` 会撞
   * TDZ。复用方在 `start()` 之后自己看一眼 `status` 即可。
   */
  subscribe(handlers: PiikSignalHandlers): () => void {
    this.messageListeners.add(handlers.onMessage)
    if (handlers.onStatus) this.statusListeners.add(handlers.onStatus)
    if (handlers.onFatal) this.fatalListeners.add(handlers.onFatal)
    return () => {
      this.messageListeners.delete(handlers.onMessage)
      if (handlers.onStatus) this.statusListeners.delete(handlers.onStatus)
      if (handlers.onFatal) this.fatalListeners.delete(handlers.onFatal)
    }
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.peerId !== ''
  }

  /** 当前状态；复用已有连接的调用方据此补一次「已连接」。 */
  get status(): SignalStatus {
    return this.lastStatus
  }

  async start(): Promise<void> {
    if (this.stopped || this.socket) return
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
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
    this.setStatus('closed')
  }

  /**
   * 发一帧。参数收 `unknown` 是因为共享与语音的客户端消息族不同，
   * 具体形状由各自模块的类型保证；这一层只做序列化与发送。
   */
  send(message: unknown): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }

  // ==================== 内部 ====================

  private async connect(): Promise<void> {
    if (this.stopped) return
    let frame: unknown = null
    try {
      frame = await this.options.authenticate()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t('无法获取信令凭证')
      // 「还在等」的错误（观众先到、房主没开播）只重试，不上报：
      // 把它当失败会让观众一进房就看到红字，而它下一秒就可能自愈。
      if (isWaiting(error)) {
        if (this.attempt >= MAX_CREDENTIAL_RETRIES) {
          this.fatal('CREDENTIALS', message)
          return
        }
        this.scheduleReconnect('wait')
        return
      }
      this.fatal('CREDENTIALS', message)
      // 退避重试但设上限，免得未登录这种永久错误无限重连。
      if (this.attempt < MAX_CREDENTIAL_RETRIES) this.scheduleReconnect()
      return
    }
    if (this.stopped || !frame) return

    const socket = new WebSocket(signalUrl())
    this.socket = socket
    socket.onopen = () => {
      this.armAuthTimer(socket)
      socket.send(JSON.stringify(frame))
    }
    socket.onmessage = (event) => this.receive(String(event.data))
    socket.onclose = (event) => this.closed(event.code, event.reason)
    socket.onerror = () => {
      // 具体原因由 onclose 给出，这里不重复上报。
    }
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
      const authenticated = message as unknown as PiikAuthenticated
      this.peerId = String(authenticated.peerId ?? '')
      this.authenticated = authenticated
      this.attempt = 0
      this.setStatus('open')
    }
    for (const listener of this.messageListeners) listener(message)
  }

  private closed(code: number, reason: string): void {
    this.socket = null
    this.peerId = ''
    this.authenticated = null
    this.clearAuthTimer()
    if (this.stopped) {
      this.setStatus('closed')
      return
    }
    if (code === CLOSE_SESSION_REPLACED) {
      this.fatal('SESSION_REPLACED', t('同账号在别处打开了同一个房间'))
      return
    }
    if (code === CLOSE_INVALID_MESSAGE) {
      this.fatal(
        'INVALID_MESSAGE',
        reason || t('客户端发了一条服务端不认识的消息')
      )
      return
    }
    this.scheduleReconnect()
  }

  /**
   * 排一次重连。
   *
   * `wait` 用于「房主还没开播」这种预期内的等待：不上报 `reconnecting`，
   * 否则页面会把「等待房主」写成「正在重新连接」，看起来像出了问题。
   */
  private scheduleReconnect(mode: 'reconnect' | 'wait' = 'reconnect'): void {
    this.attempt += 1
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** (this.attempt - 1),
      RECONNECT_MAX_MS
    )
    if (mode === 'reconnect') this.setStatus('reconnecting')
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private setStatus(value: SignalStatus): void {
    this.lastStatus = value
    for (const listener of this.statusListeners) listener(value)
  }

  private fatal(code: string, message: string): void {
    for (const listener of this.fatalListeners) listener(code, message)
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

export { FATAL_AUTH_CODES }
