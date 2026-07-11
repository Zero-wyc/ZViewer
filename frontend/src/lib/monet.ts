import {
  argbFromHex,
  hexFromArgb,
  themeFromSourceColor,
} from '@material/material-color-utilities'
import { DEFAULT_SEED } from './themes'

/**
 * 校验字符串是否为合法的 hex 颜色（支持 3/6/8 位，可带 # 前缀）。
 */
function isValidHexColor(color: string): boolean {
  if (typeof color !== 'string') return false
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color.trim())
}

/**
 * 将 ARGB 数值拆分为 R、G、B 三个十进制分量，用于生成 rgb(...) 字符串。
 */
function rgbComponents(argb: number): { r: number; g: number; b: number } {
  const hex = hexFromArgb(argb).replace('#', '')
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

/**
 * 基于 Google Material You（Monet）从种子颜色生成 Material Design 3 色彩系统 CSS 变量。
 *
 * @param sourceColor 十六进制种子色，例如 '#f76f53'
 * @param isDark 是否生成深色模式配色
 * @returns CSS 变量名到色值的映射
 */
export function generateMonetTheme(
  sourceColor: string,
  isDark: boolean
): Record<string, string> {
  // 对 sourceColor 做前置校验，避免 Material 库内部因非法 hex 抛出难以定位的错误
  if (!isValidHexColor(sourceColor)) {
    throw new Error(`invalid source color: ${String(sourceColor)}`)
  }

  const sourceArgb = argbFromHex(sourceColor)
  const theme = themeFromSourceColor(sourceArgb)

  // 防御 themeFromSourceColor 返回不完整对象或 undefined 的情况
  if (
    !theme ||
    !theme.schemes ||
    !theme.schemes.light ||
    !theme.schemes.dark ||
    !theme.palettes ||
    !theme.palettes.neutral ||
    !theme.palettes.primary ||
    !theme.palettes.secondary ||
    !theme.palettes.tertiary
  ) {
    throw new Error('themeFromSourceColor returned an incomplete theme')
  }

  const scheme = isDark ? theme.schemes.dark : theme.schemes.light
  if (!scheme) {
    throw new Error('selected scheme is undefined')
  }

  const vars: Record<string, string> = {}

  // 核心颜色角色映射
  const colorRoles: Array<[keyof typeof scheme, string]> = [
    ['primary', '--md-sys-color-primary'],
    ['onPrimary', '--md-sys-color-on-primary'],
    ['primaryContainer', '--md-sys-color-primary-container'],
    ['onPrimaryContainer', '--md-sys-color-on-primary-container'],
    ['secondary', '--md-sys-color-secondary'],
    ['onSecondary', '--md-sys-color-on-secondary'],
    ['secondaryContainer', '--md-sys-color-secondary-container'],
    ['onSecondaryContainer', '--md-sys-color-on-secondary-container'],
    ['tertiary', '--md-sys-color-tertiary'],
    ['onTertiary', '--md-sys-color-on-tertiary'],
    ['tertiaryContainer', '--md-sys-color-tertiary-container'],
    ['onTertiaryContainer', '--md-sys-color-on-tertiary-container'],
    ['error', '--md-sys-color-error'],
    ['onError', '--md-sys-color-on-error'],
    ['errorContainer', '--md-sys-color-error-container'],
    ['onErrorContainer', '--md-sys-color-on-error-container'],
    ['surface', '--md-sys-color-surface'],
    ['onSurface', '--md-sys-color-on-surface'],
    ['surfaceVariant', '--md-sys-color-surface-variant'],
    ['onSurfaceVariant', '--md-sys-color-on-surface-variant'],
    ['outline', '--md-sys-color-outline'],
    ['outlineVariant', '--md-sys-color-outline-variant'],
    ['shadow', '--md-sys-color-shadow'],
    ['scrim', '--md-sys-color-scrim'],
    ['inverseSurface', '--md-sys-color-inverse-surface'],
    ['inverseOnSurface', '--md-sys-color-inverse-on-surface'],
    ['inversePrimary', '--md-sys-color-inverse-primary'],
  ]

  colorRoles.forEach(([role, varName]) => {
    const argb = scheme[role]
    if (typeof argb !== 'number') return
    vars[varName] = hexFromArgb(argb)
  })

  // surfaceContainer 系列在 0.4.0 的 Scheme 类中未直接提供，
  // 使用 neutral 色阶的固定色调映射，符合 Material Design 3 规范。
  const neutral = theme.palettes.neutral
  const containerTones = isDark
    ? {
        '--md-sys-color-surface-container': 12,
        '--md-sys-color-surface-container-high': 17,
        '--md-sys-color-surface-container-highest': 22,
      }
    : {
        '--md-sys-color-surface-container': 94,
        '--md-sys-color-surface-container-high': 92,
        '--md-sys-color-surface-container-highest': 90,
      }

  Object.entries(containerTones).forEach(([varName, tone]) => {
    const argb = neutral.tone(tone)
    vars[varName] = hexFromArgb(argb)
  })

  // 为玻璃拟态背景提供 surface-container 的 RGB 分量形式
  const surfaceContainerArgb = neutral.tone(
    containerTones['--md-sys-color-surface-container']
  )
  const rgb = rgbComponents(surfaceContainerArgb)
  vars['--md-sys-color-surface-container-rgb'] = `${rgb.r}, ${rgb.g}, ${rgb.b}`

  // 主色、次色、第三色的色调阶（0/10/20/30/40/50/60/70/80/90/95/99/100）
  const tones = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99, 100]
  const paletteNames: Array<[keyof typeof theme.palettes, string]> = [
    ['primary', 'primary'],
    ['secondary', 'secondary'],
    ['tertiary', 'tertiary'],
  ]

  paletteNames.forEach(([paletteKey, prefix]) => {
    const palette = theme.palettes[paletteKey]
    if (!palette) return
    tones.forEach((tone) => {
      vars[`--md-ref-palette-${prefix}-${tone}`] = hexFromArgb(
        palette.tone(tone)
      )
    })
  })

  return vars
}

let defaultThemeColors: Record<string, string> | undefined

function getDefaultThemeColors(): Record<string, string> {
  if (!defaultThemeColors) {
    try {
      defaultThemeColors = generateMonetTheme(DEFAULT_SEED, false)
    } catch {
      defaultThemeColors = {}
    }
  }
  return defaultThemeColors
}

/**
 * 安全地获取主题颜色，避免外部/宿主环境返回 undefined 时解构报错。
 *
 * @param sourceColor 十六进制种子色
 * @param isDark 是否深色模式
 * @returns 包含 exportedColors 的对象，始终可安全解构
 */
export function getThemeColors(
  sourceColor: string = DEFAULT_SEED,
  isDark: boolean = false
): { exportedColors: Record<string, string> } {
  try {
    const exportedColors = generateMonetTheme(sourceColor, isDark)
    return { exportedColors }
  } catch (err) {
    console.warn('[getThemeColors]', err)
    return { exportedColors: getDefaultThemeColors() }
  }
}
