/**
 * 共享会话：凭证、握手、开播、边的生命周期。
 *
 * 与 `piik-voice` 共用 `modules/piik-signal` 的连接层，区别只在这里要
 * `start-sharing` 起一个代际，并接管 `route-update` 的候选边。
 */
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
import { ShareEndpoint, type ShareEdgeStats } from './endpoint.ts'

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
  }>(response, {})
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || payload.error || '无法获取共享凭证')
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
    this.client = new PiikSignalClient({
      authenticate: () => this.buildAuthenticate(),
      onStatus: this.handlers.onStatus,
      onMessage: (message) => this.receive(message),
      onFatal: (code, message) => this.handlers.onError(`${code}: ${message}`),
    })
    await this.client.start()
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

  /** 房主暂停/恢复共享。服务端会把路由树挂起，不再分配新的候选。 */
  setPaused(paused: boolean): void {
    if (this.role !== 'host' || !this.shareGeneration) return
    this.client?.send({
      type: 'set-sharing-paused',
      shareGeneration: this.shareGeneration,
      paused,
    })
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
    this.endpoint?.close()
    this.endpoint = null
    this.client?.stop()
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
        if (this.role === 'host') {
          this.startSharing()
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
      case 'sharing-start-failed':
        this.handlers.onError('开播失败：服务端拒绝了这个代际')
        return
      case 'route-status': {
        const status = message as { state?: string; reason?: string }
        if (status.state === 'failed')
          this.handlers.onError(`选路失败：${status.reason ?? '未知'}`)
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
    this.shareGeneration = 'zg' + this.clientId.slice(0, 14)
    this.client?.send({
      type: 'start-sharing',
      shareGeneration: this.shareGeneration,
      routePolicy: SHARE_ROUTE_POLICY,
    })
  }
}
