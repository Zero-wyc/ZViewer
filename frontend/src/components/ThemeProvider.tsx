import { useEffect } from 'react'
import { useThemeStore, radiusPresetToPx, RADIUS_PRESETS } from '@/store/themeStore'
import { getThemeColors } from '@/lib/monet'

/**
 * 玻璃拟态相关变量名集合，用于在卸载时统一清理。
 */
const GLASS_VARS = [
  '--glass-strength',
  '--glass-blur',
  '--glass-bg',
  '--glass-border',
  '--glass-strong-strength',
]

/**
 * 圆角相关变量名集合，用于在卸载时统一清理。
 */
const RADIUS_VARS = [
  '--md-sys-shape-corner',
  '--md-sys-radius-small',
  '--md-sys-radius-medium',
  '--md-sys-radius-large',
  '--md-sys-radius-none',
]

/**
 * 由玻璃强度计算边框不透明度，确保边框始终可见但不过于突兀。
 */
function glassBorderAlpha(strength: number): number {
  return Math.min(1, strength + 0.15)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { sourceColor, isDark, radius, glassStrength } = useThemeStore()

  // 根据当前种子色与深浅模式生成并应用 Material You CSS 变量
  useEffect(() => {
    const root = document.documentElement
    const result = getThemeColors(sourceColor, isDark)
    const colors = result?.exportedColors ?? {}

    Object.entries(colors).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })

    // 形状与玻璃拟态辅助变量
    const radiusPx = radiusPresetToPx(radius)
    root.style.setProperty('--md-sys-shape-corner', `${radiusPx}px`)
    RADIUS_PRESETS.forEach((preset) => {
      root.style.setProperty(`--md-sys-radius-${preset.value}`, `${preset.px}px`)
    })
    root.style.setProperty('--glass-strength', String(glassStrength))
    root.style.setProperty('--glass-blur', '12px')

    const rgb = colors['--md-sys-color-surface-container-rgb']
    root.style.setProperty('--glass-bg', `rgba(${rgb}, ${glassStrength})`)
    root.style.setProperty(
      '--glass-border',
      `rgba(${rgb}, ${glassBorderAlpha(glassStrength)})`
    )

    const glassStrongStrength = Math.min(0.95, glassStrength + 0.25)
    root.style.setProperty('--glass-strong-strength', String(glassStrongStrength))

    // 同步 .dark 类到 html 元素
    if (isDark) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }

    // 组件卸载时清除所有由本组件设置的 inline 样式变量
    return () => {
      Object.keys(colors).forEach((key) => {
        root.style.removeProperty(key)
      })
      RADIUS_VARS.forEach((key) => root.style.removeProperty(key))
      GLASS_VARS.forEach((key) => root.style.removeProperty(key))
      root.classList.remove('dark')
    }
  }, [sourceColor, isDark, radius, glassStrength])

  return <>{children}</>
}
