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
  reported: boolean
  stream: MediaStream
}

export class ShareEndpoint {
  private iceConfig: PiikIceConfig
  private readonly localStream: MediaStream | null
  private readonly handlers: ShareEndpointHandlers
  private readonly edges = new Map<string, Edge>()
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
      reported: false,
      stream: new MediaStream(),
    }
    this.edges.set(connectionId, edge)

    if (this.localStream) {
      for (const track of this.localStream.getTracks())
        pc.addTrack(track, this.localStream)
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
      this.handlers.onStream(connectionId, edge.stream)
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
   * 子节点在 PC 连上后回报，服务端据此把候选记成成功。
   *
   * 父节点也发一次是安全的（服务端只认子端点），但会白占一次操作位，
   * 所以这里只让子节点发。
   */
  private settle(edge: Edge, connectionId: string): void {
    if (edge.reported || edge.offerer) return
    edge.reported = true
    this.handlers.send({
      type: 'route-transport-connected',
      revision: edge.revision || this.revision,
      connectionId,
    })
  }

  private fail(edge: Edge, connectionId: string): void {
    if (edge.reported) return
    edge.reported = true
    this.handlers.send({
      type: 'route-failed',
      revision: edge.revision || this.revision,
      phase: 'active',
      connectionId,
    })
    try {
      edge.pc.close()
    } catch {
      /* 已经关了 */
    }
    this.edges.delete(connectionId)
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
