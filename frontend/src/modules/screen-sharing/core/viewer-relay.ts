/**
 * 观众侧转发（观众当父节点）。
 *
 * 树形拓扑里，一位观众收到画面之后可以再转发给下游——Piik 的
 * `webrtc/viewer-relay.ts` + `sfu/publisher.ts` 做的是同一件事。ZViewer 走的是
 * 更省事的复用路径：**直接用 `HostPeer` 当转发发布端**，把「收到的远端流」
 * 当成采集源喂进去。协议、协商纪律、sender 参数回读、统计全部沿用，不用维护
 * 第二套发布实现。
 *
 * 三条必须守住的边界：
 *
 *  1. **源到了才能发 offer**。上游还没解出首帧时 `remoteStream` 里没有视频轨，
 *     `HostPeer.start()` 会以「没有源」失败。所以这里排队等源，源到位再启动。
 *  2. **每一代只认自己的孩子**。服务端每次重挂都会铸新的 connectionId；同一个
 *     childPeerId 换了 id 就说明旧的那条边作废，必须先拆旧的再建新的，否则
 *     一头观众会同时收到两路画面。
 *  3. **失败要上报**。转发端的 PC 挂了，服务端要能在这一条边上换上游——它认
 *     任何一端上报的 route-failed。
 *
 * 代价说明：这一跳是**解码再编码**（浏览器没有跨 PC 的编码帧转发），所以画质
 * 会有一次代际损失、CPU 也有一次编码开销。档位因此固定成一个保守值，不跟随
 * 房主的档位——下游的清晰度上限是转发者的机器，不是房主的设置。
 */
import { HostPeer } from './host-peer'
import { DEFAULT_AUDIO_BITRATE, type QualityProfile } from './quality'
import type { BrowserVideoCodecPreference } from './video-codec'

/**
 * 转发档位。
 *
 * 不跟随房主档位：一位 4K60 的房主下面，转发者的浏览器要同时解码 4K60 和
 * 编码下游，很容易把自己拖垮。1080p30 / 6Mbps 是「笔记本软编也能扛」的线。
 */
export const RELAY_QUALITY_PROFILE: QualityProfile = {
  resolution: { width: 1920, height: 1080 },
  maxFramerate: 30,
  maxBitrate: 6_000_000,
  degradationPreference: 'balanced',
  maxAudioBitrate: DEFAULT_AUDIO_BITRATE,
}

export interface ViewerRelayOptions {
  iceServers: RTCIceServer[]
  /**
   * 我自己的 peerId。
   *
   * 只用于「这条边还是不是我的」这一个判断：快照的分配表里写着
   * `parentPeerId`，它等于我才是我的下游。
   */
  selfPeerId?: string
  natPredictionStunUrls?: readonly string[]
  videoCodec?: BrowserVideoCodecPreference
  /** 把一条信号发回服务端（由会话按 share.signal 发出）。 */
  sendSignal: (
    connectionId: string,
    signal:
      | { kind: 'offer'; description: RTCSessionDescriptionInit }
      | { kind: 'candidate'; candidate: RTCIceCandidateInit }
  ) => boolean
  /** 这条转发边彻底失败，会话据此上报 route-failed。 */
  onFailed: (connectionId: string) => void
}

interface RelayEdge {
  connectionId: string
  childPeerId: string
  /**
   * 只在源到位后才构造。
   *
   * `HostPeer` 在构造期就把视频轨克隆定了，先建后补补不上——所以宁可晚建。
   */
  peer: HostPeer | null
  started: boolean
}

export class ViewerRelay {
  private readonly options: ViewerRelayOptions
  private readonly edges = new Map<string, RelayEdge>()
  private readonly byChild = new Map<string, string>()
  private source: MediaStream | null = null
  private disposed = false

  constructor(options: ViewerRelayOptions) {
    this.options = options
  }

  /** 某条 connectionId 是不是我的转发边（信令分派用）。 */
  owns(connectionId: string): boolean {
    return this.edges.has(connectionId)
  }

  /** 当前转发了几条边（诊断用）。 */
  get size(): number {
    return this.edges.size
  }

  /** 收到的远端流：转发边的唯一源。 */
  setSource(stream: MediaStream | null): void {
    this.source = stream
    if (!stream) return
    for (const edge of this.edges.values()) {
      if (!edge.started) void this.startEdge(edge)
    }
  }

  /**
   * 服务端指定「你负责转发给这位下游」。
   *
   * 同一个 childPeerId 换了 connectionId = 服务端把这条边重挂了：先拆旧的。
   */
  publish(childPeerId: string, connectionId: string): void {
    if (this.disposed || !connectionId) return
    const previous = this.byChild.get(childPeerId)
    if (previous && previous !== connectionId) this.retire(previous)
    if (this.edges.has(connectionId)) return

    const edge: RelayEdge = {
      connectionId,
      childPeerId,
      peer: null,
      started: false,
    }
    this.edges.set(connectionId, edge)
    this.byChild.set(childPeerId, connectionId)
    void this.startEdge(edge)
  }

  /** 下游的 answer / 候选。 */
  acceptSignal(connectionId: string, kind: string, payload: unknown): void {
    const edge = this.edges.get(connectionId)
    if (!edge?.peer) return
    if (kind === 'answer') {
      void edge.peer.acceptAnswer(payload as RTCSessionDescriptionInit)
      return
    }
    if (kind === 'candidate' && payload) {
      void edge.peer.acceptCandidate(payload as RTCIceCandidateInit)
    }
  }

  /**
   * 按一次快照的分配表，拆掉**已经不属于我**的下游边。
   *
   * 为什么需要它：换父之后旧上游（我）不会收到任何 route 消息——服务端只把
   * 新候选发给新上游和下游，我这边一片安静。不主动清理，我就会继续为一条
   * 下游已经拆掉的 PC 编码，白烧一份上行直到 ICE 自己超时。
   *
   * 两条判据都必须**有明确证据**才动手：
   *  - 下游已经不在房间里；
   *  - 分配表里明确写着它的上游是别人。
   * 分配表里查不到它的边**保持不动**——prepare 阶段的下游边本来就不在分配
   * 表里（只有 active 才进 assignment），误杀会断掉一次正在进行的协商。
   */
  reconcileAssignment(
    present: ReadonlySet<string>,
    parentOf: ReadonlyMap<string, string | undefined>
  ): void {
    if (this.disposed || !this.options.selfPeerId) return
    for (const [childPeerId, connectionId] of [...this.byChild]) {
      if (!present.has(childPeerId)) {
        this.retire(connectionId)
        continue
      }
      const parent = parentOf.get(childPeerId)
      if (parent !== undefined && parent !== this.options.selfPeerId) {
        this.retire(connectionId)
      }
    }
  }

  /** 拆掉一条转发边。 */
  retire(connectionId: string): void {
    const edge = this.edges.get(connectionId)
    if (!edge) return
    this.edges.delete(connectionId)
    if (this.byChild.get(edge.childPeerId) === connectionId) {
      this.byChild.delete(edge.childPeerId)
    }
    edge.peer?.dispose()
    edge.peer = null
  }

  dispose(): void {
    this.disposed = true
    for (const connectionId of [...this.edges.keys()]) this.retire(connectionId)
    this.byChild.clear()
    this.source = null
  }

  /**
   * 起一条转发边。
   *
   * 源里还没有视频轨就先等着——`setSource` 到齐了会回头把等待中的边拉起来。
   * 发布端也在这里才构造：`HostPeer` 构造期就把视频轨克隆定了。
   */
  private async startEdge(edge: RelayEdge): Promise<void> {
    if (edge.started || this.disposed || !this.edges.has(edge.connectionId)) {
      return
    }
    const source = this.source
    const video = source?.getVideoTracks()[0]
    if (!source || !video || video.readyState === 'ended') return
    edge.started = true
    const peer = new HostPeer({
      connectionId: edge.connectionId,
      iceServers: this.options.iceServers,
      natPredictionStunUrls: this.options.natPredictionStunUrls,
      stream: source,
      profile: RELAY_QUALITY_PROFILE,
      ...(this.options.videoCodec
        ? { videoCodec: this.options.videoCodec }
        : {}),
      events: {
        sendSignal: (signal) =>
          this.options.sendSignal(edge.connectionId, signal),
        // 转发边不进房主面板：它的统计在观众自己的面板里没有位置。
        onUpdate: () => {},
        onFailed: () => {
          this.retire(edge.connectionId)
          if (!this.disposed) this.options.onFailed(edge.connectionId)
        },
      },
    })
    edge.peer = peer
    const started = await peer.start()
    if (!started && !this.disposed && this.edges.has(edge.connectionId)) {
      // 源在协商过程中没了（上游断流）：这条边没意义了，交给失败上报。
      this.retire(edge.connectionId)
      this.options.onFailed(edge.connectionId)
    }
  }
}
