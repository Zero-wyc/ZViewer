/**
 * 语音的 `/signal` 客户端。
 *
 * 连接本身在 `modules/piik-signal`（共享也要用同一条），这里只负责语音特有的
 * 两件事：换语音凭证、按角色拼认证帧。
 */
import { t } from '@/i18n'
import { apiFetch, safeJson } from '@/lib/api'
import {
  DEFAULT_ROUTE_POLICY,
  SIGNALING_PROTOCOL,
  type PiikAuthenticated,
  type PiikIceConfig,
  type PiikServerMessage as RawServerMessage,
} from '../piik-signal/protocol.ts'
import type { PiikClientMessage, PiikServerMessage } from './protocol.ts'
import {
  PiikSignalClient,
  clientId,
  signalUrl,
  type PiikSignalHandlers,
  type SignalStatus,
} from '../piik-signal/client.ts'
import { acquireLink, linkKey } from '../piik-signal/link.ts'
export { signalUrl }
export type { SignalStatus }

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
    throw new Error(payload.message || payload.error || t('无法获取语音凭证'))
  }
  return {
    roomId: String(payload.roomId ?? ''),
    role: payload.role === 'host' ? 'host' : 'viewer',
    token: payload.token,
    viewerGrant: payload.viewerGrant,
    iceConfig: payload.iceConfig ?? { iceServers: [] },
  }
}

/** 语音的认证帧：房主只进房不开播，观众凭 grant 进。 */
export function voiceAuthFrame(
  credentials: SignalCredentials,
  client: string
): PiikClientMessage {
  const base = {
    type: 'authenticate' as const,
    protocol: SIGNALING_PROTOCOL,
    roomId: credentials.roomId,
    clientId: client,
  }
  if (credentials.role === 'host') {
    return {
      ...base,
      role: 'host',
      token: credentials.token ?? '',
      // 语音不需要共享画布，roomOnly 让服务端只维护房间与会话，
      // 不因为「没有 shareGeneration」把房主判成异常状态。
      roomOnly: true,
      roomSession: true,
      routePolicy: DEFAULT_ROUTE_POLICY,
    }
  }
  return { ...base, role: 'viewer', viewerGrant: credentials.viewerGrant }
}

export class PiikSignal {
  /**
   * 语音不自己开连接，挂到房间那条上。
   *
   * 房主开播后 Piik 只认一个 host 连接，语音再单开一条会被
   * `HOST_ALREADY_CONNECTED` 顶回来，房主加不进语音，房间语音就永远
   * `not-enabled`。共用同一条连接还顺带省掉一次握手。
   */
  private readonly link
  private readonly handlers: SignalHandlers
  /** 同一次页面会话内固定，重连时服务端据此认「还是这个人」。 */
  private readonly id = clientId()

  constructor(roomID: string, handlers: SignalHandlers) {
    this.handlers = handlers
    this.link = acquireLink(
      linkKey(roomID),
      handlers as unknown as PiikSignalHandlers,
      (sink) =>
        new PiikSignalClient({
          authenticate: async () =>
            voiceAuthFrame(await requestVoiceCredentials(roomID), this.id),
          onStatus: sink.onStatus,
          // 连接层只认 `type`，语音的判别联合在这里收窄一次；
          // 两边各留一份联合类型，避免「语音加了一个消息族」牵连共享。
          onMessage: (message: RawServerMessage) =>
            handlers.onMessage(message as PiikServerMessage),
          onFatal: sink.onFatal,
        })
    )
  }

  get peerId(): string {
    return this.link.client.peerId
  }

  get authenticated(): PiikAuthenticated | null {
    return this.link.client.authenticated
  }

  get connected(): boolean {
    return this.link.client.connected
  }

  async start(): Promise<void> {
    await this.link.client.start()
    // 复用共享那条已经握手的连接：不会再收到 open，订阅与 join 得自己补。
    if (this.link.client.connected) this.handlers.onStatus('open')
  }

  stop(): void {
    this.link.release()
  }

  send(message: PiikClientMessage): boolean {
    return this.link.client.send(message)
  }
}
