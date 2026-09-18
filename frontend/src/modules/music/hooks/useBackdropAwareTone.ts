/**
 * 逐按钮背景感知色（歌词页工具栏深浅色自适应）。
 *
 * 周期采样背景画面（视频当前帧优先、封面兜底），对 scope 子树内每个
 * [data-bg-tone] 元素按其自身矩形对应的背景区域计算平均亮度，命令式写入
 * 元素级 CSS 变量（--md-sys-color-on-surface / -variant / --lt-tone-inverse）
 * ——按钮内所有 color/fill 的 var() 引用自动跟随各自背后的画面明暗，
 * 无需逐按钮改写颜色表达式，也天然支持按钮的条件显隐（每轮扫描现查 DOM）。
 *
 * 亮度 → tone：超过阈值视为亮背景（用深色内容 dark），否则浅色内容 light；
 * 带 ±滞后带防止画面亮度在阈值附近时按钮颜色反复跳变。hidden 标签页跳过
 * 采样（timer 被浏览器节流时无从采样，恢复前台后下一轮立即跟上）。
 */
import { useEffect, type RefObject } from 'react'

/** 采样画布边长：亮度是低频统计量，64×64 足够（按钮块约 4-8px 见方） */
const CANVAS_SIZE = 64
/** 亮度 → 内容深浅阈值（与旧整条工具栏自适应同值） */
const LUMINANCE_THRESHOLD = 0.55
/** 滞后带：切换 tone 需越过阈值 ± 该值，防边界闪烁 */
const LUMINANCE_HYSTERESIS = 0.06
/** 采样周期（毫秒）：视频画面是连续变化的，300ms 已是视觉上的「实时」 */
const SAMPLE_INTERVAL_MS = 300
/** 背景静止（无视频或视频暂停）时的降频采样周期：画面帧不变，
 * 布局变化（弹窗开合/滚动/resize）低频，1s 轮询足够跟上 */
const IDLE_SAMPLE_INTERVAL_MS = 1000

/** 浅/深内容三件套：[on-surface, on-surface-variant, inverse（徽章文字）] */
const TONE_COLORS: Record<'light' | 'dark', [string, string, string]> = {
  dark: ['#1c1c1c', 'rgba(0, 0, 0, 0.5)', '#ffffff'],
  light: ['#ffffff', 'rgba(255, 255, 255, 0.5)', '#1c1c1c'],
}

/** 模块级共享采样画布（组件多实例/重挂不重复创建） */
let sharedCanvas: HTMLCanvasElement | null = null
function getToneCanvas(): HTMLCanvasElement | null {
  if (sharedCanvas) return sharedCanvas
  try {
    sharedCanvas = document.createElement('canvas')
    sharedCanvas.width = CANVAS_SIZE
    sharedCanvas.height = CANVAS_SIZE
    return sharedCanvas
  } catch {
    return null
  }
}

/**
 * 源画面按 object-fit 显示在其自身 rect 上时，把可见内容画满采样画布。
 * 亮度是低频统计量，纵横比拉伸不影响区域平均值，故容器比例不参与映射。
 */
function drawFitted(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement | HTMLImageElement,
  srcW: number,
  srcH: number,
  fit: 'cover' | 'contain' | 'fill'
): void {
  if (srcW <= 0 || srcH <= 0) return
  const c = CANVAS_SIZE
  if (fit === 'fill') {
    ctx.drawImage(src as CanvasImageSource, 0, 0, c, c)
    return
  }
  if (fit === 'cover') {
    // 裁剪居中：把源画面中可见的中央区域画满画布
    const scale = Math.max(c / srcW, c / srcH)
    const sw = c / scale
    const sh = c / scale
    ctx.drawImage(
      src as CanvasImageSource,
      (srcW - sw) / 2,
      (srcH - sh) / 2,
      sw,
      sh,
      0,
      0,
      c,
      c
    )
    return
  }
  // contain：画面完整居中（留白由调用方预先铺底层）
  const scale = Math.min(c / srcW, c / srcH)
  const dw = srcW * scale
  const dh = srcH * scale
  ctx.drawImage(src as CanvasImageSource, (c - dw) / 2, (c - dh) / 2, dw, dh)
}

/** 每元素记忆上一轮 tone（WeakMap：按钮卸载自动清理） */
const prevTones = new WeakMap<HTMLElement, 'light' | 'dark'>()

function toneOf(
  lum: number,
  prev: 'light' | 'dark' | undefined
): 'light' | 'dark' {
  if (prev === 'light') {
    return lum > LUMINANCE_THRESHOLD + LUMINANCE_HYSTERESIS ? 'dark' : 'light'
  }
  if (prev === 'dark') {
    return lum < LUMINANCE_THRESHOLD - LUMINANCE_HYSTERESIS ? 'light' : 'dark'
  }
  return lum > LUMINANCE_THRESHOLD ? 'dark' : 'light'
}

function clearElementTone(el: HTMLElement): void {
  el.style.removeProperty('--md-sys-color-on-surface')
  el.style.removeProperty('--md-sys-color-on-surface-variant')
  el.style.removeProperty('--lt-tone-inverse')
}

export function useBackdropAwareTone({
  videoRef,
  videoFit,
  videoVisible,
  coverImgRef,
  bgDimPercent,
  scopeRef,
}: {
  /** 背景视频元素（未就绪/不可见时回退封面采样） */
  videoRef: RefObject<HTMLVideoElement | null>
  /** 视频画面适配方式（object-fit 映射用） */
  videoFit: 'cover' | 'contain' | 'fill'
  /** 视频是否可见（未就绪时 opacity 0，露出的封面才是真实背景） */
  videoVisible: boolean
  /** 封面兜底 img（背景层的 DOM img；取 naturalWidth 判定可用） */
  coverImgRef: RefObject<HTMLImageElement | null>
  /** 背景压暗百分比（0-100，黑色遮罩线性混黑） */
  bgDimPercent: number
  /** 采样范围：扫描其子树内所有 [data-bg-tone] 元素 */
  scopeRef: RefObject<HTMLElement | null>
}): void {
  useEffect(() => {
    let lastSampleAt = 0

    const sample = () => {
      if (document.visibilityState !== 'visible') return
      const video = videoRef.current
      const playing = !!(video && !video.paused && !video.ended)
      // P1：背景静止时降频采样（画面帧不变，仅布局低频变化）
      if (!playing && Date.now() - lastSampleAt < IDLE_SAMPLE_INTERVAL_MS) {
        return
      }
      lastSampleAt = Date.now()

      const scope = scopeRef.current
      if (!scope) return
      const canvas = getToneCanvas()
      const ctx = canvas?.getContext('2d', { willReadFrequently: true })
      if (!canvas || !ctx) return

      const paintFallback = () => {
        scope
          .querySelectorAll<HTMLElement>('[data-bg-tone]')
          .forEach(clearElementTone)
      }

      // GPU→CPU 像素读回是采样最贵的操作：整轮只读一次全画布，
      // 各按钮矩形从同一份像素切片求均值（原实现每按钮读一次）
      const readFrame = (): ImageData | null => {
        try {
          return ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE)
        } catch {
          return null // 画布被污染（跨域视频）等
        }
      }

      // ===== 画背景源：视频当前帧优先，封面兜底 =====
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
      let base: DOMRect | null = null
      let frame: ImageData | null = null
      if (
        videoVisible &&
        video &&
        video.readyState >= 2 &&
        video.videoWidth > 0
      ) {
        if (videoFit === 'contain') {
          // contain 留白由底层放大模糊封面填充（真实 UI 即如此），无封面填黑
          const coverImg = coverImgRef.current
          if (coverImg && coverImg.naturalWidth > 0) {
            drawFitted(
              ctx,
              coverImg,
              coverImg.naturalWidth,
              coverImg.naturalHeight,
              'cover'
            )
          } else {
            ctx.fillStyle = '#000'
            ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
          }
        }
        drawFitted(ctx, video, video.videoWidth, video.videoHeight, videoFit)
        frame = readFrame()
        if (frame) {
          base = video.getBoundingClientRect()
        } else {
          // 视频源跨域污染画布 → 清掉回退封面采样
          ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
        }
      }
      if (!frame) {
        const coverImg = coverImgRef.current
        if (coverImg && coverImg.naturalWidth > 0) {
          drawFitted(
            ctx,
            coverImg,
            coverImg.naturalWidth,
            coverImg.naturalHeight,
            'cover'
          )
          frame = readFrame()
          if (frame) {
            base = coverImg.getBoundingClientRect()
          }
        }
      }
      if (!frame || !base || base.width < 1 || base.height < 1) {
        // 无源（无视频且无封面/封面未加载）：回退容器级主题色
        paintFallback()
        return
      }

      // ===== 背景压暗修正：黑色遮罩线性混黑 =====
      const dimFactor = Math.max(0, 1 - bgDimPercent / 100)
      const px = frame.data

      // ===== 逐按钮采样自身矩形对应的背景区域（从单份全画布像素切片） =====
      scope.querySelectorAll<HTMLElement>('[data-bg-tone]').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return
        const x0 = Math.max(
          0,
          Math.min(
            CANVAS_SIZE - 1,
            Math.round(((r.left - base.left) / base.width) * CANVAS_SIZE)
          )
        )
        const y0 = Math.max(
          0,
          Math.min(
            CANVAS_SIZE - 1,
            Math.round(((r.top - base.top) / base.height) * CANVAS_SIZE)
          )
        )
        const w0 = Math.max(
          1,
          Math.min(
            CANVAS_SIZE - x0,
            Math.round((r.width / base.width) * CANVAS_SIZE)
          )
        )
        const h0 = Math.max(
          1,
          Math.min(
            CANVAS_SIZE - y0,
            Math.round((r.height / base.height) * CANVAS_SIZE)
          )
        )
        let sum = 0
        for (let yy = y0; yy < y0 + h0; yy++) {
          const rowStart = (yy * CANVAS_SIZE + x0) * 4
          for (let xx = 0; xx < w0; xx++) {
            const o = rowStart + xx * 4
            sum += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]
          }
        }
        const lum = sum / (w0 * h0) / 255
        const tone = toneOf(lum * dimFactor, prevTones.get(el))
        prevTones.set(el, tone)
        const [onSurface, onVariant, inverse] = TONE_COLORS[tone]
        el.style.setProperty('--md-sys-color-on-surface', onSurface)
        el.style.setProperty('--md-sys-color-on-surface-variant', onVariant)
        el.style.setProperty('--lt-tone-inverse', inverse)
      })
    }

    sample()
    const timer = setInterval(sample, SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [videoRef, videoFit, videoVisible, coverImgRef, bgDimPercent, scopeRef])
}
