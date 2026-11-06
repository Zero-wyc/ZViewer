/**
 * Piik 语音的媒体端点：一条连接一个 RTCPeerConnection。
 *
 * 拓扑由服务端下发的 `room-voice-state.connections` 决定，本层不复算：
 *
 *  - `parentPeerId === peerId` 时我是发起方，主动 offer；
 *  - 否则我是接收方，等对方的 offer，需要重排时发 `renegotiate` 请求。
 *
 * 每条连接上 `send` / `receive` 是两个 publicationId 列表。自己发布的音频
 * 从麦克风取，别人的从「已经收到的音轨」取——中间节点就是这样把上游音频
 * 转发给下游的，服务端不复制媒体。
 */
import {
  isOfferer,
  publicationOwner,
  type PiikIceConfig,
  type PiikVoiceConnection,
  type PiikVoiceDescription,
  type PiikVoiceSignal,
  type PiikVoiceState,
} from './protocol.ts'

export interface EndpointHandlers {
  /** 发一帧信令；返回 false 表示连接已不可用。 */
  signal: (message: PiikVoiceSignal) => boolean
  report: (connectionId: string, state: 'connected' | 'failed') => void
  /** 收到一条（属于本连接的）远端音轨。 */
  onTrack: (publicationId: string, track: MediaStreamTrack) => void
  onTrackRemoved: (publicationId: string) => void
  /** 需要重新跑一次 reconcile。 */
  onChange: () => void
}

interface Connection {
  config: PiikVoiceConnection
  pc: RTCPeerConnection
  closed: boolean
  senders: Map<string, RTCRtpSender>
  /** mid → publicationId，来自最新一次远端描述。 */
  remote: Map<string, string>
  pendingCandidates: RTCIceCandidateInit[]
  localCandidates: RTCIceCandidateInit[]
  descriptionSent: boolean
  dirty: boolean
  requested: boolean
  offerRevision: number
  remoteRevision: number
  reported: 'connected' | 'failed' | null
}

/** 本地候选排队上限：对端一直不完成协商时不要无限攒。 */
const MAX_CANDIDATES = 64

export class VoiceEndpoint {
  private iceConfig: PiikIceConfig
  private readonly handlers: EndpointHandlers
  private connections = new Map<string, Connection>()
  private received = new Map<
    string,
    { connectionId: string; track: MediaStreamTrack }
  >()
  private state: PiikVoiceState | null = null
  private peerId = ''
  private generation = 0
  /** 最近一次 reconcile 传入的音轨解析器，应答方协商时也要用。 */
  private sourceTrack: (publicationId: string) => MediaStreamTrack | undefined =
    () => undefined

  constructor(iceConfig: PiikIceConfig, handlers: EndpointHandlers) {
    this.iceConfig = iceConfig
    this.handlers = handlers
  }

  get microphoneReady(): boolean {
    return false
  }

  setIceConfig(config: PiikIceConfig): void {
    this.iceConfig = config
  }

  get connected(): boolean {
    const active =
      this.state?.connections.filter((connection) => !connection.pending) ?? []
    if (active.length === 0) return false
    return active.every(
      (config) =>
        this.connections.get(config.connectionId)?.pc.connectionState ===
        'connected'
    )
  }

  /** 应用一份新的授权状态。 */
  setState(state: PiikVoiceState | null, peerId: string): void {
    this.generation += 1
    this.state = state
    this.peerId = peerId
    const allowed = new Map(
      (state?.connections ?? []).map((config) => [config.connectionId, config])
    )

    for (const [id, connection] of this.connections) {
      const config = allowed.get(id)
      if (!config) {
        this.retire(connection)
        continue
      }
      const before = `${connection.config.send.join()}|${connection.config.receive.join()}`
      const after = `${config.send.join()}|${config.receive.join()}`
      connection.config = config
      if (before !== after) connection.dirty = true
      for (const [publicationId, sender] of connection.senders) {
        if (!config.send.includes(publicationId)) {
          try {
            connection.pc.removeTrack(sender)
          } catch {
            /* 已关闭的连接不用再摘 */
          }
          connection.senders.delete(publicationId)
        }
      }
    }

    for (const [publicationId, binding] of this.received) {
      const config = allowed.get(binding.connectionId)
      if (!config?.receive.includes(publicationId))
        this.dropReceived(publicationId)
    }
  }

  /**
   * 按当前状态推进所有连接。
   *
   * 必须在微任务里串行调用：两轮 reconcile 交错会让同一条连接同时
   * createOffer，得到 glare。
   */
  async reconcile(
    sourceTrack: (publicationId: string) => MediaStreamTrack | undefined
  ): Promise<void> {
    // 记住解析器：应答方在 receiveSignal 里回 answer 之前也要挂发送轨，
    // 而那条路径拿不到 reconcile 的参数。漏了这一步，观众的上行会被
    // 一次 offer 用空解析器摘掉，表现为「能听见房主，房主听不见我」。
    this.sourceTrack = sourceTrack
    const generation = this.generation
    for (const planned of this.state?.connections ?? []) {
      if (generation !== this.generation) return
      const config = this.state?.connections.find(
        (item) => item.connectionId === planned.connectionId
      )
      if (!config) continue
      const connection =
        this.connections.get(config.connectionId) ?? this.create(config)
      try {
        await this.syncSenders(connection, sourceTrack)
        this.bindReceivers(connection)

        const state = connection.pc.connectionState
        if (state === 'connected') this.report(connection, 'connected')
        else if (state === 'failed' || state === 'closed') {
          this.report(connection, 'failed')
          continue
        }

        if (!connection.dirty || connection.pc.signalingState !== 'stable')
          continue
        if (isOfferer(config, this.peerId)) {
          connection.dirty = false
          const offer = await connection.pc.createOffer()
          this.sendDescription(
            connection,
            await this.describe(connection, offer, ++connection.offerRevision)
          )
        } else if (!connection.requested) {
          if (
            this.handlers.signal({
              type: 'room-voice-signal',
              connectionId: config.connectionId,
              renegotiate: true,
            })
          ) {
            connection.requested = true
          }
        }
      } catch {
        if (this.current(connection)) this.report(connection, 'failed')
      }
    }
  }

  /** 处理一条远端信令。 */
  async receive(message: PiikVoiceSignal): Promise<void> {
    const connection = this.connections.get(message.connectionId)
    if (!connection || connection.closed) return
    try {
      await this.receiveSignal(connection, message)
    } catch {
      if (this.current(connection)) this.report(connection, 'failed')
    }
  }

  close(): void {
    this.generation += 1
    this.state = null
    for (const connection of [...this.connections.values()])
      this.retire(connection)
    for (const publicationId of [...this.received.keys()])
      this.dropReceived(publicationId)
  }

  /** 某条连接当前是否已连通（面板用来显示「已连接」）。 */
  connectionState(connectionId: string): RTCPeerConnectionState | null {
    return this.connections.get(connectionId)?.pc.connectionState ?? null
  }

  /** 第一条已建立连接的线路协议，用于面板上的 UDP/TCP 标注。 */
  async transportProtocol(): Promise<'udp' | 'tcp' | null> {
    for (const connection of this.connections.values()) {
      if (connection.pc.connectionState !== 'connected') continue
      const protocol = await probeProtocol(connection.pc)
      if (protocol) return protocol
    }
    return null
  }

  // ==================== 内部 ====================

  private current(connection: Connection): boolean {
    return (
      !connection.closed &&
      this.connections.get(connection.config.connectionId) === connection
    )
  }

  private create(config: PiikVoiceConnection): Connection {
    const pc = new RTCPeerConnection({
      iceServers:
        config.transport === 'sfu'
          ? []
          : (this.iceConfig.iceServers as RTCIceServer[]),
    })
    const connection: Connection = {
      config,
      pc,
      closed: false,
      senders: new Map(),
      remote: new Map(),
      pendingCandidates: [],
      localCandidates: [],
      descriptionSent: false,
      dirty: isOfferer(config, this.peerId),
      requested: false,
      offerRevision: 0,
      remoteRevision: 0,
      reported: null,
    }
    this.connections.set(config.connectionId, connection)

    pc.onicecandidate = (event) => {
      if (!this.current(connection) || !event.candidate) return
      if (connection.localCandidates.length >= MAX_CANDIDATES) return
      connection.localCandidates.push(event.candidate.toJSON())
      this.flushCandidates(connection)
    }
    pc.onnegotiationneeded = () => {
      if (!this.current(connection)) return
      connection.dirty = true
      this.handlers.onChange()
    }
    pc.ontrack = () => {
      if (this.current(connection)) this.bindReceivers(connection)
    }
    pc.onconnectionstatechange = () => {
      if (this.current(connection)) this.handlers.onChange()
    }
    // 发起方先备一条只收的 m-line：没有它，第一版 offer 里没有任何音频槽位，
    // 对端就算有音频也无处可发。
    if (isOfferer(config, this.peerId)) {
      pc.addTransceiver('audio', { direction: 'recvonly' })
    }
    return connection
  }

  private flushCandidates(connection: Connection): void {
    if (!connection.descriptionSent) return
    while (connection.localCandidates[0]) {
      const candidate = connection.localCandidates[0]
      if (
        !this.handlers.signal({
          type: 'room-voice-signal',
          connectionId: connection.config.connectionId,
          candidate,
        })
      )
        return
      connection.localCandidates.shift()
    }
  }

  private async syncSenders(
    connection: Connection,
    sourceTrack: (publicationId: string) => MediaStreamTrack | undefined
  ): Promise<void> {
    const { pc, config } = connection

    for (const [publicationId, sender] of connection.senders) {
      const track = config.send.includes(publicationId)
        ? sourceTrack(publicationId)
        : undefined
      if (!track) {
        try {
          await sender.replaceTrack(null)
        } catch {
          /* 连接正在关闭 */
        }
        try {
          pc.removeTrack(sender)
        } catch {
          /* 已移除 */
        }
        connection.senders.delete(publicationId)
        connection.dirty = true
      } else if (sender.track !== track) {
        try {
          await sender.replaceTrack(track)
        } catch {
          /* 协商中，下一轮再试 */
        }
        if (sender.track !== track) continue
        connection.dirty = true
      }
    }

    for (const publicationId of config.send) {
      const track = sourceTrack(publicationId)
      if (!track || connection.senders.has(publicationId)) continue
      const free = pc
        .getTransceivers()
        .find(
          (item) =>
            item.direction !== 'stopped' &&
            !item.sender.track &&
            item.direction !== 'inactive'
        )
      const stream = new MediaStream([track])
      let sender: RTCRtpSender
      if (free) {
        try {
          await free.sender.replaceTrack(track)
        } catch {
          continue
        }
        free.sender.setStreams(stream)
        free.direction =
          free.direction === 'recvonly' || free.direction === 'sendrecv'
            ? 'sendrecv'
            : 'sendonly'
        sender = free.sender
      } else {
        sender = pc.addTrack(track, stream)
      }
      connection.senders.set(publicationId, sender)
      connection.dirty = true
    }

    // 发起方要保证 recvonly 槽位够收下所有 publication。
    if (isOfferer(config, this.peerId)) {
      const receiving = pc
        .getTransceivers()
        .filter(
          (item) =>
            item.direction !== 'stopped' &&
            (item.direction === 'recvonly' || item.direction === 'sendrecv')
        ).length
      for (let index = receiving; index < config.receive.length; index += 1) {
        pc.addTransceiver('audio', { direction: 'recvonly' })
        connection.dirty = true
      }
    }
  }

  private bindReceivers(connection: Connection): void {
    const retained = new Set<string>()
    for (const transceiver of connection.pc.getTransceivers()) {
      const publicationId = connection.remote.get(transceiver.mid ?? '')
      const track = transceiver.receiver.track
      if (!publicationId || !connection.config.receive.includes(publicationId))
        continue
      if (track.kind !== 'audio' || track.readyState === 'ended') continue
      retained.add(publicationId)
      const existing = this.received.get(publicationId)
      if (existing?.track === track) continue
      if (existing) this.dropReceived(publicationId)
      this.received.set(publicationId, {
        connectionId: connection.config.connectionId,
        track,
      })
      this.handlers.onTrack(publicationId, track)
    }
    for (const [publicationId, binding] of this.received) {
      if (
        binding.connectionId === connection.config.connectionId &&
        !retained.has(publicationId)
      ) {
        this.dropReceived(publicationId)
      }
    }
  }

  private dropReceived(publicationId: string): void {
    if (!this.received.delete(publicationId)) return
    this.handlers.onTrackRemoved(publicationId)
  }

  private async describe(
    connection: Connection,
    sdp: RTCSessionDescriptionInit,
    revision: number
  ): Promise<PiikVoiceDescription> {
    connection.descriptionSent = false
    await connection.pc.setLocalDescription(sdp)
    const local = connection.pc.localDescription
    if (!local) throw new Error('local description missing')
    const tracks: PiikVoiceDescription['tracks'] = []
    for (const [publicationId, sender] of connection.senders) {
      if (!connection.config.send.includes(publicationId)) continue
      const mid = connection.pc
        .getTransceivers()
        .find((item) => item.sender === sender)?.mid
      if (mid === null || mid === undefined) continue
      tracks.push({ mid, publicationId })
    }
    return {
      revision,
      sdp: { type: local.type as 'offer' | 'answer', sdp: local.sdp },
      tracks,
    }
  }

  private sendDescription(
    connection: Connection,
    description: PiikVoiceDescription
  ): void {
    if (
      !this.handlers.signal({
        type: 'room-voice-signal',
        connectionId: connection.config.connectionId,
        description,
      })
    ) {
      throw new Error('voice signaling unavailable')
    }
    connection.descriptionSent = true
    this.flushCandidates(connection)
  }

  private async receiveSignal(
    connection: Connection,
    message: PiikVoiceSignal
  ): Promise<void> {
    if ('renegotiate' in message) {
      if (isOfferer(connection.config, this.peerId)) connection.dirty = true
      return
    }
    if ('candidate' in message) {
      const candidate = message.candidate
      if (connection.pc.remoteDescription) {
        await connection.pc.addIceCandidate(candidate)
      } else if (connection.pendingCandidates.length < MAX_CANDIDATES) {
        connection.pendingCandidates.push(candidate)
      }
      return
    }

    const description = message.description
    const offer = description.sdp.type === 'offer'
    const meOfferer = isOfferer(connection.config, this.peerId)
    if (offer === meOfferer) return
    if (description.revision <= connection.remoteRevision) return
    if (
      !offer &&
      (description.revision !== connection.offerRevision ||
        connection.pc.signalingState !== 'have-local-offer')
    ) {
      return
    }

    const allowed = new Set(connection.config.receive)
    await connection.pc.setRemoteDescription(description.sdp)
    connection.remote = new Map(
      description.tracks
        .filter((track) => allowed.has(track.publicationId))
        .map((track) => [track.mid, track.publicationId])
    )
    connection.remoteRevision = description.revision
    for (const candidate of connection.pendingCandidates.splice(0)) {
      await connection.pc.addIceCandidate(candidate)
    }
    this.bindReceivers(connection)

    if (offer) {
      connection.requested = false
      connection.dirty = false
      // 应答方也要把自己要发的轨挂上：观众的麦克风正是通过这条 answer
      // 的 m-line 上行给父节点的。少了这一步，answer 里只会有接收方向，
      // 表现就是「能听见别人，别人听不见我」。
      await this.syncSenders(connection, this.sourceTrack)
      const answer = await connection.pc.createAnswer()
      this.sendDescription(
        connection,
        await this.describe(connection, answer, description.revision)
      )
    }
  }

  private report(connection: Connection, state: 'connected' | 'failed'): void {
    if (connection.reported === state) return
    if (this.handlers.signal === undefined) return
    if (this.current(connection)) {
      this.handlers.report(connection.config.connectionId, state)
      connection.reported = state
    }
  }

  private retire(connection: Connection): void {
    connection.closed = true
    this.connections.delete(connection.config.connectionId)
    try {
      connection.pc.close()
    } catch {
      /* 已关闭 */
    }
    for (const [publicationId, binding] of this.received) {
      if (binding.connectionId === connection.config.connectionId)
        this.dropReceived(publicationId)
    }
  }
}

/** 从 candidate-pair 统计里读出选中的线路协议。 */
async function probeProtocol(
  pc: RTCPeerConnection
): Promise<'udp' | 'tcp' | null> {
  try {
    const stats = await pc.getStats()
    let selectedPair: Record<string, unknown> | null = null
    const candidates = new Map<string, Record<string, unknown>>()
    stats.forEach((report) => {
      const row = report as unknown as Record<string, unknown>
      if (row.type === 'local-candidate') candidates.set(String(row.id), row)
      if (
        row.type === 'candidate-pair' &&
        (row.selected === true || row.nominated === true)
      )
        selectedPair = row
    })
    if (!selectedPair) return null
    const localId = String(
      (selectedPair as Record<string, unknown>).localCandidateId ?? ''
    )
    const protocol = candidates.get(localId)?.protocol
    if (protocol === 'udp') return 'udp'
    if (protocol === 'tcp') return 'tcp'
    return null
  } catch {
    return null
  }
}

export { publicationOwner }
