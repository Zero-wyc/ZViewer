/**
 * 观众侧接收端连接。
 *
 * 与房主侧的分工是**不对称**的（Piik `viewer-peer.ts` 的结构）：
 * 房主永远发 offer，观众只 `createAnswer`。所以这里没有纪元/glare 逻辑，
 * 只有一条 `descriptionTail` 串行队列——两个 offer 并发进来时，第二个
 * `setRemoteDescription` 会因为 `have-remote-offer` 状态直接抛错。
 *
 * 三个常量是有代价的，不要随手调：
 *  - 首连 15s 没连上就判定失败（不连就是错，不能无限转圈）；
 *  - `disconnected` 不是立刻恢复，等 3s——网络抖动自己会回来；
 *  - 自动恢复总预算 2 次，第 2 次带 `rebuild` 走销毁重建而不是 ICE restart。
 */
import { waitForConnectionOperation } from './connection-op'
import { observeDecodedFrameProof } from './frame-proof'

export const VIEWER_MAX_PENDING_CANDIDATES = 64
export const VIEWER_MAX_AUTOMATIC_RECOVERY_REQUESTS = 2
export const VIEWER_INITIAL_CONNECTION_TIMEOUT_MS = 15_000
export const VIEWER_AUTOMATIC_RECOVERY_TIMEOUT_MS = 3_000
/** `disconnected` 到开始恢复之间的静置时间。 */
export const VIEWER_DISCONNECT_GRACE_MS = 3_000

export type ViewerSignal =
  | { kind: 'answer'; description: RTCSessionDescriptionInit }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit }

export interface ViewerPeerSnapshot {
  connectionId: string
  connectionState: RTCPeerConnectionState
  iceConnectionState: RTCIceConnectionState
  /** 语义错误码。 */
  error: string | null
  hasVideo: boolean
}

export interface ViewerPeerEvents {
  sendSignal: (signal: ViewerSignal) => boolean
  /** 请求房主恢复；`rebuild=true` 表示拆了重建。 */
  requestRestart: (connectionId: string, rebuild: boolean) => boolean
  onStream: (stream: MediaStream) => void
  onUpdate: (snapshot: ViewerPeerSnapshot) => void
  /** 已解出首帧（路由提交的唯一依据）。 */
  onFirstFrame: (connectionId: string) => void
  /** 传输层连上（只是进度，不提交路由）。 */
  onConnected: (connectionId: string) => void
  /** 自动恢复预算耗尽，UI 该给重试按钮了。 */
  onRecoveryExhausted: (connectionId: string) => void
}

export interface ViewerPeerOptions {
  iceServers: RTCIceServer[]
  events: ViewerPeerEvents
}

export class ViewerPeer {
  private connection: RTCPeerConnection | null = null
  private connectionId: string | null = null
  private readonly remoteStream = new MediaStream()
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>()
  private readonly events: ViewerPeerEvents
  private iceServers: RTCIceServer[]

  private lifetime: AbortController | null = null
  private descriptionTail: Promise<void> = Promise.resolve()
  private stopFrameProof: (() => void) | null = null

  private disconnectTimer: ReturnType<typeof setTimeout> | null = null
  private initialConnectionTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryRequests = 0
  private recoveryExhausted = false

  private disposed = false
  private snapshot: ViewerPeerSnapshot | null = null

  constructor(options: ViewerPeerOptions) {
    this.events = options.events
    this.iceServers = options.iceServers
  }

  get currentConnectionId(): string | null {
    return this.connectionId
  }

  isConnected(): boolean {
    return this.connection?.connectionState === 'connected'
  }

  isRecovering(): boolean {
    return this.recoveryTimer !== null
  }

  hasConnection(): boolean {
    return this.connection !== null
  }

  getSnapshot(): ViewerPeerSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null
  }

  /** 换 ICE 配置（ICE 服务器列表由房间设置给出，可能中途变）。 */
  updateIceServers(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers
    if (!this.connection) return
    try {
      this.connection.setConfiguration({ iceServers })
    } catch {
      this.setError('share.viewer.error.connection')
    }
  }

  /** 处理房主发来的 offer。 */
  acceptOffer(
    connectionId: string,
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    if (this.disposed || description.type !== 'offer') return Promise.resolve()
    if (!this.connection || this.connectionId !== connectionId) {
      try {
        this.replaceConnection(connectionId)
      } catch {
        this.setError('share.viewer.error.connection')
        return Promise.resolve()
      }
    }
    return this.enqueueDescription(() =>
      this.acceptOfferOwned(connectionId, description)
    )
  }

  /** 处理房主的候选。没有远端描述时先缓存（此时 addIceCandidate 必然抛错）。 */
  acceptCandidate(
    connectionId: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (
      !this.connection ||
      this.connectionId !== connectionId ||
      !this.connection.remoteDescription
    ) {
      this.queueCandidate(connectionId, candidate)
      return Promise.resolve()
    }
    const connection = this.connection
    return this.waitForOperation(() =>
      connection.addIceCandidate(candidate)
    ).catch(() => {
      if (this.isCurrent(connectionId))
        this.setError('share.viewer.error.candidate')
    })
  }

  /** 用户手动重试（恢复预算已耗尽时由 UI 调用）。 */
  requestRecovery(rebuild = false): boolean {
    if (!this.connectionId || this.disposed || this.recoveryTimer !== null)
      return false
    const sent = this.events.requestRestart(this.connectionId, rebuild)
    if (sent) {
      this.clearInitialConnectionTimer()
      this.recoveryExhausted = false
      this.recoveryRequests = Math.max(
        this.recoveryRequests,
        rebuild ? VIEWER_MAX_AUTOMATIC_RECOVERY_REQUESTS : 1
      )
      this.scheduleRecoveryDeadline()
    }
    return sent
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeConnection()
    this.pendingCandidates.clear()
  }

  // ==================== 内部 ====================

  private replaceConnection(connectionId: string): void {
    this.disposeConnection()
    this.connectionId = connectionId
    this.descriptionTail = Promise.resolve()
    this.recoveryRequests = 0
    this.recoveryExhausted = false
    const lifetime = new AbortController()
    this.lifetime = lifetime
    const connection = new RTCPeerConnection({ iceServers: this.iceServers })
    this.connection = connection
    this.snapshot = {
      connectionId,
      connectionState: connection.connectionState,
      iceConnectionState: connection.iceConnectionState,
      error: null,
      hasVideo: false,
    }

    connection.addEventListener('icecandidate', (event) => {
      if (this.connection !== connection) return
      // 线上格式不接受 payload=null，收集结束不需要单独通知。
      if (!event.candidate) return
      this.events.sendSignal({
        kind: 'candidate',
        candidate: event.candidate.toJSON(),
      })
    })
    connection.addEventListener('track', (event) => {
      if (this.connection !== connection) return
      // 音频与视频可能挂在不同的 stream 对象上：统一收进一条自有流，
      // 避免迟到的音轨把已经挂上的画面顶掉。
      if (!this.remoteStream.getTrackById(event.track.id)) {
        this.remoteStream.addTrack(event.track)
      }
      this.snapshot = {
        ...this.snapshot!,
        hasVideo: this.remoteStream.getVideoTracks().length > 0,
      }
      this.events.onStream(this.remoteStream)
      this.emit()
    })
    connection.addEventListener('connectionstatechange', () => {
      if (this.connection !== connection) return
      this.handleConnectionState(connection.connectionState)
      this.emit()
    })
    connection.addEventListener('iceconnectionstatechange', () => {
      if (this.connection === connection) this.emit()
    })

    this.stopFrameProof = observeDecodedFrameProof({
      readFramesDecoded: async () => {
        const report = await this.waitForOperation(() => connection.getStats())
        const track = this.remoteStream.getVideoTracks()[0]
        let frames: number | null = null
        report.forEach((entry) => {
          const stat = entry as RTCStats & {
            type: string
            kind?: string
            trackIdentifier?: string
            framesDecoded?: number
          }
          if (stat.type !== 'inbound-rtp' || stat.kind !== 'video') return
          if (
            track &&
            stat.trackIdentifier &&
            stat.trackIdentifier !== track.id
          )
            return
          if (typeof stat.framesDecoded === 'number') {
            frames = Math.max(frames ?? 0, stat.framesDecoded)
          }
        })
        return frames
      },
      owns: () => this.isCurrent(connectionId) && !this.disposed,
      onProof: () => {
        this.events.onFirstFrame(connectionId)
        return true
      },
    })
    this.emit()
  }

  private async acceptOfferOwned(
    connectionId: string,
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    const connection = this.connection
    if (!connection || this.connectionId !== connectionId) return
    try {
      await this.waitForOperation(() =>
        connection.setRemoteDescription(description)
      )
      if (!this.isCurrent(connectionId)) return
      await this.flushCandidates(connection, connectionId)
      if (!this.isCurrent(connectionId)) return
      const answer = await this.waitForOperation(() =>
        connection.createAnswer()
      )
      if (!this.isCurrent(connectionId)) return
      await this.waitForOperation(() => connection.setLocalDescription(answer))
      if (!this.isCurrent(connectionId) || !connection.localDescription) return
      if (
        !this.events.sendSignal({
          kind: 'answer',
          description: { type: 'answer', sdp: connection.localDescription.sdp },
        })
      ) {
        throw new Error('signal send rejected')
      }
      this.snapshot = { ...this.snapshot!, error: null }
      this.clearRecoveryTimer()
      this.scheduleInitialConnectionDeadline(connectionId)
      this.emit()
    } catch {
      if (!this.isCurrent(connectionId)) return
      this.setError('share.viewer.error.negotation')
      this.failOffer(connectionId)
    }
  }

  /** offer 处理失败：直接重建一次，重建也失败就报恢复耗尽。 */
  private failOffer(connectionId: string): void {
    if (
      this.recoveryExhausted ||
      this.recoveryRequests >= VIEWER_MAX_AUTOMATIC_RECOVERY_REQUESTS ||
      !this.events.requestRestart(connectionId, true)
    ) {
      this.reportRecoveryExhausted()
      return
    }
    this.recoveryRequests = VIEWER_MAX_AUTOMATIC_RECOVERY_REQUESTS
    this.scheduleRecoveryDeadline()
  }

  private handleConnectionState(state: RTCPeerConnectionState): void {
    if (state === 'connected') {
      this.clearDisconnectTimer()
      this.clearInitialConnectionTimer()
      this.resetAutomaticRecovery()
      if (this.connectionId) this.events.onConnected(this.connectionId)
      return
    }
    if (state === 'failed') {
      this.clearDisconnectTimer()
      this.attemptAutomaticRecovery()
      return
    }
    if (state === 'disconnected' && this.disconnectTimer === null) {
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null
        if (this.connection?.connectionState === 'disconnected') {
          this.attemptAutomaticRecovery()
        }
      }, VIEWER_DISCONNECT_GRACE_MS)
    }
  }

  private attemptAutomaticRecovery(): void {
    this.clearInitialConnectionTimer()
    if (
      this.disposed ||
      this.recoveryTimer !== null ||
      this.recoveryExhausted ||
      this.connection?.connectionState === 'connected' ||
      !this.connectionId
    ) {
      return
    }
    if (this.recoveryRequests >= VIEWER_MAX_AUTOMATIC_RECOVERY_REQUESTS) {
      this.reportRecoveryExhausted()
      return
    }
    // 第二次恢复改成销毁重建：同一个 PC 上第二次 ICE restart 的失败率明显更高。
    const rebuild = this.recoveryRequests > 0
    if (!this.events.requestRestart(this.connectionId, rebuild)) {
      this.reportRecoveryExhausted()
      return
    }
    this.recoveryRequests += 1
    this.scheduleRecoveryDeadline()
  }

  private scheduleInitialConnectionDeadline(connectionId: string): void {
    if (!this.isCurrent(connectionId)) return
    this.clearInitialConnectionTimer()
    if (this.connection?.connectionState === 'connected') return
    const timer = setTimeout(() => {
      if (this.initialConnectionTimer !== timer) return
      this.initialConnectionTimer = null
      if (
        this.isCurrent(connectionId) &&
        this.connection?.connectionState !== 'connected'
      ) {
        this.attemptAutomaticRecovery()
      }
    }, VIEWER_INITIAL_CONNECTION_TIMEOUT_MS)
    this.initialConnectionTimer = timer
  }

  private scheduleRecoveryDeadline(): void {
    this.clearRecoveryTimer()
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      if (this.connection?.connectionState !== 'connected') {
        this.attemptAutomaticRecovery()
      }
      this.emit()
    }, VIEWER_AUTOMATIC_RECOVERY_TIMEOUT_MS)
  }

  private reportRecoveryExhausted(): void {
    if (this.recoveryExhausted || !this.connectionId) return
    this.clearRecoveryTimer()
    this.recoveryExhausted = true
    this.events.onRecoveryExhausted(this.connectionId)
  }

  private resetAutomaticRecovery(): void {
    this.clearRecoveryTimer()
    this.recoveryRequests = 0
    this.recoveryExhausted = false
  }

  private queueCandidate(
    connectionId: string,
    candidate: RTCIceCandidateInit
  ): void {
    const list = this.pendingCandidates.get(connectionId) ?? []
    if (list.length >= VIEWER_MAX_PENDING_CANDIDATES) return
    list.push(candidate)
    this.pendingCandidates.set(connectionId, list)
  }

  private async flushCandidates(
    connection: RTCPeerConnection,
    connectionId: string
  ): Promise<void> {
    const candidates = this.pendingCandidates.get(connectionId) ?? []
    this.pendingCandidates.delete(connectionId)
    for (const candidate of candidates) {
      await this.waitForOperation(() => connection.addIceCandidate(candidate))
    }
  }

  private enqueueDescription(work: () => Promise<void>): Promise<void> {
    const result = this.descriptionTail.then(work, work)
    this.descriptionTail = result.catch(() => undefined)
    return result
  }

  private waitForOperation<T>(operation: () => Promise<T>): Promise<T> {
    const lifetime = this.lifetime
    if (!lifetime) return Promise.reject(new Error('connection disposed'))
    return waitForConnectionOperation(lifetime.signal, operation)
  }

  private isCurrent(connectionId: string): boolean {
    return (
      !this.disposed &&
      this.connection !== null &&
      this.connectionId === connectionId
    )
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) clearTimeout(this.disconnectTimer)
    this.disconnectTimer = null
  }

  private clearInitialConnectionTimer(): void {
    if (this.initialConnectionTimer !== null)
      clearTimeout(this.initialConnectionTimer)
    this.initialConnectionTimer = null
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
  }

  private disposeConnection(): void {
    this.stopFrameProof?.()
    this.stopFrameProof = null
    this.clearDisconnectTimer()
    this.clearInitialConnectionTimer()
    this.clearRecoveryTimer()
    this.lifetime?.abort()
    this.lifetime = null
    if (this.connection) {
      this.connection.close()
      this.connection = null
    }
    this.connectionId = null
    // 远端轨必须停掉，否则换了连接后旧轨还挂在 video 元素上。
    for (const track of this.remoteStream.getTracks()) {
      this.remoteStream.removeTrack(track)
      track.stop()
    }
  }

  private setError(code: string): void {
    if (!this.snapshot) return
    this.snapshot = { ...this.snapshot, error: code }
    this.emit()
  }

  private emit(): void {
    if (this.disposed || !this.snapshot || !this.connection) return
    this.snapshot = {
      ...this.snapshot,
      connectionState: this.connection.connectionState,
      iceConnectionState: this.connection.iceConnectionState,
    }
    this.events.onUpdate({ ...this.snapshot })
  }
}
