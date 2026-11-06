/**
 * 观众端播放音量。
 *
 * 移植自 Piik `src/client/media/viewer-audio.ts`（MIT），行为逐条对齐：
 *
 *  1. **用户没动过音量就完全不接 Web Audio**。100% 走原生播放——`<video>`
 *     直接出声，后台标签页、画中画、系统音量键全都不受影响。一旦套上
 *     `MediaElementAudioSourceNode`，音频就改由 AudioContext 播放，后台被
 *     节流时整段静音（一起听那边踩过这个坑，所以默认路径绝不能接图）。
 *     首次调离 100% 时才建图，之后保持接管直到卸载——来回建图会反复抢
 *     音频时钟，比一直走图更容易出杂音。
 *  2. **0–200%**。屏幕共享录的是系统声，浏览器标签页音频往往小到听不清，
 *     而 `video.volume` 上限就是 1，所以超过 100% 必须靠增益节点。
 *  3. **原生与增益互斥**：增益模式下 `video.muted` 恒为 true，出声只走
 *     GainNode，否则同一路声音会被播放两次（响度翻倍且失真）。
 *  4. **失败即降级**：AudioContext 起不来 / 音轨接不上，就把上限压回 100%
 *     退回原生控制，绝不留下「UI 显示 150% 但一点声音都没有」的状态。
 *
 * 静音的真相也放在这里：接管期间 `video.muted` 是被我们强置为 true 的，
 * 界面不能再拿它当「用户是否静音」判断（那是 Piik 的 `snapshot` 存在的原因）。
 */

export interface ViewerAudioSnapshot {
  /** 0–maxLevel，1 表示原始音量。 */
  level: number
  muted: boolean
  /** 是否支持超过 100%（AudioContext 可用）。 */
  boostAvailable: boolean
}

export class ViewerAudio {
  private level = 1
  private muted = false
  private boostAvailable = typeof AudioContext !== 'undefined'
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private track: MediaStreamTrack | null = null
  private disposed = false

  private readonly video: HTMLVideoElement
  private readonly onChange: (snapshot: ViewerAudioSnapshot) => void
  /** 增益上限；2 = 200%。 */
  private readonly maxLevel: number
  /** 建上下文的入口；测试注入假 AudioContext，生产走默认的 new。 */
  private readonly createContext: (() => AudioContext) | null

  constructor(
    video: HTMLVideoElement,
    onChange: (snapshot: ViewerAudioSnapshot) => void,
    maxLevel = 2,
    createContext?: () => AudioContext
  ) {
    this.video = video
    this.onChange = onChange
    this.maxLevel = maxLevel
    this.createContext = createContext ?? null
    this.boostAvailable =
      typeof AudioContext !== 'undefined' || this.createContext !== null
    this.level = video.volume
    this.muted = video.muted
    video.addEventListener('play', this.onPlay)
    video.addEventListener('volumechange', this.onNativeVolume)
    for (const event of ['pause', 'ended']) {
      video.addEventListener(event, this.sync)
    }
    onChange(this.snapshot)
  }

  get snapshot(): ViewerAudioSnapshot {
    return {
      level: this.level,
      muted: this.muted,
      boostAvailable: this.boostAvailable,
    }
  }

  /** 绑定远端流；换流只换源节点，不动 GainNode 与状态。 */
  bind(stream: MediaStream | null): void {
    if (this.disposed) return
    const track = stream?.getAudioTracks()[0] ?? null
    if (track !== this.track) {
      this.track = track
      this.bindSource()
    }
    this.sync()
  }

  setLevel(level: number): void {
    if (this.disposed || !Number.isFinite(level)) return
    this.level = Math.max(
      0,
      Math.min(this.boostAvailable ? this.maxLevel : 1, level)
    )
    // 只有真正偏离 100% 时才建图：默认路径必须保持原生播放。
    if (this.level !== 1 && this.boostAvailable && !this.context) {
      try {
        this.context = this.createContext
          ? this.createContext()
          : new AudioContext()
        this.gain = this.context.createGain()
        this.gain.gain.value = 0
        this.gain.connect(this.context.destination)
        this.context.addEventListener('statechange', this.sync)
        this.bindSource()
      } catch {
        this.disableBoost()
      }
    }
    this.resume()
    this.sync()
    this.onChange(this.snapshot)
  }

  setMuted(muted: boolean): void {
    if (this.disposed) return
    this.muted = muted
    // 取消静音本身就是用户手势，顺手把被挂起的上下文拉起来。
    if (!muted) this.resume()
    this.sync()
    this.onChange(this.snapshot)
  }

  resume(): void {
    const context = this.context
    if (this.disposed || !context || context.state === 'running') return
    void context.resume().then(
      () => {
        if (this.context === context) this.sync()
      },
      () => {
        if (this.context === context) this.disableBoost()
      }
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.video.removeEventListener('play', this.onPlay)
    this.video.removeEventListener('volumechange', this.onNativeVolume)
    for (const event of ['pause', 'ended']) {
      this.video.removeEventListener(event, this.sync)
    }
    this.releaseGraph()
    this.video.volume = Math.min(this.level, 1)
    this.video.muted = this.muted
  }

  private bindSource(): void {
    this.source?.disconnect()
    this.source = null
    if (!this.context || !this.gain || !this.track) return
    try {
      // createMediaStreamSource 会记住当时那条轨：换流必须重建源节点，
      // 只换 MediaStream 里的 track 不会生效。
      this.source = this.context.createMediaStreamSource(
        new MediaStream([this.track])
      )
      this.source.connect(this.gain)
    } catch {
      this.disableBoost()
    }
  }

  /** 把「用户意图」翻译成元素属性与增益值。任何状态变化最后都落到这里。 */
  private readonly sync = (): void => {
    if (this.disposed) return
    const boosted = this.context?.state === 'running' && this.source !== null
    if (this.gain) {
      this.gain.gain.value =
        boosted && !this.muted && !this.video.paused && !this.video.ended
          ? this.level
          : 0
    }
    this.video.volume = Math.min(this.level, 1)
    // 增益模式下必须让元素本身静音，否则同一路声音会播两次。
    this.video.muted = this.muted || this.level === 0 || boosted
  }

  private readonly onPlay = (): void => {
    this.resume()
    this.sync()
  }

  /**
   * 原生静音/音量被外部改掉（自动播放策略回退、系统音量键、画中画控件）。
   *
   * 增益模式下这些变化必须忽略：那里的 `muted` 是我们自己置的 true，
   * 当真去同步会立刻把用户意图改成「静音」。
   */
  private readonly onNativeVolume = (): void => {
    if (this.disposed || this.context) return
    const { volume, muted } = this.video
    // sync() 自己也会写零音量，它排队的 volumechange 不算用户操作。
    if (this.level === volume && (this.muted || this.level === 0) === muted) {
      return
    }
    this.level = volume
    this.muted = muted
    this.onChange(this.snapshot)
  }

  private disableBoost(): void {
    this.boostAvailable = false
    this.releaseGraph()
    this.level = Math.min(this.level, 1)
    this.sync()
    this.onChange(this.snapshot)
  }

  private releaseGraph(): void {
    this.source?.disconnect()
    this.source = null
    this.gain?.disconnect()
    this.gain = null
    const context = this.context
    this.context = null
    if (context) {
      context.removeEventListener('statechange', this.sync)
      void context.close().catch(() => undefined)
    }
  }
}
