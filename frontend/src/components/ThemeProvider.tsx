import { useEffect, useMemo, useState } from 'react'
import {
  useThemeStore,
  radiusPresetToPx,
  RADIUS_PRESETS,
} from '@/store/themeStore'
import { generateMonetTheme, getThemeColors } from '@/lib/monet'
import { DEFAULT_SEED, resolveEffectiveSeed } from '@/lib/themes'
import {
  computeEffectiveBackgroundRgb,
  contrastRatio,
  hexToRgb,
  relativeLuminance,
  sampleImageAverageColor,
  type RgbColor,
} from '@/lib/bgContrast'

/**
 * 玻璃拟态相关变量名集合，用于在卸载时统一清理。
 */
const GLASS_VARS = [
  '--glass-strength',
  '--glass-strong-strength',
  '--glass-blur',
  '--glass-blur-strong',
  '--glass-blur-mask',
  '--glass-blur-loading',
  '--glass-bg',
  '--glass-border',
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
 * 文字对比度自适应覆盖的变量（文字系中性色）：背景被黑遮罩压暗时切换为
 * 深色 scheme 的近白值，反之（暗色主题 + 高白遮罩）切换回浅色 scheme 的近黑值。
 */
const ADAPTIVE_TEXT_VARS = [
  '--md-sys-color-on-surface',
  '--md-sys-color-on-surface-variant',
  '--md-sys-color-outline',
  '--md-sys-color-outline-variant',
]

/**
 * 玻璃面板作用域文字变量（--lt-glass-*）：按「含玻璃层的有效背景」判定
 * 的 scheme 文字色，供播放页/迷你条等「主题驱动面」组件根节点局部引用
 * （见 effect 内玻璃层判定）。
 */
const GLASS_TEXT_VARS = ADAPTIVE_TEXT_VARS.map(
  (v) => `--lt-glass${v.slice('--md-sys-color'.length)}`
)

/**
 * 壁纸作用域文字变量（--lt-raw-*）：按「原始背景（不含玻璃）」判定的
 * scheme 文字色，供音乐壳/顶栏等「文字直接坐在壁纸上」的页面根节点局部
 * 引用（见 effect 内原始背景判定）。
 */
const RAW_TEXT_VARS = ADAPTIVE_TEXT_VARS.map(
  (v) => `--lt-raw${v.slice('--md-sys-color'.length)}`
)

/**
 * Layout.tsx 的默认壁纸路径（未自定义背景时），与背景层 fallback 保持一致。
 */
const DEFAULT_WALLPAPER = '/Nacho3.jpg'

/**
 * 自适应切换阈值：对侧文字色的对比度需比当前侧高出该幅度才切换。
 * 中灰背景下黑/白文字对比度都不达标，两侧差距小，加幅度阈值可避免
 * 滑块在临界值附近拖动时文字颜色反复跳变。
 */
const ADAPTIVE_SWITCH_MARGIN = 1

/**
 * 校验字符串是否为合法 hex 颜色（支持 3/6/8 位，可带 # 前缀）。
 */
function isValidHexColor(color: string): boolean {
  if (typeof color !== 'string') return false
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color.trim())
}

/**
 * 安全生成 Monet scheme（失败返回空映射，自适应判定随之跳过）。
 */
function safeGenerateMonet(
  sourceColor: string,
  isDark: boolean
): Record<string, string> {
  try {
    return generateMonetTheme(sourceColor, isDark)
  } catch {
    return {}
  }
}

/**
 * 由玻璃强度计算边框不透明度，确保边框始终可见但不过于突兀。
 */
function glassBorderAlpha(strength: number): number {
  return Math.min(1, strength + 0.15)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const {
    sourceColor,
    isDark,
    mode,
    colorIntensity,
    radius,
    glassStrength,
    glassBlur,
    backgroundImage,
    backgroundOpacity,
    backgroundWhiteOverlay,
    backgroundBlackOverlay,
  } = useThemeStore()

  const safeSourceColor = isValidHexColor(sourceColor)
    ? sourceColor
    : DEFAULT_SEED

  // ===== auto 模式：跟随系统深浅偏好。系统切换时直接物化 isDark——
  // 全部消费方（本组件与各处 useThemeStore 读 isDark）无感知地跟随，
  // 无需各自订阅 matchMedia；离开 auto 由 setMode 负责恢复显式值 =====
  useEffect(() => {
    if (mode !== 'auto') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const { isDark: current } = useThemeStore.getState()
      if (current !== mq.matches) {
        useThemeStore.setState({ isDark: mq.matches })
      }
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [mode])

  /** 浅/深两套 scheme（种子与强度不变时缓存，供文字对比度自适应判定取值）。
   *  颜色强度（Zen color-intensity 语义）先与深浅各自基底按比例混合成
   *  实际种子，强度 100 时与历史行为完全一致 */
  const schemes = useMemo(
    () => ({
      light: safeGenerateMonet(
        resolveEffectiveSeed(safeSourceColor, false, colorIntensity),
        false
      ),
      dark: safeGenerateMonet(
        resolveEffectiveSeed(safeSourceColor, true, colorIntensity),
        true
      ),
    }),
    [safeSourceColor, colorIntensity]
  )

  /** 壁纸平均色采样结果（null = 跨域/加载失败，自适应按「壁纸不改变底色」降级） */
  const [wallpaperRgb, setWallpaperRgb] = useState<RgbColor | null>(null)

  // 壁纸平均色采样（异步一次，结果缓存于 bgContrast；URL 变化时重新采样）
  useEffect(() => {
    let cancelled = false
    const url = backgroundImage ?? DEFAULT_WALLPAPER
    void sampleImageAverageColor(url).then((rgb) => {
      if (cancelled) return
      setWallpaperRgb((prev) => {
        if (prev === rgb) return prev
        if (
          prev &&
          rgb &&
          prev.r === rgb.r &&
          prev.g === rgb.g &&
          prev.b === rgb.b
        )
          return prev
        return rgb
      })
    })
    return () => {
      cancelled = true
    }
  }, [backgroundImage])

  // 根据当前种子色（经强度合成）与深浅模式生成并应用 Material You CSS 变量
  useEffect(() => {
    const root = document.documentElement
    const result = getThemeColors(
      resolveEffectiveSeed(safeSourceColor, isDark, colorIntensity),
      isDark
    )
    const colors = result?.exportedColors ?? {}

    Object.entries(colors).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })

    // ===== 文字对比度自适应（全作用域化，根节点不再全局切换）=====
    // 根节点的文字系变量永远是当前 scheme 原生值——玻璃面板/弹窗/卡片等
    // 「主题驱动面」天然与自己 scheme 的文字色配对，全局切换会让深色玻璃
    // 面板配上深字（主题菜单不可读事故）。需要自适应的两类场景改为各自
    // 引用判定结果：
    // 【--lt-raw-*】文字直接坐在壁纸/遮罩上的页面（音乐分区等，无玻璃
    //   背板）：按「原始背景（底色→壁纸→遮罩）」判定文字 scheme，音乐壳
    //   与顶栏根节点局部引用
    // 【--lt-glass-*】文字坐在冰霜面板上的播放页/迷你条：按「含玻璃层的
    //   有效背景」判定，组件根节点局部引用
    const currentScheme = isDark ? schemes.dark : schemes.light
    const oppositeScheme = isDark ? schemes.light : schemes.dark
    const currentTextHex = currentScheme['--md-sys-color-on-surface']
    const oppositeTextHex = oppositeScheme['--md-sys-color-on-surface']
    if (currentTextHex && oppositeTextHex) {
      const baseBgParams = {
        surfaceHex: colors['--md-sys-color-surface'] ?? '#ffffff',
        wallpaperRgb,
        wallpaperOpacity: backgroundImage
          ? backgroundOpacity
          : Math.min(backgroundOpacity, 0.85),
        whiteAlpha: backgroundWhiteOverlay,
        blackAlpha: backgroundBlackOverlay,
      }
      const currentTextLum = relativeLuminance(
        hexToRgb(currentTextHex) ?? { r: 0, g: 0, b: 0 }
      )
      const oppositeTextLum = relativeLuminance(
        hexToRgb(oppositeTextHex) ?? { r: 255, g: 255, b: 255 }
      )

      // 原始背景判定 → --lt-raw-*
      const rawBgLum = relativeLuminance(
        computeEffectiveBackgroundRgb(baseBgParams)
      )
      const rawScheme =
        contrastRatio(oppositeTextLum, rawBgLum) -
          contrastRatio(currentTextLum, rawBgLum) >=
        ADAPTIVE_SWITCH_MARGIN
          ? oppositeScheme
          : currentScheme
      ADAPTIVE_TEXT_VARS.forEach((v) => {
        if (rawScheme[v]) {
          root.style.setProperty(
            `--lt-raw${v.slice('--md-sys-color'.length)}`,
            rawScheme[v]
          )
        }
      })

      // 含玻璃层背景判定 → --lt-glass-*
      const glassRgb = hexToRgb(colors['--md-sys-color-surface-container'])
      const glassBgLum = relativeLuminance(
        computeEffectiveBackgroundRgb({
          ...baseBgParams,
          glassRgb,
          glassAlpha: glassStrength,
        })
      )
      const glassScheme =
        contrastRatio(oppositeTextLum, glassBgLum) -
          contrastRatio(currentTextLum, glassBgLum) >=
        ADAPTIVE_SWITCH_MARGIN
          ? oppositeScheme
          : currentScheme
      ADAPTIVE_TEXT_VARS.forEach((v) => {
        if (glassScheme[v]) {
          root.style.setProperty(
            `--lt-glass${v.slice('--md-sys-color'.length)}`,
            glassScheme[v]
          )
        }
      })
    }

    // 形状与玻璃拟态辅助变量
    const radiusPx = radiusPresetToPx(radius)
    root.style.setProperty('--md-sys-shape-corner', `${radiusPx}px`)
    RADIUS_PRESETS.forEach((preset) => {
      root.style.setProperty(
        `--md-sys-radius-${preset.value}`,
        `${preset.px}px`
      )
    })
    root.style.setProperty('--glass-strength', String(glassStrength))
    root.style.setProperty(
      '--glass-strong-strength',
      String(Math.min(0.95, glassStrength + 0.25))
    )

    // 玻璃模糊统一由主题设置驱动，所有卡片/遮罩直接使用对应变量，避免各组件自行 calc 缩放
    root.style.setProperty('--glass-blur', `${glassBlur}px`)
    root.style.setProperty(
      '--glass-blur-strong',
      `${Math.min(40, glassBlur + 4)}px`
    )
    root.style.setProperty(
      '--glass-blur-mask',
      `${Math.max(0, Math.round(glassBlur * 0.4))}px`
    )
    root.style.setProperty(
      '--glass-blur-loading',
      `${Math.max(0, Math.round(glassBlur * 0.2))}px`
    )

    // 玻璃背景色跟随主题透明度与 surface 色，供所有 glass 工具类统一使用
    const rgb = colors['--md-sys-color-surface-container-rgb']
    root.style.setProperty('--glass-bg', `rgba(${rgb}, ${glassStrength})`)
    root.style.setProperty(
      '--glass-border',
      `rgba(${rgb}, ${glassBorderAlpha(glassStrength)})`
    )

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
      GLASS_TEXT_VARS.forEach((key) => root.style.removeProperty(key))
      RAW_TEXT_VARS.forEach((key) => root.style.removeProperty(key))
      RADIUS_VARS.forEach((key) => root.style.removeProperty(key))
      GLASS_VARS.forEach((key) => root.style.removeProperty(key))
      root.classList.remove('dark')
    }
  }, [
    safeSourceColor,
    isDark,
    colorIntensity,
    radius,
    glassStrength,
    glassBlur,
    schemes,
    wallpaperRgb,
    backgroundImage,
    backgroundOpacity,
    backgroundWhiteOverlay,
    backgroundBlackOverlay,
  ])

  return <>{children}</>
}
