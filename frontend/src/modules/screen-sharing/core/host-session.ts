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
import { applyVideoCaptureProfile, captureDisplay } from './capture'
import { HostPeer, type HostPeerSnapshot } from './host-peer'
import { VP8_ONLY_VIDEO_CODEC } from './video-codec'
import { qualityNeedsCaptureUpdate, type QualityProfile } from './quality'
import { relayMediaDeclaration } from './relay-media'
import { ShareClient } from './share-client'

export interface HostSessionState {
  sharing: boolean
  paused: boolean
  /** 已建立发布端 PC 的数量（不是连上的数量）。 */
  peers: number
  /** 快照里的观众数（不含房主自己）。 */
  viewers: number
  /** 本代际是否走服务端中继（媒体经 SFU 转发，不再直连观众）。 */
  relay: boolean
  /**
   * 浏览器没有照办的编码参数（`maxBitrate` / `maxFramerate` /
   * `scaleResolutionDownBy` …）。`null` 表示全部按请求生效。
   *
   * 只上报「最新的那一条观众连接」的回读结果：同一份档位下发给所有发布端，
   * 浏览器对同一个 sender 的处理是一致的，逐条汇总只会让提示闪来闪去。
   */
  parameterOverride: string[] | null
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
  /** 中继发布身份：非空时房主只建这一条发布端 PC（观众不直连）。 */
  private publicationGeneration = ''
  /** 首个 description 要带上媒体声明；带上之后不再重复。 */
  private relayDeclared = false
  /** 最近一次已知的路由版本，中继信令要带上它。 */
  private revision = 0
  /**
   * 每条发布端 PC 属于哪位观众。
   *
   * connectionId 是服务端铸造的、每次重建都会变；只有 peerId 能回答
   * 「这个人还在不在会话里」。没有这张表就只能靠 assignment 判断，而
   * assignment 只收已提交的边——一条始终没连上的 PC 会永久留着空转编码。
   */
  private peerOwners = new Map<string, string>()
  private paused = false
  private unsubscribe: (() => void) | null = null
  private state: HostSessionState = {
    sharing: false,
    paused: false,
    peers: 0,
    viewers: 0,
    relay: false,
    parameterOverride: null,
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
    // 新的一代从「直连、无改写」起步：中继可用时服务端会再发 sfu-config
    // 把它抬上去；参数改写提示只对当前这一代有意义。
    this.publicationGeneration = ''
    this.relayDeclared = false
    this.patch({ relay: false, parameterOverride: null })
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
    // 中继模式下 sfu-config 可能比采集先到，这里补一次。
    this.ensurePublicationPeer(this.revision)
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
   * 改档位：分辨率或帧率变了要重下发采集约束。
   *
   * **帧率必须算作采集变更**（Piik `HostPage.tsx:1830-1832` 的 `captureChanged`）：
   * 采集阶段下发的 `frameRate: { max }` 是硬上限，开局按 30fps 采集之后，
   * 只改编码器的 `maxFramerate` 永远调不到 45/60——源本身就只有 30 帧。
   *
   * 约束先下发给**源采集轨**（设备只重配一次，本地预览也跟着变），再逐条
   * 通知发布端按新档位重算编码参数。
   *
   * 返回是否全部接受：源采集轨给不出该尺寸/帧率时调用方要把界面档位回滚。
   */
  async updateProfile(
    profile: QualityProfile,
    updateCapture: boolean
  ): Promise<boolean> {
    const previous = this.profile
    const captureChanged =
      updateCapture || qualityNeedsCaptureUpdate(previous, profile)
    this.profile = profile
    let ok = true
    if (captureChanged) {
      const source = this.sourceStream?.getVideoTracks()[0]
      if (source) {
        try {
          await applyVideoCaptureProfile(source, profile)
        } catch {
          // 约束被拒（浏览器给不出该档位）不是致命错误：编码参数仍是真正的
          // 上限，继续下发；ok=false 让调用方决定是否回滚界面档位。
          ok = false
        }
      }
    }
    for (const peer of this.peers.values()) {
      const applied = captureChanged
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
    this.publicationGeneration = ''
    this.relayDeclared = false
    this.patch({ relay: false, parameterOverride: null })
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
        this.revision = message.revision
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
        this.revision = message.revision
        this.handleRoute(message.revision, message.phase, message.candidate)
        return
      case 'share.sfu-config':
        // 服务端说「这一代走中继」：房主只建这一条发布端，不再等观众候选。
        this.publicationGeneration = message.publicationGeneration
        this.relayDeclared = false
        this.revision = message.revision
        this.patch({ relay: true })
        void this.ensurePublicationPeer(message.revision)
        return
      case 'share.sfu-signal':
        this.handlePublicationSignal(message)
        return
      case 'share.signal-relay':
        this.handleRelay(message.connectionId, message.kind, message.payload)
        return
      case 'share.status':
        if (message.state !== 'failed') return
        if (message.reason === 'relay-unreachable') {
          this.abortRelaySharing()
          return
        }
        this.options.onError?.(
          'share.host.error.routeExhausted',
          message.reason
        )
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
    // 中继模式下房主与观众之间没有边：画面只经 SFU 转发。这里若照着候选建
    // PC，就会多出一份编码和一条绕开 SFU 的上行（服务端已经不再下发，这条
    // 是兜底——旧服务端还会发）。
    if (this.publicationGeneration) return
    this.peerOwners.set(candidate.connectionId, candidate.childPeerId)
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
    // 中继模式下这条 PC 连的是 SFU 而不是观众：信令通道与失败处理都不同。
    const relay = connectionId === this.publicationGeneration
    const peer = new HostPeer({
      connectionId,
      iceServers: this.options.iceServers,
      stream: this.outputStream,
      profile: this.profile,
      // 中继强制 VP8：与媒体声明一致，也是 SFU 转发最稳的一路。
      ...(relay ? { videoCodec: VP8_ONLY_VIDEO_CODEC } : {}),
      events: {
        sendSignal: (signal) =>
          relay
            ? this.sendRelaySignal(connectionId, signal)
            : signal.kind === 'offer'
              ? this.client.send({
                  t: 'share.signal',
                  roomId: this.options.roomId,
                  connectionId,
                  kind: 'offer',
                  payload: signal.description,
                })
              : this.client.send({
                  t: 'share.signal',
                  roomId: this.options.roomId,
                  connectionId,
                  kind: 'candidate',
                  payload: signal.candidate,
                }),
        onUpdate: (snapshot) => {
          this.recordParameterOverride(snapshot)
          this.options.onPeerUpdate?.(snapshot)
        },
        onFailed: () => {
          this.dropPeer(connectionId)
          if (relay) {
            this.abortRelaySharing()
            return
          }
          // 终态失败：告诉服务端换候选。
          this.client.send({
            t: 'share.route-failed',
            roomId: this.options.roomId,
            revision,
            phase: 'prepare',
            connectionId,
          })
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

  /**
   * 中继模式下唯一一条发布端的信令出口。
   *
   * 首个 description 必须带媒体声明：SFU 要先按声明建发布资源才肯收 offer；
   * 之后的协商（换源导致的方向变化）不再重复声明。
   */
  private sendRelaySignal(
    connectionId: string,
    signal:
      | { kind: 'offer'; description: RTCSessionDescriptionInit }
      | { kind: 'candidate'; candidate: RTCIceCandidateInit }
  ): boolean {
    if (signal.kind === 'offer') {
      const payload: {
        description: RTCSessionDescriptionInit
        media?: ReturnType<typeof relayMediaDeclaration>
      } = { description: signal.description }
      if (!this.relayDeclared && this.profile) {
        payload.media = relayMediaDeclaration(this.profile, {
          codec: VP8_ONLY_VIDEO_CODEC.primary,
          audio: (this.outputStream?.getAudioTracks().length ?? 0) > 0,
        })
        this.relayDeclared = true
      }
      return this.client.send({
        t: 'share.sfu-signal',
        roomId: this.options.roomId,
        revision: this.revision,
        publicationGeneration: connectionId,
        connectionId,
        kind: 'description',
        payload,
      })
    }
    return this.client.send({
      t: 'share.sfu-signal',
      roomId: this.options.roomId,
      revision: this.revision,
      publicationGeneration: connectionId,
      connectionId,
      kind: 'candidate',
      payload: signal.candidate,
    })
  }

  /** 采集就绪后才建发布端：config 可能比采集先到。 */
  private ensurePublicationPeer(revision: number): void {
    if (!this.publicationGeneration) return
    if (!this.outputStream || !this.profile) return
    if (this.peers.has(this.publicationGeneration)) return
    void this.createPeer(this.publicationGeneration, revision)
  }

  /**
   * 发布端（房主 ↔ SFU）终态失败：这一代共享已经没人能收到画面。
   *
   * 不做自动重建——SFU 侧的发布在它自己发现连接失败时就退役了，拿同一个
   * 发布代际重发 offer 只会被静默丢弃。正确做法是收掉这一代，让用户重新
   * 开始共享（重新 start 会铸全新的代际与发布身份）。
   */
  private abortRelaySharing(): void {
    if (!this.state.sharing) return
    this.stop()
    this.patch({ error: 'share.host.error.relay' })
  }

  /** 服务器/中继侧回来的 answer 与候选。 */
  private handlePublicationSignal(
    message: Extract<ShareServerMessage, { t: 'share.sfu-signal' }>
  ): void {
    if (!this.publicationGeneration) return
    if (message.connectionId !== this.publicationGeneration) return
    const peer = this.peers.get(this.publicationGeneration)
    if (!peer) return
    if (message.kind === 'description') {
      const payload = message.payload as
        { description?: RTCSessionDescriptionInit } | undefined
      if (payload?.description?.type === 'answer') {
        void peer.acceptAnswer(payload.description)
      }
      return
    }
    if (message.kind === 'candidate' && message.payload) {
      void peer.acceptCandidate(message.payload as RTCIceCandidateInit)
    }
  }

  /**
   * 记录浏览器对编码参数的实际处理结果。
   *
   * `setParameters` 只是「请求」，浏览器可以按自己的策略改小码率、钉住帧率、
   * 甚至忽略降采样。不回读就等于默认一切照办——用户看到的档位和实际发出去
   * 的画面会不一致，而界面上没有任何提示。
   */
  private recordParameterOverride(snapshot: HostPeerSnapshot): void {
    const mismatches = snapshot.senderParameters?.mismatches
    if (!mismatches) return
    const next = mismatches.length > 0 ? [...mismatches] : null
    const current = this.state.parameterOverride
    const same =
      current === null
        ? next === null
        : next !== null &&
          current.length === next.length &&
          current.every((key, index) => key === next[index])
    if (same) return
    this.patch({ parameterOverride: next })
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
    const present = new Set(
      snapshot.participants.map((participant) => participant.peerId)
    )
    for (const connectionId of [...this.peers.keys()]) {
      // 发布端不属于「观众的边」，它的存活由 sfu-config 与失败事件决定。
      if (connectionId === this.publicationGeneration) continue
      // 观众已经不在会话里：不管这条边提交没提交，PC 都必须销毁。
      const owner = this.peerOwners.get(connectionId)
      if (owner !== undefined && !present.has(owner)) {
        this.dropPeer(connectionId)
        continue
      }
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
    this.peerOwners.delete(connectionId)
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
