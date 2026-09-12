import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_SEED } from '@/lib/themes'

export type RadiusPreset = 'small' | 'medium' | 'large' | 'none'

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
  /** 是否深色模式 */
  isDark: boolean
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
      toggleDark: () => set((state) => ({ isDark: !state.isDark })),
      setDark: (value: boolean) => set({ isDark: value }),
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
        }
      },
    }
  )
)
