/**
 * 房主侧一条发布端连接。
 *
 * 结构、状态机与字段命名照搬 Piik `src/client/webrtc/host-peer.ts`（MIT）。
 * 删掉的部分：编码池（Piik 的 CPU 优化，约 1.1k 行，ZViewer P3 后评估）、
 * NAT 预测（Piik 自研服务端探测，ZViewer 用标准 ICE）、输入数据通道（远程控制）。
 *
 * **协商纪律（这是整个文件存在的理由）**：房主永远单向发 offer，观众只
 * createAnswer。带来两个必须处理的竞态：
 *
 *  1. 一次只允许一个 offer 在飞。切源、开关麦都会想重新协商，两个 offer
 *     同时在飞时，先到的 answer 会消耗后一个 offer 的纪元，SDP 状态机直接
 *     错位（glare）。Piik 的做法是 `pendingNegotiation` 标记 + 队列接力
 *     （`host-peer.ts:671-677`），这里原样保留。
 *  2. 两条串行队列各管一摊：`senderMutationTail` 管 sender 参数/换轨，
 *     `negotiationTail` 管 SDP。PIik 的注释写明「绝不在协商里 await sender
 *     工作」——换源正在等协商队列，协商再等换源就死锁（`:758-763`）。
 */
import { applyVideoCaptureProfile } from './capture'
import { waitForConnectionOperation } from './connection-op'
import {
  STARTUP_VIDEO_ENCODED_FRAMES,
  audioQualitySettingsEqual,
  configureAudioSender,
  configureVideoSender,
  needsStartupVideoProfile,
  screenAudioBitrate,
  startupVideoProfile,
  videoQualitySettingsEqual,
  type AudioSenderParameterReadback,
  type QualityProfile,
  type VideoSenderParameterReadback,
} from './quality'
import { cloneSenderVideoTrack, stopSenderVideoTrack } from './sender-track'
import {
  H264_PREFERRED_VIDEO_CODEC,
  applyVideoCodecPreference,
  normalizeVideoOfferSdp,
  type BrowserVideoCodecPreference,
} from './video-codec'

/**
 * 重协商等待应答的上限。
 *
 * 只约束「改音频方向」这类重协商：初始建连与 ICE 重启有各自的路由/恢复
 * 负责人（服务端路由 + 观众恢复预算），这里不能越权判死。
 */
export const RENEGOTIATION_ANSWER_TIMEOUT_MS = 15_000

/** 缓存远端候选的上限，防止对端灌爆内存。 */
const MAX_PENDING_CANDIDATES = 64

/** 房主发给对端的信号。 */
export type HostSignal =
  | { kind: 'offer'; description: RTCSessionDescriptionInit }
  | { kind: 'candidate'; candidate: RTCIceCandidateInit }

/** 一条连接的可观测快照。 */
export interface HostPeerSnapshot {
  connectionId: string
  connectionState: RTCPeerConnectionState
  iceConnectionState: RTCIceConnectionState
  paused: boolean
  /** 已编码帧数，启动保护据此判断「尺寸坐实了」。 */
  framesEncoded: number | null
  /** 语义错误码（不是展示文案）。 */
  error: string | null
  senderParameters: VideoSenderParameterReadback | null
  audioSenderParameters: AudioSenderParameterReadback | null
}

export interface HostPeerEvents {
  /** 发出一条信号；返回 false 表示通道已断（调用方应当放弃这次协商）。 */
  sendSignal: (signal: HostSignal) => boolean
  onUpdate: (snapshot: HostPeerSnapshot) => void
  /** 连接彻底失败（媒体链路断了），宿主据此销毁这条连接。 */
  onFailed: (snapshot: HostPeerSnapshot) => void
}

export interface HostPeerOptions {
  connectionId: string
  iceServers: RTCIceServer[]
  stream: MediaStream
  profile: QualityProfile
  events: HostPeerEvents
  videoCodec?: BrowserVideoCodecPreference
}

export class HostPeer {
  readonly connectionId: string

  private readonly connection: RTCPeerConnection
  private readonly events: HostPeerEvents
  private readonly lifetime = new AbortController()
  private readonly pendingCandidates: RTCIceCandidateInit[] = []
  private readonly videoCodec: BrowserVideoCodecPreference

  private stream: MediaStream
  private desiredProfile: QualityProfile
  private senderVideoTrack: MediaStreamTrack | null
  private videoSender: RTCRtpSender | null = null
  private audioSender: RTCRtpSender | null = null
  private audioTransceiver: RTCRtpTransceiver | null = null

  private appliedVideoProfile: QualityProfile | null = null
  private appliedAudioBitrate: number | null = null
  private appliedAudioSenderParameters: AudioSenderParameterReadback | null =
    null

  private profileRevision = 0
  private negotiationEpoch = 0
  private ordinaryAnswerEpoch: number | null = null
  private answerTimer: ReturnType<typeof setTimeout> | null = null
  private pendingNegotiation = false
  private senderMutationTail: Promise<unknown> = Promise.resolve()
  private negotiationTail: Promise<unknown> = Promise.resolve()

  private startupVideoProfilePending: boolean
  private startupFramesBaseline: number | null = 0

  private statsTimer: ReturnType<typeof setInterval> | null = null
  private statsInFlight = false

  private connectedOnce = false
  private awaitingReconnect = false
  private paused = false
  private snapshot: HostPeerSnapshot

  constructor(options: HostPeerOptions) {
    this.connectionId = options.connectionId
    this.events = options.events
    this.stream = options.stream
    this.desiredProfile = options.profile
    this.videoCodec = options.videoCodec ?? H264_PREFERRED_VIDEO_CODEC

    const sourceVideoTrack = options.stream.getVideoTracks()[0] ?? null
    this.paused = sourceVideoTrack?.enabled === false
    this.senderVideoTrack = sourceVideoTrack
      ? this.cloneVideoTrack(sourceVideoTrack)
      : null
    this.startupVideoProfilePending = needsStartupVideoProfile(options.profile)

    this.connection = new RTCPeerConnection({ iceServers: options.iceServers })
    this.snapshot = {
      connectionId: this.connectionId,
      connectionState: this.connection.connectionState,
      iceConnectionState: this.connection.iceConnectionState,
      paused: this.paused,
      framesEncoded: null,
      error: null,
      senderParameters: null,
      audioSenderParameters: null,
    }
    this.bindConnectionEvents()
  }

  private get disposed(): boolean {
    return this.lifetime.signal.aborted
  }

  /** 建 transceiver、配置编码参数、发出第一个 offer。 */
  async start(): Promise<boolean> {
    const videoTrack = this.senderVideoTrack
    if (!videoTrack) {
      this.setError('share.host.error.noSource')
      return false
    }
    const audioTrack = this.stream.getAudioTracks()[0] ?? null
    const videoTransceiver = this.connection.addTransceiver(videoTrack, {
      direction: 'sendonly',
      streams: [this.stream],
    })
    if (!applyVideoCodecPreference(videoTransceiver, this.videoCodec)) {
      // 硬失败：不允许「用默认编码将就」，那只会变成持续卡顿。
      this.setError('share.host.error.codecUnsupported')
      return false
    }
    this.videoSender = videoTransceiver.sender
    this.audioTransceiver = this.connection.addTransceiver(
      audioTrack ?? 'audio',
      {
        direction: audioTrack ? 'sendonly' : 'inactive',
        streams: [this.stream],
      }
    )
    this.audioSender = this.audioTransceiver.sender

    await this.enqueueSenderMutation(async () => {
      if (this.disposed || !this.videoSender || !this.audioSender) return false
      return this.configureSender(this.videoSender, this.audioSender, {
        profile: startupVideoProfile(this.desiredProfile),
        profileRevision: this.profileRevision,
        video: true,
        audio: true,
      })
    })
    if (!(await this.createOffer()) || this.disposed) {
      return false
    }
    this.statsTimer = setInterval(() => {
      void this.updateStats()
    }, 2_000)
    this.emit()
    return true
  }

  /** 处理观众的应答。房主永远不发 answer，所以这里只接受 answer。 */
  async acceptAnswer(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.disposed || description.type !== 'answer') return
    try {
      await this.enqueueNegotiation(() => this.acceptAnswerOwned(description))
    } catch {
      this.setError('share.host.error.negotiation')
    }
  }

  /** 处理观众发来的候选。 */
  async acceptCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.disposed) return
    try {
      await this.enqueueNegotiation(async () => {
        if (this.disposed) return
        // 有在飞 offer（或还没有远端描述）时先缓存：此时 addIceCandidate
        // 会因为没有远端描述直接抛错，而候选本身是有效的。
        if (
          this.ordinaryAnswerEpoch !== null ||
          !this.connection.remoteDescription
        ) {
          if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
            this.pendingCandidates.push(candidate)
          }
          return
        }
        await this.waitForOperation(() =>
          this.connection.addIceCandidate(candidate)
        )
      })
    } catch {
      this.setError('share.host.error.candidate')
    }
  }

  /**
   * 观众请求恢复：原地 ICE 重启。
   *
   * 三个前置条件缺一不可（Piik `host-peer.ts:475-486`）：没销毁、没有在飞
   * offer、SDP 处于 stable。否则重启会让状态机从错位的地方继续。
   */
  async restartIce(): Promise<boolean> {
    return this.enqueueNegotiation(async () => {
      if (
        this.disposed ||
        this.ordinaryAnswerEpoch !== null ||
        this.connection.signalingState !== 'stable'
      ) {
        return false
      }
      return this.createOwnedOffer(true, this.nextNegotiationEpoch())
    })
  }

  /** 只改编码参数，不动采集约束。 */
  updateProfile(profile: QualityProfile): Promise<boolean> {
    return this.updateOwnedProfile(profile, false)
  }

  /** 改编码参数并重新下发采集约束（切分辨率档位走这条）。 */
  updateCaptureProfile(profile: QualityProfile): Promise<boolean> {
    return this.updateOwnedProfile(profile, true)
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    this.applyPausedState(
      this.senderVideoTrack,
      this.audioSender?.track ?? null
    )
    this.snapshot = { ...this.snapshot, paused }
    this.emit()
  }

  isConnected(): boolean {
    return this.connection.connectionState === 'connected'
  }

  /** 底层连接，仅供统计面板读取（不要拿它直接操作媒体）。 */
  getConnection(): RTCPeerConnection {
    return this.connection
  }

  getSnapshot(): HostPeerSnapshot {
    return { ...this.snapshot }
  }

  /**
   * 换采集源。
   *
   * 视频没变就只换音频轨（不重协商）；视频变了则 replaceTrack + 重新应用
   * 档位，仍然不重协商。只有音频方向从「有」变「无」这类结构变化才发新
   * offer——那是唯一必须重协商的情况。
   */
  async replaceStream(nextStream: MediaStream): Promise<boolean> {
    const nextSourceVideoTrack = nextStream.getVideoTracks()[0]
    if (this.disposed || !nextSourceVideoTrack) return false

    return this.enqueueSenderMutation(async () => {
      const videoSender = this.videoSender
      const audioSender = this.audioSender
      const audioTransceiver = this.audioTransceiver
      const previousVideoTrack = this.senderVideoTrack
      if (
        this.disposed ||
        !videoSender ||
        !audioSender ||
        !audioTransceiver ||
        !previousVideoTrack
      ) {
        return false
      }

      const videoChanged =
        this.stream.getVideoTracks()[0] !== nextSourceVideoTrack
      const nextVideoTrack = videoChanged
        ? this.cloneVideoTrack(nextSourceVideoTrack)
        : previousVideoTrack
      let retained = false
      const nextAudioTrack = nextStream.getAudioTracks()[0] ?? null
      const nextAudioDirection = nextAudioTrack ? 'sendonly' : 'inactive'
      const audioDirectionChanged =
        audioTransceiver.direction !== nextAudioDirection
      const previousAudioDirection = audioTransceiver.direction
      const previousAudioTrack = audioSender.track

      try {
        try {
          if (videoChanged) {
            await this.waitForOperation(() =>
              videoSender.replaceTrack(nextVideoTrack)
            )
          }
          await this.waitForOperation(() =>
            audioSender.replaceTrack(nextAudioTrack)
          )
          if (nextVideoTrack.readyState === 'ended') {
            throw new Error('replacement video track ended')
          }
          if (audioDirectionChanged) {
            audioTransceiver.direction = nextAudioDirection
          }
        } catch {
          if (this.disposed) return false
          // 回滚：把旧轨放回去，宁可保持旧画面也不留一条断轨。
          await Promise.allSettled([
            videoChanged
              ? this.waitForOperation(() =>
                  videoSender.replaceTrack(previousVideoTrack)
                )
              : Promise.resolve(),
            this.waitForOperation(() =>
              audioSender.replaceTrack(previousAudioTrack)
            ),
          ])
          if (this.disposed) return false
          if (audioDirectionChanged) {
            audioTransceiver.direction = previousAudioDirection
          }
          this.setError('share.host.error.replaceSource')
          return false
        }

        if (this.disposed) return false
        this.senderVideoTrack = nextVideoTrack
        this.stream = nextStream
        retained = true
        if (videoChanged) {
          if (previousVideoTrack !== nextVideoTrack) {
            stopSenderVideoTrack(previousVideoTrack)
          }
          this.startupVideoProfilePending = needsStartupVideoProfile(
            this.desiredProfile
          )
          this.startupFramesBaseline = null
          this.snapshot = { ...this.snapshot, framesEncoded: null }
        }
        await this.configureSender(videoSender, audioSender, {
          profile: startupVideoProfile(this.desiredProfile),
          profileRevision: this.profileRevision,
          video:
            videoChanged && this.connection.connectionState === 'connected',
          audio: true,
        })
        if (this.disposed) return false
        this.snapshot = { ...this.snapshot, error: null }
        this.emit()
        return !audioDirectionChanged || (await this.createOffer())
      } finally {
        if (videoChanged && !retained) {
          stopSenderVideoTrack(nextVideoTrack)
        }
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.lifetime.abort()
    this.nextNegotiationEpoch()
    this.pendingNegotiation = false
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    this.connection.close()
    stopSenderVideoTrack(this.senderVideoTrack)
    this.senderVideoTrack = null
    this.audioTransceiver = null
  }

  // ==================== 内部 ====================

  private bindConnectionEvents(): void {
    this.connection.addEventListener('icecandidate', (event) => {
      // null 表示候选收集结束，我们的线上格式不接受 payload=null。
      if (!event.candidate) return
      this.events.sendSignal({
        kind: 'candidate',
        candidate: event.candidate.toJSON(),
      })
    })
    this.connection.addEventListener('connectionstatechange', () => {
      const state = this.connection.connectionState
      if (state === 'connected') {
        const replayProfile = this.awaitingReconnect
        this.connectedOnce = true
        this.awaitingReconnect = false
        if (replayProfile) {
          // 重连后 sender 参数可能已被浏览器重置，必须重放一次意图。
          this.appliedVideoProfile = null
          this.appliedAudioBitrate = null
          this.appliedAudioSenderParameters = null
        }
        if (replayProfile || !this.startupVideoProfilePending) {
          void this.updateProfile(this.desiredProfile)
        }
      } else if (this.connectedOnce && state !== 'closed') {
        this.awaitingReconnect = true
      }
      this.emit()
    })
    this.connection.addEventListener('iceconnectionstatechange', () =>
      this.emit()
    )
  }

  private cloneVideoTrack(source: MediaStreamTrack): MediaStreamTrack {
    return cloneSenderVideoTrack(source, (track) => {
      if (this.senderVideoTrack === track) this.fail()
    })
  }

  private applyPausedState(
    videoTrack: MediaStreamTrack | null,
    audioTrack: MediaStreamTrack | null
  ): void {
    if (videoTrack) videoTrack.enabled = !this.paused
    if (audioTrack) audioTrack.enabled = !this.paused
  }

  private waitForOperation<T>(operation: () => Promise<T>): Promise<T> {
    return waitForConnectionOperation(this.lifetime.signal, operation)
  }

  private enqueueSenderMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.senderMutationTail.then(operation, operation)
    this.senderMutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private enqueueNegotiation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.negotiationTail.then(operation, operation)
    this.negotiationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private updateOwnedProfile(
    profile: QualityProfile,
    updateCaptureConstraints: boolean
  ): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (!needsStartupVideoProfile(profile)) {
      this.startupVideoProfilePending = false
    }
    const effectiveVideoProfile = this.startupVideoProfilePending
      ? startupVideoProfile(profile)
      : profile
    const changed =
      !videoQualitySettingsEqual(this.desiredProfile, profile) ||
      !audioQualitySettingsEqual(this.desiredProfile, profile)
    this.desiredProfile = profile
    // 恢复链会重放同一份意图，那不是一次新的用户改动，不能推进 revision。
    const requestedRevision = changed
      ? ++this.profileRevision
      : this.profileRevision

    return this.enqueueSenderMutation(async () => {
      const videoSender = this.videoSender
      const audioSender = this.audioSender
      const videoTrack = this.senderVideoTrack
      if (
        this.disposed ||
        !videoSender ||
        !audioSender ||
        !videoTrack ||
        requestedRevision !== this.profileRevision
      ) {
        return false
      }
      if (updateCaptureConstraints) {
        try {
          await this.waitForOperation(() =>
            applyVideoCaptureProfile(videoTrack, profile)
          )
        } catch {
          // 采集约束被浏览器拒（Overconstrained 等）不能连带把编码参数一起
          // 丢掉：帧率/码率的真正上限在 sender 上，继续下发。
          if (this.disposed) return false
        }
        if (
          this.disposed ||
          this.senderVideoTrack !== videoTrack ||
          requestedRevision !== this.profileRevision
        ) {
          return false
        }
      }
      const updateVideo =
        this.connection.connectionState === 'connected' &&
        (this.appliedVideoProfile === null ||
          !videoQualitySettingsEqual(
            this.appliedVideoProfile,
            effectiveVideoProfile
          ))
      const updateAudio =
        this.appliedAudioBitrate !== screenAudioBitrate(profile.maxAudioBitrate)
      if (!updateVideo && !updateAudio) return true
      if (
        !(await this.configureSender(videoSender, audioSender, {
          profile: effectiveVideoProfile,
          profileRevision: requestedRevision,
          video: updateVideo,
          audio: updateAudio,
        }))
      ) {
        return false
      }
      if (this.disposed || requestedRevision !== this.profileRevision)
        return false
      this.snapshot = { ...this.snapshot, error: null }
      this.emit()
      return true
    })
  }

  private configureSender(
    sender: RTCRtpSender,
    audioSender?: RTCRtpSender,
    mutation: {
      profile: QualityProfile
      profileRevision: number
      video: boolean
      audio: boolean
    } = {
      profile: this.desiredProfile,
      profileRevision: this.profileRevision,
      video: true,
      audio: true,
    }
  ): Promise<boolean> {
    return (async () => {
      const { profile, profileRevision } = mutation
      let senderParameters = this.snapshot.senderParameters
      let audioSenderParameters = this.appliedAudioSenderParameters
      let videoSucceeded = true
      let audioSucceeded = true

      if (mutation.video) {
        try {
          senderParameters = await this.waitForOperation(() =>
            configureVideoSender(sender, profile)
          )
        } catch {
          if (this.disposed) return false
          videoSucceeded = false
        }
      }

      if (
        this.disposed ||
        profileRevision !== this.profileRevision ||
        (mutation.video && this.videoSender !== sender)
      ) {
        return false
      }

      if (mutation.audio && audioSender) {
        if (audioSender.track) {
          try {
            audioSenderParameters = await this.waitForOperation(() =>
              configureAudioSender(
                audioSender,
                screenAudioBitrate(profile.maxAudioBitrate)
              )
            )
          } catch {
            if (this.disposed) return false
            audioSucceeded = false
          }
        } else {
          audioSenderParameters = null
        }
      }

      if (
        this.disposed ||
        profileRevision !== this.profileRevision ||
        (mutation.video && this.videoSender !== sender) ||
        (mutation.audio && this.audioSender !== audioSender)
      ) {
        return false
      }
      if (mutation.video && videoSucceeded) this.appliedVideoProfile = profile
      if (mutation.audio && audioSucceeded) {
        this.appliedAudioBitrate = screenAudioBitrate(profile.maxAudioBitrate)
        this.appliedAudioSenderParameters = audioSenderParameters
      }
      this.snapshot = {
        ...this.snapshot,
        senderParameters: senderParameters ?? null,
        audioSenderParameters: this.appliedAudioSenderParameters,
      }
      this.emit()
      return videoSucceeded && audioSucceeded
    })()
  }

  private createOffer(): Promise<boolean> {
    return this.enqueueNegotiation(async () => {
      if (this.disposed) return false
      // 单 offer 在飞：另起一个会让前一个的 answer 消耗掉新纪元。
      // 记下「还需要一轮」，等当前应答处理完在队列内部接力（排队会死锁）。
      if (this.ordinaryAnswerEpoch !== null) {
        this.pendingNegotiation = true
        return true
      }
      return this.createOwnedOffer(false, this.nextNegotiationEpoch())
    })
  }

  private async createOwnedOffer(
    restart: boolean,
    epoch: number
  ): Promise<boolean> {
    if (!this.ownsLocalOffer(epoch)) return false
    if (!restart && this.connection.remoteDescription) {
      this.answerTimer = setTimeout(() => {
        if (this.ownsLocalOffer(epoch)) {
          this.fail()
        }
      }, RENEGOTIATION_ANSWER_TIMEOUT_MS)
    }
    try {
      if (restart) {
        this.connection.restartIce()
      }
      const offer = await this.waitForOperation(() =>
        this.connection.createOffer()
      )
      if (!this.ownsLocalOffer(epoch)) return false
      await this.waitForOperation(() =>
        this.connection.setLocalDescription(offer)
      )
      if (!this.ownsLocalOffer(epoch) || !this.connection.localDescription)
        return false
      this.ordinaryAnswerEpoch = epoch
      if (
        !this.events.sendSignal({
          kind: 'offer',
          description: {
            type: 'offer',
            sdp: normalizeVideoOfferSdp(this.connection.localDescription.sdp),
          },
        })
      ) {
        throw new Error('signal send rejected')
      }
      this.snapshot = { ...this.snapshot, error: null }
      this.emit()
      return true
    } catch {
      if (!this.ownsLocalOffer(epoch)) return false
      if (this.ordinaryAnswerEpoch === epoch) this.ordinaryAnswerEpoch = null
      this.clearAnswerTimer()
      this.setError('share.host.error.negotiation')
      return false
    }
  }

  private async acceptAnswerOwned(
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    const epoch = this.ordinaryAnswerEpoch
    if (epoch === null || !this.ownsAnswer(epoch)) return
    try {
      await this.waitForOperation(() =>
        this.connection.setRemoteDescription(description)
      )
      if (!this.ownsAnswer(epoch)) return
      await this.flushCandidates()
      if (!this.ownsAnswer(epoch)) return
      this.clearAnswerTimer()
      this.ordinaryAnswerEpoch = null
      if (this.pendingNegotiation) {
        this.pendingNegotiation = false
        // 已经在 negotiationTail 里，再排队会死锁，必须直接调用。
        if (
          !(await this.createOwnedOffer(false, this.nextNegotiationEpoch()))
        ) {
          this.fail()
        }
      }
    } catch {
      if (!this.ownsAnswer(epoch)) return
      this.fail()
    }
  }

  private async flushCandidates(): Promise<void> {
    const candidates = this.pendingCandidates.splice(0)
    for (const candidate of candidates) {
      await this.waitForOperation(() =>
        this.connection.addIceCandidate(candidate)
      )
    }
  }

  private ownsAnswer(epoch: number): boolean {
    return (
      !this.disposed &&
      epoch === this.negotiationEpoch &&
      this.ordinaryAnswerEpoch === epoch
    )
  }

  private ownsLocalOffer(epoch: number): boolean {
    return !this.disposed && epoch === this.negotiationEpoch
  }

  private nextNegotiationEpoch(): number {
    this.clearAnswerTimer()
    this.ordinaryAnswerEpoch = null
    this.negotiationEpoch += 1
    return this.negotiationEpoch
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer !== null) clearTimeout(this.answerTimer)
    this.answerTimer = null
  }

  /**
   * 采一次发送统计。
   *
   * 现在只为一件事服务：启动保护要知道「编码了几帧」。P4 会在这里接完整
   * 的质量证据，但采样本身必须是观测性的——采集失败绝不能影响媒体链路。
   */
  private async updateStats(): Promise<void> {
    if (
      this.disposed ||
      this.connection.connectionState === 'closed' ||
      this.statsInFlight
    ) {
      return
    }
    this.statsInFlight = true
    try {
      const report = await this.waitForOperation(() =>
        this.connection.getStats()
      )
      let framesEncoded: number | null = null
      report.forEach((entry) => {
        const stat = entry as RTCStats & {
          type: string
          kind?: string
          framesEncoded?: number
          mediaSourceId?: string
        }
        if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') return
        if (typeof stat.framesEncoded === 'number') {
          framesEncoded = Math.max(framesEncoded ?? 0, stat.framesEncoded)
        }
      })
      if (this.disposed) return
      this.snapshot = { ...this.snapshot, framesEncoded }
      if (this.startupVideoProfilePending && framesEncoded !== null) {
        if (this.startupFramesBaseline === null) {
          this.startupFramesBaseline = framesEncoded
        } else if (
          framesEncoded - this.startupFramesBaseline >=
          STARTUP_VIDEO_ENCODED_FRAMES
        ) {
          // 编码器已经用完整尺寸出了 5 帧，现在才切到用户档位。
          this.startupVideoProfilePending = false
          void this.updateProfile(this.desiredProfile)
        }
      }
      this.emit()
    } catch {
      // 统计是观测性的，不能影响健康的媒体链路。
    } finally {
      this.statsInFlight = false
    }
  }

  private setError(code: string): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, error: code }
    this.emit()
  }

  private fail(): void {
    if (this.disposed) return
    this.snapshot = {
      ...this.snapshot,
      connectionState: 'failed',
      error: 'share.host.error.connection',
    }
    this.dispose()
    // 销毁后还要通知宿主一次：终态失败必须传到恢复/路由负责人手里。
    this.events.onFailed({ ...this.snapshot })
  }

  private emit(): void {
    if (this.disposed) return
    this.snapshot = {
      ...this.snapshot,
      connectionState: this.connection.connectionState,
      iceConnectionState: this.connection.iceConnectionState,
    }
    this.events.onUpdate({ ...this.snapshot })
  }
}
