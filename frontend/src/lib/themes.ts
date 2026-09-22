/** 预设种子颜色：用于生成 Material You 动态主题 */
export const PRESET_SEEDS = [
  { id: 'ocean', name: '海洋', color: '#0066cc' },
  { id: 'coral', name: '珊瑚', color: '#f76f53' },
  { id: 'forest', name: '森野', color: '#2e7d32' },
  { id: 'amethyst', name: '紫晶', color: '#7b4eff' },
  { id: 'cream', name: '奶油', color: '#e3d29b' },
  { id: 'sakura', name: '樱粉', color: '#f2a2b9' },
  { id: 'lavender', name: '薰衣草', color: '#cf9fe8' },
  { id: 'rosequartz', name: '玫红', color: '#d95858' },
  { id: 'honey', name: '蜜黄', color: '#e5c454' },
  { id: 'mint', name: '薄荷', color: '#5fc99a' },
  { id: 'skyfall', name: '天青', color: '#6fa8dc' },
  { id: 'graphite', name: '石墨', color: '#6d757d' },
] as const

/** 默认种子颜色：Material 蓝色 */
export const DEFAULT_SEED = '#0066cc'

/** 预设种子颜色项类型 */
export type PresetSeed = (typeof PRESET_SEEDS)[number]

/** 所有预设种子色的 hex 集合（判断当前色是否为预设） */
export const PRESET_SEED_COLORS = new Set(
  PRESET_SEEDS.map((seed) => seed.color.toLowerCase())
)

/**
 * 校验字符串是否为合法 hex 颜色（支持 3/6/8 位，可带 # 前缀）。
 */
export function isValidSeedColor(color: unknown): color is string {
  if (typeof color !== 'string') return false
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color.trim())
}

/**
 * 规范化 hex 颜色为 `#rrggbb` 小写形式（3 位扩位；8 位/非法输入返回 null）。
 * 用于 <input type="color">、色板去重等需要标准 6 位 hex 的场景。
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

/** HSL 颜色（h: 0-360，s/l: 0-100） */
export interface HslColor {
  h: number
  s: number
  l: number
}

/**
 * hex → HSL（非法输入返回 null）。波形条（色相）/旋钮（饱和度）
 * 拖动时按通道改写、其余通道保持，依赖此转换。
 */
export function hexToHsl(color: unknown): HslColor | null {
  const hex = normalizeHexColor(color)
  if (!hex) return null
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
  }
  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  }
}

/** hsl → hex（#rrggbb 小写）；入参自动取模/夹取 */
export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360
  const ss = Math.min(100, Math.max(0, s)) / 100
  const ll = Math.min(100, Math.max(0, l)) / 100
  const c = (1 - Math.abs(2 * ll - 1)) * ss
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = ll - c / 2
  const [rp, gp, bp] = ((): [number, number, number] => {
    if (hh < 60) return [c, x, 0]
    if (hh < 120) return [x, c, 0]
    if (hh < 180) return [0, c, x]
    if (hh < 240) return [0, x, c]
    if (hh < 300) return [x, 0, c]
    return [c, 0, x]
  })()
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(rp)}${toHex(gp)}${toHex(bp)}`
}
