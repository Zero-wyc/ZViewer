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
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      sourceColor: DEFAULT_SEED,
      isDark: false,
      radius: DEFAULT_RADIUS_PRESET,
      glassStrength: 0.6,

      setSourceColor: (color: string) => set({ sourceColor: color }),
      toggleDark: () => set((state) => ({ isDark: !state.isDark })),
      setDark: (value: boolean) => set({ isDark: value }),
      setRadius: (value: RadiusPreset) => set({ radius: value }),
      setGlassStrength: (value: number) => set({ glassStrength: value }),
    }),
    {
      name: 'zcontrol-theme-storage',
      partialize: (state) => ({
        sourceColor: state.sourceColor,
        isDark: state.isDark,
        radius: state.radius,
        glassStrength: state.glassStrength,
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
