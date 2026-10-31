/**
 * 房主共享会话。
 *
 * 负责把「控制面（share 事件）」「采集」「每条观众的发布端」三块接起来：
 *
 *  - `share.start` 之后等服务端下发 `share.route`（每个观众一条），
 *    对每条候选建一个 `HostPeer` 并发出 offer；
 *  - 观众回 `answer` / `candidate` 经服务端中继回来，分派到对应连接；
 *  - 快照里消失的连接立刻销毁，不做「等超时」。
 *
 * 与 Piik 的差别只有一处：Piik 的房主还要维护观众互助的子树（
 * `host-provisional-child.ts`），ZViewer 只做单层，所以这里是扁平的一对多。
 */
import type { Socket } from 'socket.io-client'
import type {
  ShareServerMessage,
  ShareSnapshotMessage,
} from '../protocol/types'
import { HostAudio, type CommentaryInput } from './audio-mix'
import { captureDisplay } from './capture'
import { HostPeer, type HostPeerSnapshot } from './host-peer'
import type { QualityProfile } from './quality'
import { ShareClient } from './share-client'

export interface HostSessionState {
  sharing: boolean
  paused: boolean
  /** 已建立发布端 PC 的数量（不是连上的数量）。 */
  peers: number
  /** 快照里的观众数（不含房主自己）。 */
  viewers: number
  audioAvailable: boolean
  microphoneEnabled: boolean
  /** 语义错误码，不是展示文案。 */
  error: string | null
}

export interface HostSessionOptions {
  socket: Socket
  roomId: string
  iceServers: RTCIceServer[]
  onStateChange?: (state: HostSessionState) => void
  onSnapshot?: (snapshot: ShareSnapshotMessage) => void
  onError?: (code: string, message: string) => void
  onPeerUpdate?: (snapshot: HostPeerSnapshot) => void
}

export interface HostStartOptions {
  profile: QualityProfile
  /** 采集到的原始流（不含麦克风混音）。 */
  stream?: MediaStream
  /** 复用已有的采集流；不传则内部调 getDisplayMedia。 */
  shareSystemAudio?: boolean
}

export class ShareHostSession {
  private readonly options: HostSessionOptions
  private readonly client: ShareClient
  private readonly peers = new Map<string, HostPeer>()

  private audio: HostAudio | null = null
  private sourceStream: MediaStream | null = null
  private outputStream: MediaStream | null = null
  private profile: QualityProfile | null = null
  private shareGeneration = ''
  private paused = false
  private unsubscribe: (() => void) | null = null
  private state: HostSessionState = {
    sharing: false,
    paused: false,
    peers: 0,
    viewers: 0,
    audioAvailable: false,
    microphoneEnabled: false,
    error: null,
  }

  constructor(options: HostSessionOptions) {
    this.options = options
    this.client = new ShareClient(options.socket, options.roomId)
    this.unsubscribe = this.client.subscribe((message) =>
      this.onMessage(message)
    )
  }

  get previewStream(): MediaStream | null {
    return this.outputStream
  }

  get roomId(): string {
    return this.options.roomId
  }

  /** 当前共享代际（切源/恢复时要带上它）。 */
  get generation(): string {
    return this.shareGeneration
  }

  /**
   * 用于统计面板的连接：取第一条发布端。
   *
   * 单层拓扑下每条边的内容完全一致，取哪一条对读数没有影响；面板一次只能
   * 展示一条，所以固定取第一条（Map 保持插入顺序）。
   */
  statsConnection(): RTCPeerConnection | null {
    for (const peer of this.peers.values()) return peer.getConnection()
    return null
  }

  /** 进会话：注册参与者，取回快照。 */
  hello(): void {
    this.client.hello(this.shareGeneration || undefined)
  }

  /**
   * 开始共享。
   *
   * 顺序不能换：先拿到采集流（用户可能拒绝授权），再混音，最后才通知服务端。
   * 反过来会先广播「开始共享」，然后采集失败，观众端白等一整个超时窗口。
   */
  async start(options: HostStartOptions): Promise<boolean> {
    if (this.state.sharing) return true
    this.profile = options.profile
    try {
      const source =
        options.stream ??
        (await captureDisplay(options.profile, {
          systemAudio: options.shareSystemAudio ?? true,
        }))
      if (options.shareSystemAudio === false) {
        // 外部传入的流可能自带系统声：选择不共享声音时先摘掉音轨，再交给
        // 混音器——`HostAudio` 只在音轨存在时才建图，不会留下空节点。
        for (const track of source.getAudioTracks()) {
          track.stop()
          source.removeTrack(track)
        }
      }
      this.sourceStream = source
      const audio = new HostAudio(
        source,
        (available) => this.patch({ audioAvailable: available }),
        (enabled) => this.patch({ microphoneEnabled: enabled })
      )
      this.audio = audio
      this.outputStream = await audio.start()
    } catch (error) {
      this.patch({
        error:
          error instanceof Error &&
          error.message === 'unsupported capture profile'
            ? 'share.host.error.unsupportedProfile'
            : 'share.host.error.capture',
      })
      this.releaseMedia()
      return false
    }

    this.patch({ sharing: true, paused: false, error: null })
    const started = this.client.send({
      t: 'share.start',
      roomId: this.options.roomId,
      ...(this.shareGeneration
        ? { shareGeneration: this.shareGeneration }
        : {}),
      paused: false,
      qualitySettings: toWireQuality(options.profile),
    })
    if (!started) {
      this.patch({ sharing: false, error: 'share.host.error.disconnected' })
      this.releaseMedia()
      return false
    }
    return true
  }

  /** 暂停/恢复。只关轨道开关，不重协商，也不清观众画面。 */
  setPaused(paused: boolean): void {
    if (!this.state.sharing || this.paused === paused) return
    this.paused = paused
    if (this.outputStream) {
      for (const track of this.outputStream.getTracks()) {
        // 音轨属于混音输出，暂停时只关视频：观众要能听到「暂停中」的状态声，
        // 与 Piik 一致（pause 只停画面，保留最后一帧）。
        if (track.kind === 'video') track.enabled = !paused
      }
    }
    for (const peer of this.peers.values()) peer.setPaused(paused)
    this.patch({ paused })
    this.client.send({
      t: 'share.pause',
      roomId: this.options.roomId,
      shareGeneration: this.shareGeneration,
      paused,
    })
  }

  /**
   * 换采集源（切窗口/切屏幕）。
   *
   * 复用同一个混杂图与同一批 sender：`replaceTrack` 不触发重协商，
   * 观众端无感，只有音频方向变化才会发新 offer。
   */
  async switchSource(stream: MediaStream): Promise<boolean> {
    if (!this.audio) return false
    const previous = this.sourceStream
    this.sourceStream = stream
    this.outputStream = this.audio.attach(stream)
    if (previous && previous !== stream) {
      previous.getTracks().forEach((track) => track.stop())
    }
    let ok = true
    for (const peer of this.peers.values()) {
      if (!(await peer.replaceStream(this.outputStream))) ok = false
    }
    return ok
  }

  /**
   * 改档位：`updateCapture` 为 true 时同时重下发采集约束（切分辨率）。
   *
   * 返回是否全部发布端都接受：切分辨率失败（浏览器给不出该尺寸）时调用方要
   * 把界面上的档位回滚，否则显示的档位和实际画面不一致。
   */
  async updateProfile(
    profile: QualityProfile,
    updateCapture: boolean
  ): Promise<boolean> {
    this.profile = profile
    let ok = true
    for (const peer of this.peers.values()) {
      const applied = updateCapture
        ? await peer.updateCaptureProfile(profile)
        : await peer.updateProfile(profile)
      if (!applied) ok = false
    }
    return ok
  }

  /** 开/关麦克风。混进同一条输出音轨，不新增轨道、不重协商。 */
  async setMicrophone(
    enabled: boolean,
    settings: CommentaryInput
  ): Promise<void> {
    if (!this.audio) return
    await this.audio.setMicrophone(enabled, settings)
  }

  /** 结束共享并释放全部资源。 */
  stop(): void {
    if (this.state.sharing) {
      this.client.send({
        t: 'share.stop',
        roomId: this.options.roomId,
        shareGeneration: this.shareGeneration,
      })
    }
    this.patch({ sharing: false, paused: false, peers: 0, viewers: 0 })
    this.paused = false
    this.shareGeneration = ''
    this.releaseMedia()
  }

  dispose(): void {
    this.stop()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.client.dispose()
  }

  // ==================== 内部 ====================

  private onMessage(message: ShareServerMessage): void {
    switch (message.t) {
      case 'share.snapshot':
        this.shareGeneration = message.shareGeneration
        this.paused = message.paused
        this.options.onSnapshot?.(message)
        this.patch({
          viewers: message.participants.filter(
            (participant) => participant.role === 'viewer'
          ).length,
        })
        this.syncPeers(message)
        return
      case 'share.route':
        this.handleRoute(message.revision, message.phase, message.candidate)
        return
      case 'share.signal-relay':
        this.handleRelay(message.connectionId, message.kind, message.payload)
        return
      case 'share.status':
        if (message.state === 'failed') {
          this.options.onError?.(
            'share.host.error.routeExhausted',
            message.reason
          )
        }
        return
      case 'share.error':
        this.options.onError?.(message.code, message.message)
        return
      default:
        return
    }
  }

  private handleRoute(
    revision: number,
    phase: string,
    candidate: { childPeerId: string; connectionId: string } | undefined
  ): void {
    if (!candidate) return
    const existing = this.peers.get(candidate.connectionId)
    if (phase !== 'prepare') {
      // active 只说明观众已解出首帧，房主这边没有额外动作。
      return
    }
    if (existing) {
      // 同一个 connectionId 再来一次 prepare = 观众请求恢复。
      if (existing.isConnected()) {
        void existing.restartIce()
      } else {
        // 还没连上就又要恢复，说明这条 PC 已经僵了，重建更省时间。
        this.dropPeer(candidate.connectionId)
        void this.createPeer(candidate.connectionId, revision)
      }
      return
    }
    void this.createPeer(candidate.connectionId, revision)
  }

  private async createPeer(
    connectionId: string,
    revision: number
  ): Promise<void> {
    if (!this.outputStream || !this.profile) return
    if (this.peers.has(connectionId)) return
    const peer = new HostPeer({
      connectionId,
      iceServers: this.options.iceServers,
      stream: this.outputStream,
      profile: this.profile,
      events: {
        sendSignal: (signal) => {
          if (signal.kind === 'offer') {
            return this.client.send({
              t: 'share.signal',
              roomId: this.options.roomId,
              connectionId,
              kind: 'offer',
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
        onUpdate: (snapshot) => this.options.onPeerUpdate?.(snapshot),
        onFailed: () => {
          // 终态失败：告诉服务端换候选，再销毁这条 PC。
          this.client.send({
            t: 'share.route-failed',
            roomId: this.options.roomId,
            revision,
            phase: 'prepare',
            connectionId,
          })
          this.dropPeer(connectionId)
        },
      },
    })
    this.peers.set(connectionId, peer)
    this.patch({ peers: this.peers.size })
    peer.setPaused(this.paused)
    if (!(await peer.start())) {
      this.dropPeer(connectionId)
    }
  }

  private handleRelay(
    connectionId: string,
    kind: string,
    payload: unknown
  ): void {
    const peer = this.peers.get(connectionId)
    if (!peer) return
    if (kind === 'answer') {
      void peer.acceptAnswer(payload as RTCSessionDescriptionInit)
      return
    }
    if (kind === 'candidate' && payload) {
      void peer.acceptCandidate(payload as RTCIceCandidateInit)
    }
  }

  /** 按快照里的已提交分配，砍掉不该存在的连接。 */
  private syncPeers(snapshot: ShareSnapshotMessage): void {
    if (!snapshot.sharing) {
      for (const connectionId of [...this.peers.keys()]) {
        this.dropPeer(connectionId)
      }
      if (this.state.sharing) {
        // 服务端说共享已结束（房主在别的标签页点了停止），本地跟着收尾。
        this.patch({ sharing: false, peers: 0, viewers: 0 })
        this.releaseMedia()
      }
      return
    }
    const assigned = new Set(
      snapshot.assignment?.candidates.map(
        (candidate) => candidate.connectionId
      ) ?? []
    )
    for (const connectionId of [...this.peers.keys()]) {
      // 快照里没有对应候选的边一律销毁：观众已经离开，PC 留着只是空转编码。
      if (!assigned.has(connectionId)) {
        const peer = this.peers.get(connectionId)
        // 还没提交的边（prepare 阶段）不在 assignment 里，不能误杀。
        if (peer && !peer.isConnected()) continue
        this.dropPeer(connectionId)
      }
    }
  }

  private dropPeer(connectionId: string): void {
    const peer = this.peers.get(connectionId)
    if (!peer) return
    peer.dispose()
    this.peers.delete(connectionId)
    this.patch({ peers: this.peers.size })
  }

  private releaseMedia(): void {
    for (const connectionId of [...this.peers.keys()])
      this.dropPeer(connectionId)
    this.audio?.dispose()
    this.audio = null
    this.sourceStream?.getTracks().forEach((track) => track.stop())
    this.sourceStream = null
    this.outputStream = null
    this.patch({ audioAvailable: false, microphoneEnabled: false })
  }

  private patch(partial: Partial<HostSessionState>): void {
    this.state = { ...this.state, ...partial }
    this.options.onStateChange?.({ ...this.state })
  }
}

/** 前端档位 → 线上快照里的档位（服务端只回显，不据此施加约束）。 */
export function toWireQuality(profile: QualityProfile): {
  resolutionPreset: string
  frameRate: number
  maxBitrateMbps: number
} {
  const resolution = profile.resolution
  const preset = resolution
    ? `${resolution.width}x${resolution.height}`
    : 'native'
  return {
    resolutionPreset: preset,
    frameRate: profile.maxFramerate,
    maxBitrateMbps: profile.maxBitrate / 1_000_000,
  }
}
