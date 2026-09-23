import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_SEED, isValidSeedColor, normalizeHexColor } from '@/lib/themes'

export type RadiusPreset = 'small' | 'medium' | 'large' | 'none'

/** 主题深浅模式：auto = 跟随系统（浅/深由系统偏好实时决定） */
export type ThemeColorMode = 'auto' | 'light' | 'dark'

/** 自定义色板容量上限（防止 localStorage 无限膨胀） */
export const MAX_CUSTOM_COLORS = 24

/** 读取系统深色偏好（matchMedia 不可用时回退浅色） */
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export const RADIUS_PRESETS: {
  value: RadiusPreset
  label: string
  px: number
}[] = [
  { value: 'none', label: '无', px: 0 },
  { value: 'small', label: '小', px: 8 },
  { value: 'medium', label: '中', px: 16 },
  { value: 'large', label: '大', px: 28 },
]

export const DEFAULT_RADIUS_PRESET: RadiusPreset = 'medium'

export function radiusPresetToPx(preset: RadiusPreset): number {
  return RADIUS_PRESETS.find((p) => p.value === preset)?.px ?? 16
}

/**
 * 将旧版本存储的数值 radius 迁移为最近的预设。
 */
function migrateRadius(value: unknown): RadiusPreset {
  if (
    typeof value === 'string' &&
    RADIUS_PRESETS.some((p) => p.value === value)
  ) {
    return value as RadiusPreset
  }
  const num = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(num)) return DEFAULT_RADIUS_PRESET
  const nearest = RADIUS_PRESETS.reduce((prev, curr) =>
    Math.abs(curr.px - num) < Math.abs(prev.px - num) ? curr : prev
  )
  return nearest.value
}

/** Monet 主题状态 */
interface ThemeState {
  /** 种子颜色，Material You 据此生成完整色板 */
  sourceColor: string
  /** 是否深色模式（由 mode + 系统偏好实时物化，消费方无感知 auto 切换） */
  isDark: boolean
  /** 深浅模式：auto 跟随系统 / light / dark（持久化，isDark 为其派生） */
  mode: ThemeColorMode
  /** 用户自定义色板（Zen 风格主题面板的颜色层，持久化，小写 #rrggbb） */
  customColors: string[]
  /**
   * 颜色强度 0-100（Zen theme editor 的 color-intensity）：种子色与深浅
   * 模式基底中性色的混合比例，100 = 纯种子色（默认，与历史行为一致）；
   * 由 ThemeProvider 经 resolveEffectiveSeed 合成 Monet 派生色板的输入
   */
  colorIntensity: number
  /** 圆角预设 */
  radius: RadiusPreset
  /** 玻璃拟态背景透明度，0-1 */
  glassStrength: number
  /** 玻璃拟态模糊度，0-40px */
  glassBlur: number
  /** 精简动画模式：去除 blur/3D/rotate 等浮夸效果，仅保留基础淡入与微交互 */
  reducedMotion: boolean
  /** 禁用全局 hover 位移效果（translate/scale），不影响其他动画与玻璃效果 */
  disableHoverTransform: boolean

  /** 自定义背景图片（URL 或 Base64），null 表示未设置 */
  backgroundImage: string | null
  /** 背景模糊度（一起看 / 投屏 / 其他页面），0~20px */
  backgroundBlur: number
  /** 一起听模式的背景模糊度（独立调节），0~20px */
  listenTogetherBlur: number
  /** 背景透明度，0~1（历史字段：面板已改为白/黑遮罩调节，不再暴露） */
  backgroundOpacity: number
  /** 白遮罩强度，0~1（盖在背景图上方、内容层下方） */
  backgroundWhiteOverlay: number
  /** 黑遮罩强度，0~1（盖在背景图上方、内容层下方） */
  backgroundBlackOverlay: number
  /** 背景水平位置，-100~100% */
  backgroundPositionX: number
  /** 背景垂直位置，-100~100% */
  backgroundPositionY: number
  /** 背景缩放比例，0.5~2 */
  backgroundScale: number
  /** 背景旋转角度，0~360° */
  backgroundRotate: number

  /** 精简动画关闭前的参数快照（不持久化） */
  _reducedMotionPrev: {
    glassStrength: number
    glassBlur: number
    backgroundBlur: number
    listenTogetherBlur: number
  }

  /** 设置种子颜色 */
  setSourceColor: (color: string) => void
  /** 设置深浅模式（auto 时 isDark 取当前系统偏好） */
  setMode: (mode: ThemeColorMode) => void
  /** 添加自定义颜色到色板（去重、规范化为 #rrggbb、超容量挤掉最早一条） */
  addCustomColor: (color: string) => void
  /** 从色板移除自定义颜色 */
  removeCustomColor: (color: string) => void
  /** 原位更新自定义色板中的一个颜色（波形条/旋钮拖动编辑时用） */
  updateCustomColor: (oldColor: string, newColor: string) => void
  /** 设置颜色强度（0-100，越界夹取） */
  setColorIntensity: (value: number) => void
  /** 切换深浅模式 */
  toggleDark: () => void
  /** 设置深浅模式 */
  setDark: (value: boolean) => void
  /** 设置圆角预设 */
  setRadius: (value: RadiusPreset) => void
  /** 设置玻璃拟态透明度 */
  setGlassStrength: (value: number) => void
  /** 设置玻璃拟态模糊度 */
  setGlassBlur: (value: number) => void
  /** 设置精简动画模式 */
  setReducedMotion: (value: boolean) => void
  /** 设置禁用全局 hover 位移 */
  setDisableHoverTransform: (value: boolean) => void
  /** 设置自定义背景图片 */
  setBackgroundImage: (value: string | null) => void
  /** 设置背景模糊度 */
  setBackgroundBlur: (value: number) => void
  /** 设置一起听模式的背景模糊度 */
  setListenTogetherBlur: (value: number) => void
  /** 设置背景透明度 */
  setBackgroundOpacity: (value: number) => void
  /** 设置白遮罩强度 */
  setBackgroundWhiteOverlay: (value: number) => void
  /** 设置黑遮罩强度 */
  setBackgroundBlackOverlay: (value: number) => void
  /** 设置背景水平位置 */
  setBackgroundPositionX: (value: number) => void
  /** 设置背景垂直位置 */
  setBackgroundPositionY: (value: number) => void
  /** 设置背景缩放比例 */
  setBackgroundScale: (value: number) => void
  /** 设置背景旋转角度 */
  setBackgroundRotate: (value: number) => void
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      sourceColor: DEFAULT_SEED,
      isDark: false,
      mode: 'light' as ThemeColorMode,
      customColors: [] as string[],
      colorIntensity: 100,
      radius: DEFAULT_RADIUS_PRESET,
      glassStrength: 0.6,
      glassBlur: 12,
      reducedMotion: false,
      disableHoverTransform: false,
      backgroundImage: null,
      backgroundBlur: 13,
      listenTogetherBlur: 0,
      backgroundOpacity: 1,
      backgroundWhiteOverlay: 0,
      backgroundBlackOverlay: 0,
      backgroundPositionX: 0,
      backgroundPositionY: 0,
      backgroundScale: 1,
      backgroundRotate: 0,
      _reducedMotionPrev: {
        glassStrength: 0.6,
        glassBlur: 12,
        backgroundBlur: 13,
        listenTogetherBlur: 0,
      },

      setSourceColor: (color: string) => set({ sourceColor: color }),
      setMode: (mode: ThemeColorMode) =>
        set({
          mode,
          // auto 即刻物化为当前系统偏好；显式模式直接对应
          isDark: mode === 'auto' ? systemPrefersDark() : mode === 'dark',
        }),
      addCustomColor: (color: string) => {
        const hex = normalizeHexColor(color)
        if (!hex || !isValidSeedColor(hex)) return
        set((state) => {
          if (state.customColors.includes(hex)) return state
          const next = [hex, ...state.customColors]
          return { customColors: next.slice(0, MAX_CUSTOM_COLORS) }
        })
      },
      removeCustomColor: (color: string) => {
        const hex = normalizeHexColor(color)
        if (!hex) return
        set((state) => ({
          customColors: state.customColors.filter((c) => c !== hex),
        }))
      },
      updateCustomColor: (oldColor: string, newColor: string) => {
        const oldHex = normalizeHexColor(oldColor)
        const newHex = normalizeHexColor(newColor)
        if (!oldHex || !newHex) return
        set((state) => ({
          customColors: state.customColors.map((c) =>
            c === oldHex ? newHex : c
          ),
        }))
      },
      setColorIntensity: (value: number) =>
        set({
          colorIntensity: Math.min(100, Math.max(0, Math.round(value))),
        }),
      toggleDark: () =>
        set((state) => ({
          isDark: !state.isDark,
          mode: !state.isDark ? 'dark' : 'light',
        })),
      setDark: (value: boolean) =>
        set({ isDark: value, mode: value ? 'dark' : 'light' }),
      setRadius: (value: RadiusPreset) => set({ radius: value }),
      setGlassStrength: (value: number) => set({ glassStrength: value }),
      setGlassBlur: (value: number) => set({ glassBlur: value }),
      setReducedMotion: (value: boolean) =>
        set((state) => {
          if (value) {
            // 开启精简动画：保存当前值并锁定为玻璃不透明、卡片无模糊、背景无模糊
            return {
              reducedMotion: true,
              _reducedMotionPrev: {
                glassStrength: state.glassStrength,
                glassBlur: state.glassBlur,
                backgroundBlur: state.backgroundBlur,
                listenTogetherBlur: state.listenTogetherBlur,
              },
              glassStrength: 1,
              glassBlur: 0,
              backgroundBlur: 0,
              listenTogetherBlur: 0,
            }
          }
          // 关闭精简动画：恢复之前保存的参数
          const prev = state._reducedMotionPrev
          return {
            reducedMotion: false,
            glassStrength: prev.glassStrength,
            glassBlur: prev.glassBlur,
            backgroundBlur: prev.backgroundBlur,
            listenTogetherBlur: prev.listenTogetherBlur,
          }
        }),
      setBackgroundImage: (value: string | null) =>
        set({ backgroundImage: value }),
      setDisableHoverTransform: (value: boolean) =>
        set({ disableHoverTransform: value }),
      setBackgroundBlur: (value: number) => set({ backgroundBlur: value }),
      setListenTogetherBlur: (value: number) =>
        set({ listenTogetherBlur: value }),
      setBackgroundOpacity: (value: number) =>
        set({ backgroundOpacity: value }),
      setBackgroundWhiteOverlay: (value: number) =>
        set({ backgroundWhiteOverlay: value }),
      setBackgroundBlackOverlay: (value: number) =>
        set({ backgroundBlackOverlay: value }),
      setBackgroundPositionX: (value: number) =>
        set({ backgroundPositionX: value }),
      setBackgroundPositionY: (value: number) =>
        set({ backgroundPositionY: value }),
      setBackgroundScale: (value: number) => set({ backgroundScale: value }),
      setBackgroundRotate: (value: number) => set({ backgroundRotate: value }),
    }),
    {
      name: 'zcontrol-theme-storage',
      partialize: (state) => ({
        sourceColor: state.sourceColor,
        isDark: state.isDark,
        mode: state.mode,
        customColors: state.customColors,
        colorIntensity: state.colorIntensity,
        radius: state.radius,
        glassStrength: state.glassStrength,
        glassBlur: state.glassBlur,
        reducedMotion: state.reducedMotion,
        disableHoverTransform: state.disableHoverTransform,
        // 自定义背景同时持久化 URL 与 base64 数据（用户上传图片在 5MB 限制内）
        backgroundImage: state.backgroundImage,
        backgroundBlur: state.backgroundBlur,
        listenTogetherBlur: state.listenTogetherBlur,
        backgroundOpacity: state.backgroundOpacity,
        backgroundWhiteOverlay: state.backgroundWhiteOverlay,
        backgroundBlackOverlay: state.backgroundBlackOverlay,
        backgroundPositionX: state.backgroundPositionX,
        backgroundPositionY: state.backgroundPositionY,
        backgroundScale: state.backgroundScale,
        backgroundRotate: state.backgroundRotate,
        // 注意：_reducedMotionPrev 不持久化，仅运行时缓存
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<ThemeState>
        return {
          ...current,
          ...p,
          radius: migrateRadius(p.radius),
          // 旧版本存储只有 isDark：迁移为显式 mode（不凭空猜 auto），
          // mode 缺失时 light/dark 与 isDark 保持一致
          mode:
            p.mode ??
            (p.isDark === undefined ? 'light' : p.isDark ? 'dark' : 'light'),
        }
      },
    }
  )
)
