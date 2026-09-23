/** 预设种子颜色：用于生成 Material You 动态主题 */
export const PRESET_SEEDS = [
  { id: 'ocean', name: 'Ocean', color: '#0066cc' },
  { id: 'coral', name: 'Coral', color: '#f76f53' },
  { id: 'forest', name: 'Forest', color: '#2e7d32' },
  { id: 'amethyst', name: 'Amethyst', color: '#7b4eff' },
] as const

/**
 * Zen 主题编辑器官方预设色板（10 色，横向滚动圆点）。
 * 来源：Zen Browser theme editor 的 PRESET_COLORS（白/粉/亮粉/红/橙/金/绿/蓝/紫/黑）。
 */
export const EDITOR_PRESET_COLORS = [
  { color: '#ffffff', name: '白' },
  { color: '#ffc0cb', name: '粉' },
  { color: '#ff69b4', name: '亮粉' },
  { color: '#ff0000', name: '红' },
  { color: '#ff8c00', name: '橙' },
  { color: '#ffd700', name: '金' },
  { color: '#00ff00', name: '绿' },
  { color: '#4169e1', name: '蓝' },
  { color: '#800080', name: '紫' },
  { color: '#000000', name: '黑' },
] as const

/**
 * 强度混合基底（intensity 0% 时的中性背景色）：与 Zen「主色 × 背景
 * color-mix(in srgb)」同语义——深浅模式各自与对应基底混合，保证低强度
 * 下 Monet 派生色仍与背景协调。
 */
export const SEED_MIX_BASE = {
  light: '#f3f1f7',
  dark: '#17161b',
} as const

/**
 * sRGB 通道线性插值混合（color-mix(in srgb, a ratio, b rest) 同义）。
 * ratio 为 a 的占比（0-1，越界夹取）；任一输入非法时返回另一输入的
 * 规范化形式（再非法返回 null）。
 */
export function mixHexColors(
  a: string,
  b: string,
  ratio: number
): string | null {
  const hexA = normalizeHexColor(a)
  const hexB = normalizeHexColor(b)
  if (!hexA && !hexB) return null
  if (!hexA || !hexB) return hexA ?? hexB
  const t = Math.min(1, Math.max(0, ratio))
  const mix = (x: string, y: string) => {
    const ch1 = parseInt(x, 16)
    const ch2 = parseInt(y, 16)
    return Math.round(ch1 * t + ch2 * (1 - t))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${mix(hexA.slice(1, 3), hexB.slice(1, 3))}${mix(
    hexA.slice(3, 5),
    hexB.slice(3, 5)
  )}${mix(hexA.slice(5, 7), hexB.slice(5, 7))}`
}

/**
 * 强度合成种子：把用户选择的种子色与当前深浅模式的基底中性色按
 * colorIntensity（0-100，100 = 纯色不混合）混合，作为 Monet 派生色板的
 * 实际输入。非法种子回退 DEFAULT_SEED。
 */
export function resolveEffectiveSeed(
  seed: string,
  isDark: boolean,
  intensity: number
): string {
  const normalized = normalizeHexColor(seed) ?? DEFAULT_SEED
  const t = Math.min(100, Math.max(0, intensity))
  if (t >= 100) return normalized
  return (
    mixHexColors(
      normalized,
      isDark ? SEED_MIX_BASE.dark : SEED_MIX_BASE.light,
      t / 100
    ) ?? normalized
  )
}

/** 默认种子颜色：Material 蓝色 */
export const DEFAULT_SEED = '#0066cc'

/** 预设种子颜色项类型 */
export type PresetSeed = (typeof PRESET_SEEDS)[number]

/**
 * 校验字符串是否为合法 hex 颜色（支持 3/6/8 位，可带 # 前缀）。
 */
export function isValidSeedColor(color: unknown): color is string {
  if (typeof color !== 'string') return false
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color.trim())
}

/**
 * 规范化 hex 颜色为 `#rrggbb` 小写形式（3 位扩位；8 位/非法输入返回 null）。
 */
export function normalizeHexColor(color: unknown): string | null {
  if (!isValidSeedColor(color)) return null
  let hex = color.trim().replace(/^#/, '').toLowerCase()
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((ch) => ch + ch)
      .join('')
  }
  if (hex.length !== 6) return null
  return `#${hex}`
}

/** 色相扇区 → RGB 分量三元组（hsvToHex 等共享；hh ∈ [0,360)） */
function hueSectorRgb(
  hh: number,
  c: number,
  x: number
): [number, number, number] {
  if (hh < 60) return [c, x, 0]
  if (hh < 120) return [x, c, 0]
  if (hh < 180) return [0, c, x]
  if (hh < 240) return [0, x, c]
  if (hh < 300) return [x, 0, c]
  return [c, 0, x]
}

/** HSV 颜色（h: 0-360，s/v: 0-100，v=明度）——自研取色面板的色型 */
export interface HsvColor {
  h: number
  s: number
  v: number
}

/** hex → HSV（非法输入返回 null） */
export function hexToHsv(color: unknown): HsvColor | null {
  const hex = normalizeHexColor(color)
  if (!hex) return null
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }
  const s = max === 0 ? 0 : d / max
  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    v: Math.round(max * 100),
  }
}

/** hsv → hex（#rrggbb 小写）；入参自动取模/夹取 */
export function hsvToHex(h: number, s: number, v: number): string {
  const hh = ((h % 360) + 360) % 360
  const ss = Math.min(100, Math.max(0, s)) / 100
  const vv = Math.min(100, Math.max(0, v)) / 100
  const c = vv * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = vv - c
  const [rp, gp, bp] = hueSectorRgb(hh, c, x)
  return `#${[rp + m, gp + m, bp + m]
    .map((ch) =>
      Math.round(ch * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}
