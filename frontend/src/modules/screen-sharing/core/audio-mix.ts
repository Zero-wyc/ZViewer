/**
 * 房主侧音频混流：系统声 + 可选麦克风 → 一条稳定的输出音轨。
 *
 * 为什么必须合成一条：Piik 之前 ZViewer 是把系统声与麦克风当两条独立音轨
 * 加进 PC。双音轨在浏览器侧是两条独立 RTP 流，观众端要自己混，音量平衡、
 * 静音、暂停三处都要分别处理，而且任一条轨换设备就要重协商。
 *
 * 现在的结构照搬 Piik `media/host-audio.ts`：
 *  - 一条 MediaStreamAudioDestination 输出轨，输入可以是系统声、麦克风或两者；
 *  - 输入变化（换源、开关麦克风）只改音频图内部连线，**不替换传输用的输出轨**；
 *  - 音频图起不来是可接受的降级：退回原始流的音轨，画面照常共享。
 */

import { audioInputConstraints } from './capture-options'

/** 讲话（麦克风）输入设置。 */
export interface CommentaryInput {
  deviceId: string
  volume: number
  voiceProcessing: boolean
}

/**
 * 把一路麦克风接到音频图里，并给它独立的增益。
 *
 * 单独成类是因为「换设备」要做的是拆掉这一路、重建这一路，而不是重建
 * 整个音频图——输出轨必须保持不变。
 */
class MicrophoneInput {
  readonly stream: MediaStream
  private readonly captured: MediaStream
  private readonly gain: GainNode
  private closed = false

  constructor(
    captured: MediaStream,
    context: AudioContext,
    volume: number,
    ended: () => void
  ) {
    this.captured = captured
    this.gain = context.createGain()
    this.gain.gain.value = volume
    const source = context.createMediaStreamSource(captured)
    const destination = context.createMediaStreamDestination()
    source.connect(this.gain)
    this.gain.connect(destination)
    this.stream = destination.stream
    const outputTrack = this.stream.getAudioTracks()[0]
    if (outputTrack) outputTrack.contentHint = 'speech'
    const inputTrack = captured.getAudioTracks()[0]
    if (inputTrack) inputTrack.onended = ended
  }

  /** 节点入口，供外部接到混音总线。 */
  get output(): GainNode {
    return this.gain
  }

  volume(value: number): void {
    this.gain.gain.setTargetAtTime(value, this.gain.context.currentTime, 0.01)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.captured.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    this.stream.getTracks().forEach((track) => track.stop())
    this.gain.disconnect()
  }
}

/**
 * 音频混流器。
 *
 * 生命周期：`start()` 建图并返回输出流，之后 `attach()` 换源、
 * `setMicrophone()` 开关麦、`dispose()` 全拆。任何时刻只有一个输出音轨。
 */
export class HostAudio {
  private context: AudioContext | null = null
  private destination: MediaStreamAudioDestinationNode | null = null
  /** 系统声的增益（给「共享声音音量」用）。 */
  private gain: GainNode | null = null
  private volume = 1
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private microphone: MicrophoneInput | null = null
  private microphoneNode: GainNode | null = null
  private microphoneRequest = 0
  private closed = false
  private source: MediaStream
  private readonly availabilityChanged: (available: boolean) => void
  private readonly microphoneChanged: (enabled: boolean) => void

  constructor(
    source: MediaStream,
    availabilityChanged: (available: boolean) => void = () => {},
    microphoneChanged: (enabled: boolean) => void = () => {}
  ) {
    this.source = source
    this.availabilityChanged = availabilityChanged
    this.microphoneChanged = microphoneChanged
    this.watchSource()
  }

  get sourceStream(): MediaStream {
    return this.source
  }

  get sourceAudioAvailable(): boolean {
    return this.source
      .getAudioTracks()
      .some((track) => track.readyState === 'live')
  }

  get audioAvailable(): boolean {
    return this.sourceAudioAvailable || this.microphone !== null
  }

  get commentaryAvailable(): boolean {
    return this.context !== null && this.destination !== null
  }

  /** 传输用的输出流：源视频轨 + 混好的音频轨。 */
  private output(): MediaStream {
    if (!this.destination) return this.source
    return new MediaStream([
      ...this.source.getVideoTracks(),
      ...this.destination.stream.getAudioTracks(),
    ])
  }

  /**
   * 建图并返回输出流。
   *
   * 即使选中的画面没有声音也要先装一条音轨：传输上的音轨集合一旦确定，
   * 中途「突然有声音了」就必须重协商，而观众端会把它当成一次新连接。
   */
  async start(): Promise<MediaStream> {
    try {
      const context = new AudioContext()
      this.context = context
      this.destination = context.createMediaStreamDestination()
      const outputTrack = this.destination.stream.getAudioTracks()[0]
      if (outputTrack) outputTrack.contentHint = 'music'
      this.gain = context.createGain()
      this.gain.gain.value = this.volume
      this.gain.connect(this.destination)
      this.connectSource()
      await context.resume()
    } catch {
      // 音频图起不来是可降级故障：保留原始流的音轨，画面继续共享。
      this.closeGraph()
    }
    if (this.closed) throw new Error('shared audio stopped')
    return this.output()
  }

  /** 换采集源：重新连输入，输出轨不变。 */
  attach(source: MediaStream): MediaStream {
    const previous = this.source
    this.unwatchSource()
    this.source = source
    this.watchSource()
    this.connectSource()
    this.reportAvailability()
    if (previous !== source) {
      previous.getAudioTracks().forEach((track) => track.stop())
    }
    return this.output()
  }

  /** 开/关麦克风。`enabled=false` 只是拆链路，不关输出轨。 */
  async setMicrophone(
    enabled: boolean,
    settings: CommentaryInput
  ): Promise<void> {
    const request = ++this.microphoneRequest
    if (!enabled) {
      this.clearMicrophone()
      return
    }
    if (!this.context || !this.destination || this.closed) {
      throw new Error('shared audio unavailable')
    }
    const context = this.context
    let stream: MediaStream | undefined
    let input: MicrophoneInput | undefined
    try {
      const resumed = context.resume().then(
        () => true,
        () => false
      )
      await context.resume()
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...audioInputConstraints(settings.voiceProcessing),
          ...(settings.deviceId
            ? { deviceId: { exact: settings.deviceId } }
            : {}),
        },
        video: false,
      })
      if (!(await resumed)) throw new Error('microphone audio could not start')
      if (this.closed || request !== this.microphoneRequest) return
      if (
        !stream.getAudioTracks().some((track) => track.readyState === 'live')
      ) {
        throw new Error('no live microphone')
      }
      input = new MicrophoneInput(stream, context, settings.volume, () => {
        if (this.microphone === input) {
          this.microphoneRequest += 1
          this.clearMicrophone()
        }
      })
      const node = input.output
      node.connect(this.gain!)
      const previousInput = this.microphone
      const previousNode = this.microphoneNode
      this.microphone = input
      this.microphoneNode = node
      previousNode?.disconnect()
      previousInput?.close()
      this.microphoneChanged(true)
      this.reportAvailability()
    } catch (error) {
      input?.close()
      throw error
    } finally {
      if (!input) {
        stream?.getTracks().forEach((track) => track.stop())
      }
    }
  }

  microphoneVolume(value: number): void {
    this.microphone?.volume(value)
  }

  /** 系统声音量（0..1）。 */
  setVolume(volume: number): void {
    this.volume = volume
    this.gain?.gain.setTargetAtTime(volume, this.context!.currentTime, 0.01)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.microphoneRequest += 1
    this.unwatchSource()
    this.clearMicrophone()
    this.closeGraph()
    this.source.getAudioTracks().forEach((track) => track.stop())
  }

  private clearMicrophone(): void {
    this.microphoneNode?.disconnect()
    this.microphoneNode = null
    this.microphone?.close()
    this.microphone = null
    this.microphoneChanged(false)
    this.reportAvailability()
  }

  private closeGraph(): void {
    this.sourceNode?.disconnect()
    this.sourceNode = null
    this.gain?.disconnect()
    this.gain = null
    this.destination?.stream.getTracks().forEach((track) => track.stop())
    this.destination = null
    void this.context?.close().catch(() => undefined)
    this.context = null
  }

  private connectSource(): void {
    this.sourceNode?.disconnect()
    this.sourceNode = null
    if (
      this.context &&
      this.destination &&
      this.gain &&
      this.sourceAudioAvailable
    ) {
      this.sourceNode = this.context.createMediaStreamSource(this.source)
      this.sourceNode.connect(this.gain)
    }
  }

  private reportAvailability = (): void => {
    this.availabilityChanged(this.audioAvailable)
  }

  private watchSource(): void {
    this.source
      .getAudioTracks()
      .forEach((track) =>
        track.addEventListener('ended', this.reportAvailability)
      )
  }

  private unwatchSource(): void {
    this.source
      .getAudioTracks()
      .forEach((track) =>
        track.removeEventListener('ended', this.reportAvailability)
      )
  }
}
