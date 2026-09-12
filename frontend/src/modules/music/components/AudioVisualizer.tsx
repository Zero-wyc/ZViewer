/**
 * 音频可视化（Hydrogen components/AudioVisualizer.vue 的 React 复刻）。
 *
 * 规格对齐 Hydrogen：
 * - 57 根 3px 竖条（DOM，scaleY 渲染），FFT 128、smoothing 0.8、
 *   静态基线 0.08、Uint8 归一化；低频 bins 取模复用
 * - 连接：captureStream() + 独立 AudioContext 旁路 tap（Hydrogen
 *   getMediaStreamAnalyser 同思路）——不创建 MediaElementSource，
 *   不劫持主播放链的输出，与 audio.volume/预载升格完全解耦
 * - attach 失败重试（250ms × 16）、停滞重连（连续 72 全空帧 + 1.2s 冷却）、
 *   暂停缓动收尾（*0.42 衰减到基线后自停 rAF）、主元素替换自动重连
 * - 卸载关闭自建 AudioContext 防泄漏
 */
import { useEffect, useRef, useState } from 'react'

/** 条数 / 分析器参数（与 Hydrogen 常量一致） */
const BAR_COUNT = 57
const BAR_WIDTH = 3
const DEFAULT_BAR_GAP = 2
const ANALYSER_FFT_SIZE = 128
const ANALYSER_SMOOTHING = 0.8
const FLAT_LEVEL = 0.08
const FREQUENCY_VALUE_SCALE = 256
/** 空帧重连参数（Hydrogen 同值） */
const EMPTY_ANALYSER_FRAME_LIMIT = 72
const ANALYSER_REATTACH_COOLDOWN_MS = 1200

type CaptureCapableMedia = HTMLMediaElement & {
  captureStream?: () => MediaStream
  mozCaptureStream?: () => MediaStream
}

interface AnalyserRig {
  ctx: AudioContext
  analyser: AnalyserNode
  data: Uint8Array<ArrayBuffer>
}

function createFlatLevels(): number[] {
  return Array.from({ length: BAR_COUNT }, () => FLAT_LEVEL)
}

export function AudioVisualizer({
  getAudio,
  playing,
  className,
}: {
  /** 获取当前主音频元素（预载升格时会被替换，按元素感知重连） */
  getAudio: () => HTMLAudioElement | null
  /** 是否正在播放（暂停时缓动收尾到基线） */
  playing: boolean
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [levels, setLevels] = useState<number[]>(createFlatLevels)
  const [barGap, setBarGap] = useState(DEFAULT_BAR_GAP)

  const playingRef = useRef(playing)
  const getAudioRef = useRef(getAudio)

  // prop → ref 同步（在 effect 中更新，避免渲染期写 ref）
  useEffect(() => {
    playingRef.current = playing
  }, [playing])
  useEffect(() => {
    getAudioRef.current = getAudio
  }, [getAudio])

  // 主引擎（挂载一次）：rAF 循环 + analyser 生命周期全在 effect 作用域内
  useEffect(() => {
    let raf = 0
    let attachTimer: ReturnType<typeof setTimeout> | null = null
    let rig: AnalyserRig | null = null
    let attachedElement: HTMLAudioElement | null = null
    let emptyFrames = 0
    let lastReattachAt = 0
    let latestLevels: number[] = createFlatLevels()

    /** 断开当前 rig（ analyser/element；AudioContext 停用后复用） */
    const resetRig = () => {
      rig = null
      attachedElement = null
      emptyFrames = 0
    }

    /** attach 失败重试（Hydrogen 同参数） */
    const scheduleRetryAttach = () => {
      if (attachTimer) return
      attachTimer = setTimeout(() => {
        attachTimer = null
        attachAnalyser()
      }, 250)
    }

    /** captureStream 旁路 tap：当前主元素 → 独立 AudioContext → analyser */
    const resumeCtx = () => {
      if (rig && rig.ctx.state === 'suspended') {
        void rig.ctx.resume().catch(() => {})
      }
    }
    const attachAnalyser = () => {
      const el = getAudioRef.current()
      if (!el || el === attachedElement) return
      const captureEl = el as CaptureCapableMedia
      const capture =
        captureEl.captureStream?.bind(el) ??
        captureEl.mozCaptureStream?.bind(el)
      if (!capture) {
        scheduleRetryAttach()
        return
      }
      let stream: MediaStream
      try {
        stream = capture()
      } catch {
        scheduleRetryAttach()
        return
      }
      const tracks = stream ? stream.getAudioTracks() : []
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      if (!stream || tracks.length === 0 || !Ctor) {
        scheduleRetryAttach()
        return
      }
      resumeCtx()
      if (!rig) {
        try {
          const ctx = new Ctor()
          const analyser = ctx.createAnalyser()
          analyser.fftSize = ANALYSER_FFT_SIZE
          analyser.smoothingTimeConstant = ANALYSER_SMOOTHING
          const source = ctx.createMediaStreamSource(stream)
          source.connect(analyser)
          rig = {
            ctx,
            analyser,
            data: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
          }
          // 新建后同样唤醒（无手势上下文创建时会挂起，静音数据主因）
          resumeCtx()
        } catch {
          scheduleRetryAttach()
          return
        }
      }
      attachedElement = el
    }

    /** 从 analyser 构建 57 条电平（全空判定 null → 停滞重连） */
    const buildLevels = (): number[] | null => {
      if (!rig) return null
      try {
        rig.analyser.getByteFrequencyData(rig.data)
      } catch {
        resetRig()
        return null
      }
      const next: number[] = []
      let total = 0
      for (let i = 0; i < BAR_COUNT; i++) {
        const value = rig.data[i % rig.data.length] / FREQUENCY_VALUE_SCALE
        const level = Math.max(FLAT_LEVEL, value)
        total += level
        next.push(level)
      }
      if (total / BAR_COUNT < FLAT_LEVEL + 0.015) return null
      return next
    }

    /** 停滞重连（Hydrogen reattachStaleAnalyser） */
    const maybeReattachStale = (): boolean => {
      if (!playingRef.current) {
        emptyFrames = 0
        return false
      }
      emptyFrames += 1
      if (emptyFrames < EMPTY_ANALYSER_FRAME_LIMIT) return false
      const now = Date.now()
      if (now - lastReattachAt < ANALYSER_REATTACH_COOLDOWN_MS) return false
      lastReattachAt = now
      resetRig()
      attachAnalyser()
      return true
    }

    /** 暂停缓动收尾（Hydrogen settleFlat：*0.42 衰减回基线） */
    const settleFlat = (): boolean => {
      let stillSettling = false
      const next = latestLevels.map((level) => {
        const delta = FLAT_LEVEL - level
        if (Math.abs(delta) <= 0.001) return FLAT_LEVEL
        const nextLevel = level + delta * 0.42
        if (Math.abs(FLAT_LEVEL - nextLevel) > 0.001) stillSettling = true
        return nextLevel
      })
      latestLevels = next
      setLevels(next)
      return stillSettling
    }

    const drawFrame = () => {
      if (!playingRef.current) {
        emptyFrames = 0
        if (settleFlat()) {
          raf = requestAnimationFrame(drawFrame)
        } else {
          raf = 0
        }
        return
      }
      // 主元素被替换（预载升格）→ 重挂；无 analyser → 尝试 attach
      const el = getAudioRef.current()
      if (el && el !== attachedElement) {
        resetRig()
        attachAnalyser()
      }
      // 持续唤醒兜底（resume 需用户手势上下文；播放本身即手势驱动）
      resumeCtx()
      const next = buildLevels()
      if (next) {
        emptyFrames = 0
        latestLevels = next
        setLevels(next)
      } else {
        maybeReattachStale()
        if (!rig && !attachTimer) attachAnalyser()
      }
      raf = requestAnimationFrame(drawFrame)
    }

    // 容器宽 → 条间距（ResizeObserver，Hydrogen updateBarGap）
    const ro = new ResizeObserver(() => {
      const el = rootRef.current
      if (!el) return
      const width = el.getBoundingClientRect().width
      if (!width) return
      const gap = (width - BAR_COUNT * BAR_WIDTH) / Math.max(1, BAR_COUNT - 1)
      setBarGap(Math.max(1, Math.round(gap * 1000) / 1000))
    })
    if (rootRef.current) ro.observe(rootRef.current)

    raf = requestAnimationFrame(drawFrame)

    return () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      if (attachTimer) {
        clearTimeout(attachTimer)
        attachTimer = null
      }
      ro.disconnect()
      rig?.ctx.close().catch(() => {})
      rig = null
      attachedElement = null
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className={`inline-flex h-[22px] items-center ${className ?? ''}`}
      style={{ gap: `${barGap}px` }}
      aria-hidden="true"
    >
      {levels.map((level, i) => (
        <span
          key={i}
          className="block w-[3px] min-w-[3px] self-stretch rounded-[1px] opacity-60"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            transform: `scaleY(${level})`,
          }}
        />
      ))}
    </div>
  )
}
