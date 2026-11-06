/**
 * 共享会话：凭证、握手、开播、边的生命周期。
 *
 * 与 `piik-voice` 共用 `modules/piik-signal` 的连接层，区别只在这里要
 * `start-sharing` 起一个代际，并接管 `route-update` 的候选边。
 */
import { t } from '@/i18n'
import { apiFetch, safeJson } from '@/lib/api'
import {
  SIGNALING_PROTOCOL,
  type PiikClientMessage,
  type PiikIceConfig,
  type PiikRoutePolicy,
  type PiikServerMessage,
  type PiikSharingStarted,
} from '../piik-signal/protocol.ts'
import {
  PiikSignalClient,
  clientId,
  type SignalStatus,
} from '../piik-signal/client.ts'
import { acquireLink, linkKey, type PiikLink } from '../piik-signal/link.ts'
import { ShareEndpoint, type ShareHealthSample } from './endpoint.ts'
import type { ShareEdgeStats } from '../screen-sharing/core/edge-stats.ts'
import type {
  QualityProfile,
  VideoSenderParameterReadback,
} from '../screen-sharing/core/quality.ts'
export interface ShareCredentials {
  roomId: string
  role: 'host' | 'viewer'
  token?: string
  viewerGrant?: string
  iceConfig: PiikIceConfig
}

export interface ShareSessionHandlers {
  onStatus: (status: SignalStatus) => void
  onStream: (connectionId: string, stream: MediaStream) => void
  onStateChange: (connectionId: string, state: RTCPeerConnectionState) => void
  onError: (message: string) => void
  /** 房主：服务端确认开播。 */
  onSharingStarted?: (message: PiikSharingStarted) => void
  /** 房主上下线 / 暂停状态。观众靠它决定遮罩与「等待房主」文案。 */
  onHostStatus?: (status: { online: boolean; paused: boolean }) => void
  /** 房主停止了共享（连接还在，房间还在）。 */
  onSharingStopped?: () => void
  /** 房间被关掉，重连没有意义。 */
  onRoomClosed?: (reason: string) => void
  /** 认证成功，拿到 peerId。 */
  onAuthenticated?: (peerId: string) => void
}

/**
 * 凭证签发失败。
 *
 * `code` 来自服务端的机器可读类型，`retriable` 表示「现在签不出来，但过会儿
 * 可能就行了」——观众比房主先到就属于这一类，连接层据此只重试、不报错。
 */
export class ShareCredentialsError extends Error {
  readonly code: string
  readonly retriable: boolean

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ShareCredentialsError'
    this.code = code
    this.retriable = code === 'HOST_NOT_SHARING'
  }
}

/** 从 `/api/share/piik/session` 换一份共享凭证（顺带刷新站点通行证）。 */
export async function requestShareCredentials(
  roomID: string
): Promise<ShareCredentials> {
  const response = await apiFetch('/api/share/piik/session', {
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
    code?: string
  }>(response, {})
  if (!response.ok || !payload.success) {
    throw new ShareCredentialsError(
      payload.message || payload.error || t('无法获取共享凭证'),
      String(payload.code ?? '')
    )
  }
  return {
    roomId: String(payload.roomId ?? ''),
    role: payload.role === 'host' ? 'host' : 'viewer',
    token: payload.token,
    viewerGrant: payload.viewerGrant,
    iceConfig: payload.iceConfig ?? { iceServers: [] },
  }
}

/** 共享的拓扑策略：允许观众互助。 */
const SHARE_ROUTE_POLICY: PiikRoutePolicy = {
  peerOnly: false,
  topologyOptimization: true,
  natPrediction: false,
}

export class PiikShareSession {
  private readonly roomID: string
  private readonly handlers: ShareSessionHandlers
  private readonly clientId = clientId()
  private client: PiikSignalClient | null = null
  /** 连接按房间共享：语音可能也挂在同一条上，释放只能减自己那份引用。 */
  private link: PiikLink | null = null
  private endpoint: ShareEndpoint | null = null
  private role: 'host' | 'viewer' = 'viewer'
  private stream: MediaStream | null = null
  private shareGeneration = ''
  private iceConfig: PiikIceConfig = { iceServers: [] }
  private started = false

  constructor(roomID: string, handlers: ShareSessionHandlers) {
    this.roomID = roomID
    this.handlers = handlers
  }

  get peerId(): string {
    return this.client?.peerId ?? ''
  }

  get connected(): boolean {
    return this.client?.connected ?? false
  }

  /** 当前建立了几条边（房主是观众数，观众是 1 或 2）。 */
  get edgeCount(): number {
    return this.endpoint?.connectionIds().length ?? 0
  }

  /**
   * 连上并发起共享（房主）或等待接入（观众）。
   *
   * 房主必须先把屏幕流准备好：`start-sharing` 之后服务端才分配观众，
   * 那时再要流就来不及了——第一条 offer 里会没有视频轨。
   */
  async start(stream?: MediaStream): Promise<void> {
    if (this.started) return
    this.started = true
    this.stream = stream ?? null
    this.endpoint = new ShareEndpoint(this.iceConfig, this.stream, {
      send: (message) => this.client?.send(message) ?? false,
      onStream: this.handlers.onStream,
      onStateChange: this.handlers.onStateChange,
    })
    // 同房间只维持一条连接：语音、共享共用，各自只订阅自己认得的消息。
    this.link = acquireLink(
      linkKey(this.roomID),
      {
        onStatus: this.handlers.onStatus,
        onMessage: (message) => this.receive(message),
        onFatal: (code, message) =>
          // 凭证类失败本身就是一句给人看的话，别把内部码拼到前面。
          this.handlers.onError(
            code === 'CREDENTIALS' ? message : `${code}: ${message}`
          ),
      },
      (handlers) =>
        new PiikSignalClient({
          authenticate: () => this.buildAuthenticate(),
          onStatus: handlers.onStatus,
          onMessage: handlers.onMessage,
          onFatal: handlers.onFatal,
        })
    )
    this.client = this.link.client
    await this.client.start()
    // 复用一条已经握手的连接（语音先加入、或停播后重新开播）时，
    // `authenticated` 不会再来一次：房主要自己补开播，否则界面显示已连接
    // 但服务端根本没收到 start-sharing。
    if (this.client.connected) {
      this.role = this.client.authenticated?.role ?? this.role
      this.handlers.onStatus('open')
      if (this.role === 'host' && !this.shareGeneration) {
        this.startSharing()
      } else if (this.role === 'viewer') {
        this.client.send({ type: 'relay-capacity', downstreamEdges: 3 })
      }
    }
  }

  /**
   * 换本地推出去的流（换源 / 换分辨率）。
   *
   * 只在房主侧有意义：观众当中间节点时推的是上游来的流，换不了。
   */
  async replaceStream(stream: MediaStream): Promise<void> {
    if (this.role !== 'host') return
    this.stream = stream
    await this.endpoint?.replaceLocalStream(stream)
  }

  /**
   * 房主暂停/恢复共享。
   *
   * 两件事必须都做：告诉服务端（挂起路由树，不再给新观众分配候选），
   * 以及本地把出边的轨摘掉。只发消息的话，已经连上的观众照旧收流——
   * 直连边的媒体不经过服务端，它没法替你停。
   */
  setPaused(paused: boolean): void {
    if (this.role !== 'host' || !this.shareGeneration) return
    this.client?.send({
      type: 'set-sharing-paused',
      shareGeneration: this.shareGeneration,
      paused,
    })
    void this.endpoint?.setSending(paused)
  }

  /**
   * 热更新帧率/降采样（不重采集），返回浏览器回读的结果。
   *
   * 回读非空即「浏览器没照办」，调用方据此提示用户；空数组表示全部生效
   * 或当前没有出边（还没观众）。
   */
  async applyEncoding(
    profile: QualityProfile
  ): Promise<VideoSenderParameterReadback[]> {
    return (await this.endpoint?.applyEncoding(profile)) ?? []
  }

  /** 每条出边的一次编码健康采样。 */
  async healthSamples(): Promise<ShareHealthSample[]> {
    return (await this.endpoint?.healthSamples()) ?? []
  }

  /** 每条边的用量，给统计面板。 */
  async stats(): Promise<ShareEdgeStats[]> {
    return (await this.endpoint?.stats()) ?? []
  }

  stop(): void {
    this.started = false
    if (this.client && this.role === 'host' && this.shareGeneration) {
      this.client.send({
        type: 'stop-sharing',
        shareGeneration: this.shareGeneration,
      })
    }
    // 代际已经用完；不清空的话「停播后用同一条连接重新开播」会被
    // 上一条 guard 挡掉，表现为按钮点了没反应。
    this.shareGeneration = ''
    this.endpoint?.close()
    this.endpoint = null
    // 只释放自己那份：语音还开着的时候这条连接必须留着。
    this.link?.release()
    this.link = null
    this.client = null
  }

  private async buildAuthenticate(): Promise<PiikClientMessage | null> {
    const credentials = await requestShareCredentials(this.roomID)
    this.role = credentials.role
    this.iceConfig = credentials.iceConfig
    this.endpoint?.setIceConfig(credentials.iceConfig)
    const base = {
      type: 'authenticate' as const,
      protocol: SIGNALING_PROTOCOL,
      roomId: credentials.roomId,
      clientId: this.clientId,
    }
    if (credentials.role === 'host') {
      return {
        ...base,
        role: 'host',
        token: credentials.token ?? '',
        // 只进房、先不开播：start-sharing 才起代际。带了 roomOnly 之后
        // 服务端不会给这个连接留 publication，离线期间也不算「在播」。
        roomOnly: true,
        roomSession: true,
        routePolicy: SHARE_ROUTE_POLICY,
      }
    }
    return {
      ...base,
      role: 'viewer',
      viewerGrant: credentials.viewerGrant,
    }
  }

  private receive(message: PiikServerMessage): void {
    switch (message.type) {
      case 'authenticated': {
        const authenticated = message as {
          peerId?: string
          iceConfig?: PiikIceConfig
        }
        if (authenticated.iceConfig) {
          this.iceConfig = authenticated.iceConfig
          this.endpoint?.setIceConfig(authenticated.iceConfig)
        }
        this.handlers.onAuthenticated?.(String(authenticated.peerId ?? ''))
        if (this.role === 'host') {
          // 复用连接时可能已经补过一次开播，别开第二个代际。
          if (!this.shareGeneration) this.startSharing()
        } else {
          // 观众也要报一次「我能带几个下游」，否则服务端把它的容量当 0，
          // 树永远只有房主一层，第 4 位观众会一直排队。
          this.client?.send({ type: 'relay-capacity', downstreamEdges: 3 })
        }
        return
      }
      case 'sharing-started':
        this.handlers.onSharingStarted?.(
          message as unknown as PiikSharingStarted
        )
        return
      case 'host-status': {
        const status = message as { online?: boolean; paused?: boolean }
        this.handlers.onHostStatus?.({
          online: Boolean(status.online),
          paused: Boolean(status.paused),
        })
        return
      }
      case 'sharing-stopped':
        this.handlers.onSharingStopped?.()
        return
      case 'room-closed':
        this.handlers.onRoomClosed?.(
          String((message as { reason?: string }).reason ?? '')
        )
        return
      case 'sharing-start-failed':
        this.handlers.onError(t('开播失败：服务端拒绝了这个代际'))
        return
      case 'route-status': {
        const status = message as { state?: string; reason?: string }
        if (status.state === 'failed')
          this.handlers.onError(
            t('选路失败：{{reason}}', {
              reason: status.reason ?? t('未知'),
            })
          )
        return
      }
      case 'error': {
        const error = message as { code?: string; message?: string }
        this.handlers.onError(
          `${error.code ?? 'ERROR'}: ${error.message ?? ''}`
        )
        return
      }
      default:
        this.endpoint?.handle(message)
        return
    }
  }

  private startSharing(): void {
    if (this.shareGeneration) return
    // 带时间戳：同一个连接停播后再开播要换一个代际，服务端拿它区分
    // 「新的这次开播」与「已经停掉的那次」，重复的 generation 会被拒。
    this.shareGeneration =
      'zg' + this.clientId.slice(0, 8) + Date.now().toString(36)
    this.client?.send({
      type: 'start-sharing',
      shareGeneration: this.shareGeneration,
      routePolicy: SHARE_ROUTE_POLICY,
    })
  }
}
