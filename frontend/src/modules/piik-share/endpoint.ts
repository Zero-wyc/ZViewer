/**
 * 共享的媒体端点：一条边一个 RTCPeerConnection。
 *
 * 与语音的 `VoiceEndpoint` 同构，但共享只有**单向**媒体：父节点发、子节点收。
 * 所以这一层比语音简单——不需要「中间节点转发」，也不需要按 publication 拆轨。
 *
 * 拓扑完全由服务端的 `route-update` 决定：
 *  - `assignment.childPeerIds` 里有 candidate 的 childPeerId → 我是父，主动 offer；
 *  - `assignment.upstream` 指向某个 peer → 我是子，等对方 offer。
 *
 * 结算由**子节点**发起：PC 连上后发 `route-transport-connected`，服务端把它
 * 记成候选成功并把这条边广播成 active。父节点发这个没人认。
 */
import {
  type PiikClientMessage,
  type PiikIceConfig,
  type PiikRouteAssignment,
  type PiikRouteUpdate,
  type PiikServerMessage,
  type PiikServerSignalMessage,
  type PiikSignalPayload,
} from '../piik-signal/protocol.ts'
import type { EncoderHealthSample } from '../screen-sharing/core/encoder-health.ts'
import {
  configureVideoSender,
  type QualityProfile,
  type VideoSenderParameterReadback,
} from '../screen-sharing/core/quality.ts'

export interface ShareEndpointHandlers {
  send: (message: PiikClientMessage) => boolean
  /** 这条边收到了远端媒体。 */
  onStream: (connectionId: string, stream: MediaStream) => void
  onStateChange: (connectionId: string, state: RTCPeerConnectionState) => void
}

interface Edge {
  pc: RTCPeerConnection
  connectionId: string
  /** 对端 peerId。 */
  remotePeerId: string
  /** 我是父节点（发起方）。 */
  offerer: boolean
  /** 最近一次 route-update 的版本，结算候选时原样带回。 */
  revision: number
  /** 远端描述还没到之前先攒着候选。 */
  pendingCandidates: RTCIceCandidateInit[]
  remoteReady: boolean
  /** 已发过 `route-ready`；一条边只结算一次。 */
  settled: boolean
  /** 已报过 `route-failed`。 */
  reported: boolean
  stream: MediaStream
}

/** 一条边的用量，统计面板只读这几个数。 */
export interface ShareEdgeStats {
  connectionId: string
  direction: 'inbound' | 'outbound'
  state: RTCPeerConnectionState
  bytes: number
  frames: number
  width: number
  height: number
  fps: number
}

/**
 * 一条出边的编码健康采样。
 *
 * `EncoderHealthSample` 是按连接判定的（基线、窗口），共享是多条边同时出，
 * 所以采样必须带上 `connectionId`——否则两条边的计数器会互相污染，
 * 心跳式的一高一低会让判据永远得不出结论。
 */
export interface ShareHealthSample extends EncoderHealthSample {
  connectionId: string
}

export class ShareEndpoint {
  private iceConfig: PiikIceConfig
  private localStream: MediaStream | null
  private readonly handlers: ShareEndpointHandlers
  private readonly edges = new Map<string, Edge>()
  /** 上游推过来的流；观众当中转节点时，把它原样转给下游。 */
  private incoming: MediaStream | null = null
  /** 当前上游（父）的 peerId；换父时用来判断哪条入边该关。 */
  private upstreamPeerId = ''
  private revision = 0
  private closed = false

  constructor(
    iceConfig: PiikIceConfig,
    localStream: MediaStream | null,
    handlers: ShareEndpointHandlers
  ) {
    this.iceConfig = iceConfig
    this.localStream = localStream
    this.handlers = handlers
  }

  setIceConfig(config: PiikIceConfig): void {
    this.iceConfig = config
  }

  /**
   * 换本地推出去的流（换采集源 / 换分辨率）。
   *
   * 走 `replaceTrack` 而不是 `addTrack`：前者不重协商，观众端无感；
   * 后者会触发出价方重新 offer，四五个观众就是四五次重协商。
   * 首帧之前建的边可能还没有对应 sender（`addTrack` 时机早于视频轨），
   * 这种情况退化成 `addTrack`，由浏览器自己补一次协商。
   */
  async replaceLocalStream(stream: MediaStream | null): Promise<void> {
    this.localStream = stream
    if (!stream) return
    const tracks = stream.getTracks()
    for (const edge of this.edges.values()) {
      if (!edge.offerer) continue
      for (const track of tracks) {
        const sender = edge.pc
          .getSenders()
          .find((item) => item.track?.kind === track.kind)
        if (sender) {
          try {
            await sender.replaceTrack(track)
          } catch {
            /* 连接已经关了 */
          }
          continue
        }
        try {
          edge.pc.addTrack(track, stream)
        } catch {
          /* 连接已经关了 */
        }
      }
    }
  }

  /**
   * 把档位写到所有出边的发送参数上，并**回读**浏览器实际接受了什么。
   *
   * 不重采集也不重协商，只是让编码器改目标：`maxBitrate` / `maxFramerate`，
   * 以及 `scaleResolutionDownBy`（自动降档靠它把画面缩小，不重新采集——
   * 重开会弹一次画面选择器，观众端也会黑一帧）。
   *
   * 返回每条出边的回读结果：`setParameters` 只是请求，浏览器可以按自己的
   * 策略改小码率、钉住帧率甚至忽略降采样。不回读就等于默认一切照办，
   * 用户看到的档位和真正发出去的画面会不一致，界面上还毫无提示。
   */
  async applyEncoding(
    profile: QualityProfile
  ): Promise<VideoSenderParameterReadback[]> {
    const readbacks: VideoSenderParameterReadback[] = []
    for (const edge of this.edges.values()) {
      if (!edge.offerer) continue
      for (const sender of edge.pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue
        try {
          readbacks.push(await configureVideoSender(sender, profile))
        } catch {
          /* 浏览器不接受这组参数，或连接已经关了：不该让调用方当成失败 */
        }
      }
    }
    return readbacks
  }

  /**
   * 每条出边采一次编码健康。
   *
   * 取 `outbound-rtp`(video) 的 `framesEncoded` 与它挂的 `media-source.frames`，
   * 加上 `qualityLimitationReason`——CPU 受限时浏览器已经明说编不动了，
   * 不必等帧数。采样是观测性的：任何一步失败都只跳过这条边，不影响媒体。
   */
  async healthSamples(): Promise<ShareHealthSample[]> {
    const samples: ShareHealthSample[] = []
    for (const [connectionId, edge] of this.edges) {
      if (!edge.offerer) continue
      const report = await edge.pc.getStats().catch(() => null)
      if (!report) continue

      let framesEncoded: number | null = null
      let outboundId: string | null = null
      let sourceId: string | null = null
      let limitation: EncoderHealthSample['limitation'] = null
      report.forEach((entry) => {
        const stat = entry as {
          type?: string
          kind?: string
          id?: string
          framesEncoded?: number
          mediaSourceId?: string
          qualityLimitationReason?: string
        }
        if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') return
        if (typeof stat.framesEncoded !== 'number') return
        // simulcast 时同一路会有多条 outbound-rtp，取编码量最大的一条
        // （全尺寸那层），与旧实现 HostPeer 的口径一致。
        if (framesEncoded !== null && stat.framesEncoded <= framesEncoded)
          return
        framesEncoded = stat.framesEncoded
        outboundId = stat.id ?? null
        sourceId = stat.mediaSourceId ?? null
        limitation =
          (stat.qualityLimitationReason as EncoderHealthSample['limitation']) ??
          null
      })
      if (framesEncoded === null) continue

      const source = sourceId
        ? (report.get(sourceId) as { frames?: number } | undefined)
        : undefined
      samples.push({
        connectionId,
        outboundId,
        sourceId,
        // 统计报告的 timestamp 精度因浏览器而异，统一用本地时钟算窗口长度。
        timestamp: Date.now(),
        framesEncoded,
        sourceFrames: typeof source?.frames === 'number' ? source.frames : null,
        limitation,
      })
    }
    return samples
  }

  /**
   * 每条边的用量。
   *
   * 共享是单向的：房主的边只有出、观众的边只有入，所以一条边只取一个方向，
   * 面板上不会出现「同一条边两个方向都为零」的困惑。
   */
  async stats(): Promise<ShareEdgeStats[]> {
    const out: ShareEdgeStats[] = []
    for (const [connectionId, edge] of this.edges) {
      const report = await edge.pc.getStats().catch(() => null)
      if (!report) continue
      const item: ShareEdgeStats = {
        connectionId,
        direction: edge.offerer ? 'outbound' : 'inbound',
        state: edge.pc.connectionState,
        bytes: 0,
        frames: 0,
        width: 0,
        height: 0,
        fps: 0,
      }
      report.forEach((entry) => {
        const stat = entry as Record<string, unknown> & { type?: string }
        if (stat.type === 'inbound-rtp') {
          item.bytes += Number(stat.bytesReceived ?? 0)
          item.frames += Number(stat.framesDecoded ?? 0)
          item.width = Math.max(item.width, Number(stat.frameWidth ?? 0))
          item.height = Math.max(item.height, Number(stat.frameHeight ?? 0))
          item.fps = Math.max(item.fps, Number(stat.framesPerSecond ?? 0))
        }
        if (stat.type === 'outbound-rtp') {
          item.bytes += Number(stat.bytesSent ?? 0)
          item.frames += Number(stat.framesEncoded ?? 0)
          item.width = Math.max(item.width, Number(stat.frameWidth ?? 0))
          item.height = Math.max(item.height, Number(stat.frameHeight ?? 0))
          item.fps = Math.max(item.fps, Number(stat.framesPerSecond ?? 0))
        }
      })
      out.push(item)
    }
    return out
  }

  /** 一条边的连接状态，用于面板展示。 */
  stateOf(connectionId: string): RTCPeerConnectionState | null {
    return this.edges.get(connectionId)?.pc.connectionState ?? null
  }

  connectionIds(): string[] {
    return [...this.edges.keys()]
  }

  close(): void {
    this.closed = true
    for (const edge of this.edges.values()) {
      try {
        edge.pc.close()
      } catch {
        /* 已经关了 */
      }
    }
    this.edges.clear()
  }

  /** 处理一条下行消息；不认识的直接忽略。 */
  handle(message: PiikServerMessage): void {
    if (this.closed) return
    switch (message.type) {
      case 'authenticated':
        return
      case 'route-update':
        this.applyRoute(message as PiikRouteUpdate)
        return
      case 'signal':
        this.applySignal(message as PiikServerSignalMessage)
        return
      default:
        return
    }
  }

  // ==================== 路由 ====================

  private applyRoute(update: PiikRouteUpdate): void {
    this.revision = Math.max(this.revision, update.revision)
    // 服务端只把 route-update 发给当事人，所以拿到手的 assignment 就是自己那份。
    // 换父完全靠这里发现：父节点掉线后 controller 重新分配，我会收到一条
    // upstream 指向新父的 prepare（以及随后的 active 广播）。
    if (update.assignment) this.applyAssignment(update.assignment)
    if (update.phase !== 'prepare') return
    const candidate = update.candidate
    // Piik 的候选有两种传输：`direct`（浏览器直连）与 `sfu`（服务端中转）。
    // 走这条链路的共享只做直连；sfu 候选留给以后接中继时再处理。
    if (!candidate || candidate.transport !== 'direct') return
    // 我只在「我是父」的时候主动发起。子节点等 offer，由 signal 分支建边。
    if (!update.assignment.childPeerIds.includes(candidate.childPeerId)) return
    if (this.edges.has(candidate.connectionId)) return

    const edge = this.createEdge(
      candidate.connectionId,
      candidate.childPeerId,
      true,
      update.revision
    )
    if (!edge) return
    void this.offer(edge, candidate.connectionId)
  }

  /**
   * 对齐自己的上游。
   *
   * 父节点离开时，controller 会把它的子树重新挂到别处；新父会收到
   * prepare 并主动 offer，我这边只要把旧父的边关掉、等新 offer 即可。
   * 关边必须**不发** `route-failed`——报失败会让 controller 把这次的
   * 重新分配也判死，子节点会一直重连不上。
   */
  private applyAssignment(assignment: PiikRouteAssignment): void {
    const upstream = assignment.upstream
    const nextPeerId =
      upstream && upstream.kind === 'peer' ? String(upstream.peerId ?? '') : ''
    const changed = nextPeerId !== this.upstreamPeerId
    this.upstreamPeerId = nextPeerId
    // 上游换成 sfu（空 peerId）时同样要把直连的入边关掉。
    for (const [connectionId, edge] of [...this.edges]) {
      if (edge.offerer) continue
      if (nextPeerId && edge.remotePeerId === nextPeerId) continue
      this.dropEdge(connectionId, edge)
    }
    if (changed) {
      // 旧的上游流已经作废，等新父的 track 到达再接管转发。
      this.incoming = null
    }
  }

  private applySignal(message: PiikServerSignalMessage): void {
    const payload = message.payload
    if (!payload || typeof payload.connectionId !== 'string') return
    const connectionId = payload.connectionId
    const from = String(message.fromPeerId ?? '')
    let edge = this.edges.get(connectionId)

    if (payload.kind === 'candidate') {
      const candidate = payload.candidate
      if (!candidate) return
      if (!edge) return
      if (!edge.remoteReady) {
        edge.pendingCandidates.push(candidate)
        return
      }
      void edge.pc.addIceCandidate(candidate).catch(() => {
        /* 过期候选：对端已经重协商掉了，丢掉即可 */
      })
      return
    }

    if (payload.kind !== 'description') return
    const description = payload.description
    if (!description) return

    if (description.type === 'offer') {
      // 子节点：收到 offer 才建边。父节点不会收到 offer（一条边只有一个方向）。
      if (!edge) {
        edge = this.createEdge(connectionId, from, false, this.revision)
        if (!edge) return
      }
      void this.answer(edge, connectionId, description.sdp)
      return
    }

    if (!edge) return
    void this.acceptAnswer(edge, description.sdp)
  }

  // ==================== 协商 ====================

  private createEdge(
    connectionId: string,
    remotePeerId: string,
    offerer: boolean,
    revision: number
  ): Edge | null {
    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({
        iceServers: this.iceConfig.iceServers ?? [],
      })
    } catch {
      return null
    }
    const edge: Edge = {
      pc,
      connectionId,
      remotePeerId,
      offerer,
      revision,
      pendingCandidates: [],
      remoteReady: false,
      settled: false,
      reported: false,
      stream: new MediaStream(),
    }
    this.edges.set(connectionId, edge)

    // 房主发自己的屏幕；观众当中间节点时发的是上游推过来的流。
    // 服务端不复制媒体，中间节点必须自己把收到的轨挂到下游连接上。
    const source = this.localStream ?? this.incoming
    if (source) {
      for (const track of source.getTracks()) pc.addTrack(track, source)
    }

    pc.onicecandidate = (event) => {
      const candidate = event.candidate
      // 候选结束（null）不转发：协议允许，但服务端只认真正的候选。
      if (!candidate) return
      this.sendSignal(remotePeerId, {
        kind: 'candidate',
        connectionId,
        candidate: candidate.toJSON(),
      })
    }
    pc.ontrack = (event) => {
      const track = event.track
      if (!edge.stream.getTracks().includes(track)) edge.stream.addTrack(track)
      // 只有入边的流算「上游」。换父后 incoming 被清空，新父的 track
      // 到达时会重新接管；旧边的 track 已随连接关闭而 ended。
      if (!edge.offerer && !this.incoming) this.incoming = edge.stream
      this.handlers.onStream(connectionId, edge.stream)
      this.relayToChildren(track)
    }
    pc.onconnectionstatechange = () => {
      this.handlers.onStateChange(connectionId, pc.connectionState)
      if (pc.connectionState === 'connected') this.settle(edge, connectionId)
      if (pc.connectionState === 'failed') this.fail(edge, connectionId)
    }
    return edge
  }

  private async offer(edge: Edge, connectionId: string): Promise<void> {
    try {
      const offer = await edge.pc.createOffer()
      await edge.pc.setLocalDescription(offer)
      this.sendSignal(edge.remotePeerId, {
        kind: 'description',
        connectionId,
        description: { type: 'offer', sdp: offer.sdp ?? '' },
      })
    } catch {
      this.fail(edge, connectionId)
    }
  }

  private async answer(
    edge: Edge,
    connectionId: string,
    sdp: string
  ): Promise<void> {
    try {
      await edge.pc.setRemoteDescription({ type: 'offer', sdp })
      edge.remoteReady = true
      for (const candidate of edge.pendingCandidates.splice(0))
        await edge.pc.addIceCandidate(candidate)
      const answer = await edge.pc.createAnswer()
      await edge.pc.setLocalDescription(answer)
      this.sendSignal(edge.remotePeerId, {
        kind: 'description',
        connectionId,
        description: { type: 'answer', sdp: answer.sdp ?? '' },
      })
    } catch {
      this.fail(edge, connectionId)
    }
  }

  private async acceptAnswer(edge: Edge, sdp: string): Promise<void> {
    try {
      await edge.pc.setRemoteDescription({ type: 'answer', sdp })
      edge.remoteReady = true
      for (const candidate of edge.pendingCandidates.splice(0))
        await edge.pc.addIceCandidate(candidate)
    } catch {
      this.fail(edge, edge.connectionId)
    }
  }

  // ==================== 结算 ====================

  /**
   * 把上游刚到的轨补挂到已经建好的下游连接上。
   *
   * 中间节点的 offer 可能在首帧之前就发出去了，那时 `incoming` 还是空的；
   * 等轨到了再 addTrack，浏览器会自动触发一次重协商（offerer 侧）。
   */
  private relayToChildren(track: MediaStreamTrack | null): void {
    if (!track) return
    for (const edge of this.edges.values()) {
      if (!edge.offerer) continue
      const already = edge.pc
        .getSenders()
        .some((sender) => sender.track === track)
      if (already) continue
      try {
        edge.pc.addTrack(track, new MediaStream([track]))
      } catch {
        /* 连接已经关了 */
      }
    }
  }

  private settle(edge: Edge, connectionId: string): void {
    if (edge.settled || edge.offerer) return
    edge.settled = true
    const revision = edge.revision || this.revision
    this.handlers.send({
      type: 'route-transport-connected',
      revision,
      connectionId,
    })
    this.handlers.send({ type: 'route-ready', revision, phase: 'prepare' })
  }

  /**
   * 边失败。
   *
   * 只在「当前上游还是这条边的对端」时上报，对齐 Piik 的
   * `reportActivePeerRouteFailure`：换父之后旧边会自然断开，这时候再报
   * `route-failed` 会把 controller 刚做完的重新分配判死，子节点反复重连不上。
   * 父侧的出边也不报——服务端只认候选的子端点。
   */
  private fail(edge: Edge, connectionId: string): void {
    if (edge.reported) return
    edge.reported = true
    if (!edge.offerer && this.upstreamPeerId === edge.remotePeerId) {
      this.handlers.send({
        type: 'route-failed',
        revision: edge.revision || this.revision,
        phase: 'active',
        connectionId,
      })
    }
    this.dropEdge(connectionId, edge)
  }

  /** 本地关掉一条边；不向服务端上报。 */
  private dropEdge(connectionId: string, edge: Edge): void {
    if (this.edges.get(connectionId) !== edge) return
    this.edges.delete(connectionId)
    if (this.incoming === edge.stream) this.incoming = null
    try {
      edge.pc.close()
    } catch {
      /* 已经关了 */
    }
    this.handlers.onStateChange(connectionId, 'closed')
  }

  private sendSignal(targetPeerId: string, payload: PiikSignalPayload): void {
    this.handlers.send({
      type: 'signal',
      targetPeerId,
      payload,
    })
  }
}

export type { PiikRouteAssignment }
