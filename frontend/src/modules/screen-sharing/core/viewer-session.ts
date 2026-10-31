/**
 * 观众侧共享会话。
 *
 * 把「控制面（share 事件）」「一条接收端连接」「首帧证明」接起来：
 *
 *  - `share.route{prepare}` 到达 → 记住路由版本，等房主的 offer；
 *  - offer 到达 → `ViewerPeer` 建连并回 answer；
 *  - 连上 → `share.transport-connected`（只是进度）；
 *  - 解出首帧 → `share.route-ready{phase:"prepare"}`（**这才是提交**）；
 *  - 服务端下发 `share.route{active}` → 画面可以挂上了。
 *
 * 第 3 步和第 4 步必须分开：Piik 的 `handleRouteReady` 只接受 prepare，
 * `transport-connected` 只是进度（router.go:796-846,862-893）。合并会让
 * 「连上了但全黑」被当成成功。
 */
import type { Socket } from 'socket.io-client'
import type {
  ShareCandidate,
  ShareSnapshotMessage,
  ShareServerMessage,
} from '../protocol/types'
import { ShareClient } from './share-client'
import { ViewerPeer, type ViewerPeerSnapshot } from './viewer-peer'

export interface ViewerSessionState {
  joined: boolean
  /** 房主正在共享。 */
  sharing: boolean
  /** 房主暂停了画面（观众保留最后一帧）。 */
  paused: boolean
  /** 路由已提交，可以显示画面。 */
  active: boolean
  /** 正在自动恢复。 */
  recovering: boolean
  /** 恢复预算耗尽，需要用户点重试。 */
  exhausted: boolean
  hasVideo: boolean
  error: string | null
}

export interface ViewerSessionOptions {
  socket: Socket
  roomId: string
  iceServers: RTCIceServer[]
  onStateChange?: (state: ViewerSessionState) => void
  onSnapshot?: (snapshot: ShareSnapshotMessage) => void
  /** 远端流；`null` 表示流已拆（页面可以保留最后一帧，但不能再当成有画面）。 */
  onStream?: (stream: MediaStream | null) => void
  onPeerUpdate?: (snapshot: ViewerPeerSnapshot) => void
  onError?: (code: string, message: string) => void
}

export class ShareViewerSession {
  private readonly options: ViewerSessionOptions
  private readonly client: ShareClient
  private peer: ViewerPeer | null = null
  private unsubscribe: (() => void) | null = null

  private revision = 0
  private connectionId = ''
  private shareGeneration = ''
  /** 本次候选是否走服务端中继（transport=relay）。 */
  private relay = false
  /** 中继发布身份：观众写 sfu-signal 时的栅栏字段。 */
  private publicationGeneration = ''
  /** 已发出订阅请求的连接，避免同一条边重复 subscribe。 */
  private subscribedFor = ''
  private remoteStream: MediaStream | null = null
  private state: ViewerSessionState = {
    joined: false,
    sharing: false,
    paused: false,
    active: false,
    recovering: false,
    exhausted: false,
    hasVideo: false,
    error: null,
  }

  constructor(options: ViewerSessionOptions) {
    this.options = options
    this.client = new ShareClient(options.socket, options.roomId)
    this.unsubscribe = this.client.subscribe((message) =>
      this.onMessage(message)
    )
  }

  get remote(): MediaStream | null {
    return this.remoteStream
  }

  /** 底层连接，给统计面板用。 */
  get peerConnection(): RTCPeerConnection | null {
    return this.peer?.getConnection() ?? null
  }

  get currentState(): ViewerSessionState {
    return { ...this.state }
  }

  /** 进会话，取回快照并等待路由。 */
  hello(): void {
    this.client.hello(this.shareGeneration || undefined)
  }

  /** 用户点「重试」：直接重建连接（不再走 ICE restart）。 */
  retry(): boolean {
    if (!this.peer) return false
    const sent = this.peer.requestRecovery(true)
    if (sent) this.patch({ exhausted: false, recovering: true, error: null })
    return sent
  }

  dispose(): void {
    this.peer?.dispose()
    this.peer = null
    this.remoteStream = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.client.dispose()
  }

  // ==================== 内部 ====================

  private onMessage(message: ShareServerMessage): void {
    switch (message.t) {
      case 'share.snapshot':
        this.handleSnapshot(message)
        return
      case 'share.route':
        this.handleRoute(message.revision, message.phase, message.candidate)
        return
      case 'share.sfu-signal':
        this.handleSfuSignal(message)
        return
      case 'share.signal-relay':
        this.handleRelay(message.connectionId, message.kind, message.payload)
        return
      case 'share.status':
        if (message.state !== 'failed') return
        this.patch({
          exhausted: true,
          error:
            message.reason === 'relay-unreachable'
              ? 'share.viewer.error.relay'
              : 'share.viewer.error.routeExhausted',
        })
        return
      case 'share.error':
        this.options.onError?.(message.code, message.message)
        return
      default:
        return
    }
  }

  private handleSnapshot(snapshot: ShareSnapshotMessage): void {
    this.revision = snapshot.revision
    this.shareGeneration = snapshot.shareGeneration
    this.options.onSnapshot?.(snapshot)
    if (!snapshot.sharing) {
      // 共享结束：拆掉连接、清画面，但不关闭会话（房主随时可能再开）。
      this.teardownPeer()
      this.patch({
        joined: true,
        sharing: false,
        paused: false,
        active: false,
        recovering: false,
        exhausted: false,
        hasVideo: false,
        error: null,
      })
      return
    }
    this.patch({ joined: true, sharing: true, paused: snapshot.paused })
  }

  private handleRoute(
    revision: number,
    phase: string,
    candidate: ShareCandidate | undefined
  ): void {
    const connectionId = candidate?.connectionId
    if (!connectionId) return
    // 版本栅栏：只有当前版本的 route 才有意义。
    this.revision = revision
    const mine = this.isMine(connectionId)
    if (!mine) {
      // 新候选（或重建后的新身份）：旧连接立刻作废。
      if (this.connectionId && this.connectionId !== connectionId) {
        this.teardownPeer()
      }
      this.connectionId = connectionId
    }
    const relayCandidate = this.relayOf(candidate)
    if (relayCandidate) {
      this.relay = true
      this.publicationGeneration = relayCandidate
      // 中继模式下观众不向房主要 offer：先订阅，等服务器把 offer 推下来。
      if (phase === 'prepare') this.subscribe(connectionId)
    } else {
      this.relay = false
      this.publicationGeneration = ''
    }
    if (phase === 'active') {
      this.patch({ active: true, exhausted: false, error: null })
    }
  }

  /**
   * 这条候选的发布身份（relay 时非空，direct 时为空串）。
   *
   * 服务端只在 relay 候选上带 publicationGeneration，缺了就是协议错，
   * 按直连处理会让观众静静等一个永远不来的房主 offer——所以宁可显式报错。
   */
  private relayOf(candidate: ShareCandidate | undefined): string {
    if (!candidate || candidate.transport !== 'relay') return ''
    if (!candidate.publicationGeneration) {
      this.patch({ error: 'share.viewer.error.protocol' })
      return ''
    }
    return candidate.publicationGeneration
  }

  /** 向服务器请求订阅（中继模式下唯一的一次主动请求）。 */
  private subscribe(connectionId: string): void {
    if (this.subscribedFor === connectionId) return
    this.subscribedFor = connectionId
    this.client.send({
      t: 'share.sfu-signal',
      roomId: this.options.roomId,
      revision: this.revision,
      publicationGeneration: this.publicationGeneration,
      connectionId,
      kind: 'subscribe',
    })
  }

  /** 中继侧的 description（offer）与候选。 */
  private handleSfuSignal(
    message: Extract<ShareServerMessage, { t: 'share.sfu-signal' }>
  ): void {
    if (!this.connectionId || message.connectionId !== this.connectionId) return
    if (message.kind === 'description') {
      const payload = message.payload as
        { description?: RTCSessionDescriptionInit } | undefined
      const description = payload?.description
      if (!description || description.type !== 'offer') return
      const peer = this.ensurePeer(this.connectionId)
      void peer.acceptOffer(this.connectionId, description)
      return
    }
    if (message.kind === 'candidate' && message.payload) {
      const peer = this.peer
      if (!peer) return
      void peer.acceptCandidate(
        this.connectionId,
        message.payload as RTCIceCandidateInit
      )
    }
  }

  /** 这条候选是不是发给自己的（单层拓扑下观众只有自己一条边）。 */
  private isMine(connectionId: string): boolean {
    if (this.connectionId === connectionId) return true
    const peer = this.peer
    return peer?.currentConnectionId === connectionId
  }

  private handleRelay(
    connectionId: string,
    kind: string,
    payload: unknown
  ): void {
    if (!this.connectionId || connectionId !== this.connectionId) return
    const peer = this.ensurePeer(connectionId)
    if (kind === 'offer') {
      void peer.acceptOffer(connectionId, payload as RTCSessionDescriptionInit)
      return
    }
    if (kind === 'candidate' && payload) {
      void peer.acceptCandidate(connectionId, payload as RTCIceCandidateInit)
    }
  }

  private ensurePeer(connectionId: string): ViewerPeer {
    if (this.peer && this.peer.currentConnectionId === connectionId)
      return this.peer
    this.peer?.dispose()
    const peer = new ViewerPeer({
      iceServers: this.options.iceServers,
      events: {
        sendSignal: (signal) => {
          if (this.relay) {
            // 中继：answer 与候选都走 sfu-signal，并带上发布代际。
            return this.client.send({
              t: 'share.sfu-signal',
              roomId: this.options.roomId,
              revision: this.revision,
              publicationGeneration: this.publicationGeneration,
              connectionId,
              kind: signal.kind === 'answer' ? 'description' : 'candidate',
              payload:
                signal.kind === 'answer'
                  ? { description: signal.description }
                  : signal.candidate,
            })
          }
          if (signal.kind === 'answer') {
            return this.client.send({
              t: 'share.signal',
              roomId: this.options.roomId,
              connectionId,
              kind: 'answer',
              payload: signal.description,
            })
          }
          return this.client.send({
            t: 'share.signal',
            roomId: this.options.roomId,
            connectionId,
            kind: 'candidate',
            payload: signal.candidate,
          })
        },
        requestRestart: (target, rebuild) => {
          const sent = this.client.send({
            t: 'share.restart',
            roomId: this.options.roomId,
            connectionId: target,
            rebuild,
          })
          if (sent) this.patch({ recovering: true })
          return sent
        },
        onStream: (stream) => {
          this.remoteStream = stream
          this.options.onStream?.(stream)
        },
        onUpdate: (snapshot) => {
          this.options.onPeerUpdate?.(snapshot)
          this.patch({ hasVideo: snapshot.hasVideo })
        },
        onConnected: (target) => {
          // 连上只是进度：服务端不据此提交路由（router.go:862-893）。
          this.client.send({
            t: 'share.transport-connected',
            roomId: this.options.roomId,
            revision: this.revision,
            connectionId: target,
          })
        },
        onFirstFrame: (target) => {
          // 首帧证明才是提交。
          this.client.send({
            t: 'share.route-ready',
            roomId: this.options.roomId,
            revision: this.revision,
            phase: 'prepare',
            connectionId: target,
          })
        },
        onRecoveryExhausted: () => {
          this.patch({
            recovering: false,
            exhausted: true,
            error: 'share.viewer.error.recoveryExhausted',
          })
        },
      },
    })
    this.peer = peer
    return peer
  }

  private teardownPeer(): void {
    this.subscribedFor = ''
    this.peer?.dispose()
    this.peer = null
    if (this.remoteStream) {
      // 故意不要求页面清 srcObject：观众该看到最后一帧，但要立刻知道「已经没有
      // 活的画面」——状态提示与统计都靠这个回调。
      this.remoteStream = null
      this.options.onStream?.(null)
    }
    this.connectionId = ''
    this.patch({ active: false, hasVideo: false, recovering: false })
  }

  private patch(partial: Partial<ViewerSessionState>): void {
    this.state = { ...this.state, ...partial }
    this.options.onStateChange?.({ ...this.state })
  }
}
