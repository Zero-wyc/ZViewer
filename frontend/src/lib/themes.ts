/** 预设种子颜色：用于生成 Material You 动态主题 */
export const PRESET_SEEDS = [
  { id: 'ocean', name: 'Ocean', color: '#0066cc' },
  { id: 'coral', name: 'Coral', color: '#f76f53' },
  { id: 'forest', name: 'Forest', color: '#2e7d32' },
  { id: 'amethyst', name: 'Amethyst', color: '#7b4eff' },
] as const

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
