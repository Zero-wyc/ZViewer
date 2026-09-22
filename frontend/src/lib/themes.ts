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
