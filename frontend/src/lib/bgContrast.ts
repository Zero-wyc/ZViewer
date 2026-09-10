/**
 * 背景合成亮度与文字对比度自适应工具。
 *
 * 背景的视觉呈现链路（Layout.tsx，自底向上）：
 * body surface 底色 → 壁纸层（opacity 混合） → 白遮罩（rgba 白） → 黑遮罩（rgba 黑），
 * 文字与内容层悬浮其上。本模块按同样的顺序在 sRGB 空间逐通道合成出「有效背景色」，
 * 再用 WCAG 相对亮度对比度判定当前主题的文字色是否仍可读，由 ThemeProvider
 * 据此把文字系中性变量（onSurface / onSurfaceVariant / outline 系）覆盖为对侧
 * scheme 的值，实现背景深浅驱动的文字颜色自动适配。
 */

export interface RgbColor {
  r: number
  g: number
  b: number
}

/** hex（#rgb / #rrggbb，可带 # 前缀）→ RGB 分量；非法输入返回 null */
export function hexToRgb(hex: string | undefined): RgbColor | null {
  if (!hex) return null
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

/** WCAG 相对亮度（sRGB 0-255 → 0-1 线性化后加权） */
export function relativeLuminance({ r, g, b }: RgbColor): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 对比度（两条相对亮度，0-1） */
export function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

/** sRGB 空间逐通道 alpha 合成（与 CSS rgba 叠加一致）：base×(1-α)+overlay×α */
function mixOver(base: RgbColor, overlay: RgbColor, alpha: number): RgbColor {
  const t = Math.min(1, Math.max(0, alpha))
  return {
    r: base.r * (1 - t) + overlay.r * t,
    g: base.g * (1 - t) + overlay.g * t,
    b: base.b * (1 - t) + overlay.b * t,
  }
}

export interface EffectiveBackgroundParams {
  /** body 底色（--md-sys-color-surface），hex */
  surfaceHex: string
  /** 壁纸平均色；null 表示不可采样（跨域/加载失败），按「壁纸不改变底色」降级 */
  wallpaperRgb: RgbColor | null
  /** 背景层 opacity（Layout：自定义壁纸用 backgroundOpacity，默认壁纸 min(op, 0.85)） */
  wallpaperOpacity: number
  /** 白遮罩强度 0-1 */
  whiteAlpha: number
  /** 黑遮罩强度 0-1 */
  blackAlpha: number
}

/** 按 Layout 渲染顺序（底色 → 壁纸 → 白遮罩 → 黑遮罩）合成「有效背景色」 */
export function computeEffectiveBackgroundRgb(
  params: EffectiveBackgroundParams
): RgbColor {
  let c = hexToRgb(params.surfaceHex) ?? { r: 255, g: 255, b: 255 }
  if (params.wallpaperRgb && params.wallpaperOpacity > 0) {
    c = mixOver(c, params.wallpaperRgb, params.wallpaperOpacity)
  }
  if (params.whiteAlpha > 0) {
    c = mixOver(c, { r: 255, g: 255, b: 255 }, params.whiteAlpha)
  }
  if (params.blackAlpha > 0) {
    c = mixOver(c, { r: 0, g: 0, b: 0 }, params.blackAlpha)
  }
  return c
}

const SAMPLE_SIZE = 32
/** 采样缓存：同 URL 只加载与采样一次（壁纸不变则结果不变，失败结果同样缓存） */
const sampleCache = new Map<string, Promise<RgbColor | null>>()

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // 网络图尝试 CORS：服务器无 CORS 头时走 onerror → 采样降级（不影响 Layout 实际显示）
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

/**
 * 壁纸降采样平均色（32×32 canvas，sRGB 空间平均；背景高斯模糊不改变全局平均亮度，
 * 故无需按模糊重采样）。跨域无 CORS / 加载失败 / canvas 不可用时返回 null，
 * 调用方降级为「仅底色 + 遮罩」合成，避免误判。
 */
export function sampleImageAverageColor(url: string): Promise<RgbColor | null> {
  const cached = sampleCache.get(url)
  if (cached) return cached
  const promise = (async () => {
    try {
      const img = await loadImage(url)
      const canvas = document.createElement('canvas')
      canvas.width = SAMPLE_SIZE
      canvas.height = SAMPLE_SIZE
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return null
      ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      let r = 0
      let g = 0
      let b = 0
      const count = SAMPLE_SIZE * SAMPLE_SIZE
      for (let i = 0; i < count; i += 1) {
        r += data[i * 4]
        g += data[i * 4 + 1]
        b += data[i * 4 + 2]
      }
      return { r: r / count, g: g / count, b: b / count }
    } catch {
      return null
    }
  })()
  sampleCache.set(url, promise)
  return promise
}
