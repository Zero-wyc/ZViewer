import { useEffect, useRef, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { t } from '@/i18n'
import { cn } from '@/lib/utils'
import { FACE_OUTLINE, type FaceLandmark } from '../core/face-pose'
import type { FacePreviewFrame, FaceTracker } from '../core/face-tracker'

// 摄像头动捕的监视窗。
//
// 为什么需要它：动捕是**看不见的输入**。用户开了开关之后，唯一的反馈是
// 「模型跟着动了」——而模型可能在画面外、可能被别的浮层挡住、可能是模型本身
// 对这些参数没绑定。这时用户无法区分「摄像头没拍到我」和「功能坏了」，
// 只能反复开关。这里把检测器算出的**面部骨架**（脸/眉/眼/嘴轮廓 + 注视点）
// 以及每一路通道的当前值直接摆出来，一眼就能定位是哪一段断了。
//
// 为什么不画摄像头画面：画面只对本机有意义，还让窗口变得像「在拍我」；
// 骨架已经携带全部动捕信息（头朝向、张闭眼、嘴型、眉毛），少一路视频
// 解码到 canvas 的开销，也更不侵犯隐私感。
//
// 性能约束：这一层每帧都在跑（摄像头 15Hz、绘制 60Hz），**不能进 React state**。
// 画面与数值条都用 ref 直接写 DOM，只有「状态文案」这种低频变化才 setState。

export interface Live2DFaceMonitorProps {
  tracker: FaceTracker
  onRecalibrate: () => void
  onClose: () => void
}

/** 监视窗里展示的通道。顺序与上行 payload 无关，只按「用户最想看的」排。 */
const CHANNELS = [
  { key: 'mouth', label: '嘴' },
  { key: 'eyes', label: '眼' },
  { key: 'form', label: '笑' },
  { key: 'brow', label: '眉' },
  { key: 'roll', label: '歪头' },
] as const

type ChannelKey = (typeof CHANNELS)[number]['key']
type MonitorStatus = 'calibrating' | 'tracking' | 'no-face'

export function Live2DFaceMonitor({
  tracker,
  onRecalibrate,
  onClose,
}: Live2DFaceMonitorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const barRefs = useRef(new Map<ChannelKey, HTMLDivElement>())
  const [status, setStatus] = useState<MonitorStatus>('calibrating')

  useEffect(() => {
    let raf = 0
    let lastStatus: MonitorStatus | '' = ''
    let lastPainted = 0

    const paint = (frame: FacePreviewFrame) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)

      const marks = frame.landmarks
      if (!marks) {
        // 没有骨架时给一个低调的占位脸型：让「等检测」和「窗口坏了」一眼可分
        ctx.save()
        ctx.setLineDash([4, 5])
        ctx.lineWidth = Math.max(1, w / 176)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
        ctx.beginPath()
        ctx.ellipse(w / 2, h / 2, w / 5, h / 3, 0, 0, TAU)
        ctx.stroke()
        ctx.restore()
        return
      }
      // 坐标一律镜像：和照镜子一致，用户抬左手，骨架也是左边动
      ctx.lineWidth = Math.max(1.5, w / 132)
      ctx.strokeStyle = 'rgba(126, 240, 190, 0.95)'
      ctx.beginPath()
      for (const group of [
        FACE_OUTLINE.FACE,
        FACE_OUTLINE.BROW_LEFT,
        FACE_OUTLINE.BROW_RIGHT,
        FACE_OUTLINE.EYE_LEFT,
        FACE_OUTLINE.EYE_RIGHT,
        FACE_OUTLINE.MOUTH,
      ]) {
        tracePolyline(ctx, marks, group, w, h)
      }
      ctx.stroke()
      // 鼻尖画一个小十字，注视方向直接看鼻尖相对两眼的位置
      const nose = marks[1]
      if (nose) {
        const x = (1 - nose.x) * w
        const y = nose.y * h
        const r = Math.max(2.5, w / 56)
        ctx.strokeStyle = 'rgba(255, 214, 102, 0.95)'
        ctx.lineWidth = Math.max(1, w / 176)
        ctx.beginPath()
        ctx.moveTo(x - r, y)
        ctx.lineTo(x + r, y)
        ctx.moveTo(x, y - r)
        ctx.lineTo(x, y + r)
        ctx.stroke()
      }
      // 两眼中心加亮一点，与鼻尖一起构成「检测器认为我在看哪」的三角
      ctx.fillStyle = 'rgba(255, 214, 102, 0.95)'
      for (const index of [33, 263]) {
        const mark = marks[index]
        if (!mark) continue
        ctx.beginPath()
        ctx.arc((1 - mark.x) * w, mark.y * h, Math.max(1.5, w / 90), 0, TAU)
        ctx.fill()
      }
    }

    const tick = () => {
      raf = requestAnimationFrame(tick)
      const frame = tracker.getPreview()
      const now = performance.now()
      // 画面跟着检测频率走（~15fps）就够了：摄像头本身也只有这么多新帧，
      // 用 60fps 重绘同一张图只是白烧 GPU
      if (now - lastPainted >= 60) {
        lastPainted = now
        paint(frame)
        const pose = tracker.getPose()
        writeBars(barRefs.current, pose)
      }
      const next: MonitorStatus = !frame.hasFace
        ? 'no-face'
        : frame.calibrating
          ? 'calibrating'
          : 'tracking'
      if (next !== lastStatus) {
        lastStatus = next
        setStatus(next)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [tracker])

  const statusText =
    status === 'tracking'
      ? t('动捕中')
      : status === 'calibrating'
        ? t('正在标定，请正对镜头')
        : t('未检测到人脸')

  return (
    <div
      className="glass-card w-[176px] overflow-hidden rounded-xl shadow-lg"
      style={{
        backgroundColor: 'var(--glass-bg)',
        border: '1px solid var(--md-sys-color-outline-variant)',
      }}
    >
      <div className="relative">
        <canvas
          ref={canvasRef}
          width={352}
          height={264}
          className="block h-[132px] w-full"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        />
        <button
          type="button"
          onClick={onClose}
          aria-label={t('关闭动捕预览')}
          title={t('关闭动捕预览')}
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-white/80 transition-colors hover:bg-black/40 hover:text-white"
        >
          <X className="h-3 w-3" />
        </button>
        {/* 画面是黑底，状态文字一律白字，不跟随主题 */}
        <div className="absolute bottom-1 left-1.5 flex items-center gap-1 text-[10px] text-white/85">
          <span
            className={cn(
              'inline-block h-1.5 w-1.5 rounded-full',
              status === 'tracking'
                ? 'bg-emerald-400'
                : status === 'calibrating'
                  ? 'bg-amber-400'
                  : 'bg-rose-400'
            )}
          />
          <span className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
            {statusText}
          </span>
        </div>
      </div>

      <div className="space-y-1 px-2 py-1.5">
        {CHANNELS.map((channel) => (
          <div key={channel.key} className="flex items-center gap-1.5">
            <span
              className="w-10 shrink-0 overflow-hidden whitespace-nowrap text-[10px] leading-none"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              {t(channel.label)}
            </span>
            <div
              className="h-1 flex-1 overflow-hidden rounded-full"
              style={{
                // 轨道用中性半透明灰：主题里的 surface 系偏蓝，和 primary 填充
                // 只差一个色阶，有人脸时一眼分不清哪里是"已填充"
                background: 'rgba(128, 128, 128, 0.22)',
              }}
            >
              <div
                ref={(el) => {
                  if (el) barRefs.current.set(channel.key, el)
                  else barRefs.current.delete(channel.key)
                }}
                className="h-full w-full origin-left rounded-full"
                style={{
                  background: 'var(--md-sys-color-primary)',
                  transform: 'scaleX(0)',
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onRecalibrate}
        className="flex w-full items-center justify-center gap-1 border-t px-2 py-1 text-[10px] transition-colors hover:bg-black/5"
        style={{
          borderColor: 'var(--md-sys-color-outline-variant)',
          color: 'var(--md-sys-color-on-surface-variant)',
        }}
      >
        <RotateCcw className="h-3 w-3" />
        {t('重新标定')}
      </button>
    </div>
  )
}

const TAU = Math.PI * 2

/** 把一组下标连成折线（镜像后的坐标）。 */
function tracePolyline(
  ctx: CanvasRenderingContext2D,
  marks: readonly FaceLandmark[],
  group: readonly number[],
  w: number,
  h: number
): void {
  let started = false
  for (const index of group) {
    const mark = marks[index]
    if (!mark || !Number.isFinite(mark.x) || !Number.isFinite(mark.y)) {
      started = false
      continue
    }
    const x = (1 - mark.x) * w
    const y = mark.y * h
    if (!started) {
      ctx.moveTo(x, y)
      started = true
    } else {
      ctx.lineTo(x, y)
    }
  }
}

/**
 * 把当前姿态写进数值条。
 *
 * 用 scaleX 而不是 width：改 width 会触发布局（每帧 5 条 × 60fps），
 * transform 只在合成层做，代价可以忽略。
 */
function writeBars(
  bars: Map<ChannelKey, HTMLDivElement>,
  pose: {
    mouth: number
    eyes: number
    form: number
    brow: number
    roll: number
  } | null
): void {
  // 没人脸时全部清零：条子停在最后一位的姿态比空着更让人困惑，
  // 「五条全空」是一眼就能读懂的「没有信号」。
  const values: Record<ChannelKey, number> = pose
    ? {
        mouth: pose.mouth,
        eyes: pose.eyes,
        // 本地是 -1~1，条子上按「偏离中性的幅度」显示（0.5 为半满）
        form: pose.form / 2 + 0.5,
        brow: pose.brow / 2 + 0.5,
        roll: pose.roll / 2 + 0.5,
      }
    : { mouth: 0, eyes: 0, form: 0, brow: 0, roll: 0 }

  for (const channel of CHANNELS) {
    const el = bars.get(channel.key)
    if (!el) continue
    const value = Math.min(1, Math.max(0, values[channel.key]))
    el.style.transform = `scaleX(${value.toFixed(3)})`
  }
}
