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
  /** 玻璃拟态背景强度，0-1 */
  glassStrength: number

  /** 自定义背景图片（URL 或 Base64），null 表示未设置 */
  backgroundImage: string | null
  /** 背景模糊度，0~20px */
  backgroundBlur: number
  /** 背景透明度，0~1 */
  backgroundOpacity: number
  /** 背景水平位置，-100~100% */
  backgroundPositionX: number
  /** 背景垂直位置，-100~100% */
  backgroundPositionY: number
  /** 背景缩放比例，0.5~2 */
  backgroundScale: number
  /** 背景旋转角度，0~360° */
  backgroundRotate: number

  /** 设置种子颜色 */
  setSourceColor: (color: string) => void
  /** 切换深浅模式 */
  toggleDark: () => void
  /** 设置深浅模式 */
  setDark: (value: boolean) => void
  /** 设置圆角预设 */
  setRadius: (value: RadiusPreset) => void
  /** 设置玻璃拟态强度 */
  setGlassStrength: (value: number) => void
  /** 设置自定义背景图片 */
  setBackgroundImage: (value: string | null) => void
  /** 设置背景模糊度 */
  setBackgroundBlur: (value: number) => void
  /** 设置背景透明度 */
  setBackgroundOpacity: (value: number) => void
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
      backgroundImage: null,
      backgroundBlur: 0,
      backgroundOpacity: 1,
      backgroundPositionX: 0,
      backgroundPositionY: 0,
      backgroundScale: 1,
      backgroundRotate: 0,

      setSourceColor: (color: string) => set({ sourceColor: color }),
      toggleDark: () => set((state) => ({ isDark: !state.isDark })),
      setDark: (value: boolean) => set({ isDark: value }),
      setRadius: (value: RadiusPreset) => set({ radius: value }),
      setGlassStrength: (value: number) => set({ glassStrength: value }),
      setBackgroundImage: (value: string | null) =>
        set({ backgroundImage: value }),
      setBackgroundBlur: (value: number) => set({ backgroundBlur: value }),
      setBackgroundOpacity: (value: number) =>
        set({ backgroundOpacity: value }),
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
        backgroundImage: state.backgroundImage,
        backgroundBlur: state.backgroundBlur,
        backgroundOpacity: state.backgroundOpacity,
        backgroundPositionX: state.backgroundPositionX,
        backgroundPositionY: state.backgroundPositionY,
        backgroundScale: state.backgroundScale,
        backgroundRotate: state.backgroundRotate,
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
