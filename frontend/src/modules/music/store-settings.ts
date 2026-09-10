/**
 * 音乐设置 store（Hydrogen settingsSchema / settingsDefaults 的 Web 适配）。
 *
 * 与 Hydrogen 的差异：
 * - 持久化：Electron 用主进程 settings 文件，这里用 zustand persist 落
 *   localStorage（key `zviewer-music-settings`）
 * - 保存时机：Hydrogen 是「离开页面保存」；Web 环境改为改动即生效即保存
 *   （设置页顶部的保存提示仅保留复刻样式，点击为即时保存的反馈）
 * - 仅保留 Web 环境有意义的「音乐」分组；本地目录 / 快捷键 / 退出行为等
 *   Electron 专属项不迁移
 * - coverBlur 默认 true：ZViewer 播放器覆盖层本就默认渲染毛玻璃封面背景
 *   （Hydrogen 默认 false），保持现有视觉，设置项用于关闭
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 音质档位（Hydrogen musicLevelOptions 九档，值与网易云 level 参数一致） */
export const MUSIC_LEVEL_OPTIONS = [
  { label: '标准', value: 'standard' },
  { label: '较高', value: 'higher' },
  { label: '极高', value: 'exhigh' },
  { label: '无损', value: 'lossless' },
  { label: 'Hi-Res', value: 'hires' },
  { label: '高清环绕声', value: 'jyeffect' },
  { label: '沉浸环绕声', value: 'sky' },
  { label: '杜比全景声', value: 'dolby' },
  { label: '超清母带', value: 'jymaster' },
] as const

export interface MusicSettings {
  /** 播放音质（网易云 level 参数；后端 stream 按档位降级取流） */
  level: string
  /** 播放器毛玻璃封面背景（关闭后覆盖层仅剩纯色底） */
  coverBlur: boolean
  /** 歌词模糊（非当前行 blur，当前行保持清晰） */
  lyricBlur: boolean
  /** 显示歌曲翻译（/lyric tlyric） */
  showSongTranslation: boolean
  /** 歌曲无缝衔接（预缓冲下一首音频） */
  gaplessPlayback: boolean
  /** 音频可视化（播放器底部 EQ 频谱动画） */
  audioVisualizer: boolean
  /** 搜索联想下拉条目数量 */
  searchAssistLimit: number
  /** 歌词字体大小（px） */
  lyricSize: number
  /** 歌词翻译字体大小（px） */
  tlyricSize: number
  /** 罗马歌词字体大小（px） */
  rlyricSize: number
  /** 歌词间奏倒计时判定阈值（秒） */
  lyricInterlude: number
}

export const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  level: 'lossless',
  coverBlur: true,
  lyricBlur: false,
  showSongTranslation: true,
  gaplessPlayback: false,
  audioVisualizer: false,
  searchAssistLimit: 8,
  lyricSize: 20,
  tlyricSize: 14,
  rlyricSize: 12,
  lyricInterlude: 13,
}

interface MusicSettingsState extends MusicSettings {
  /** 局部更新（改动即持久化） */
  set: (patch: Partial<MusicSettings>) => void
  /** 恢复全部默认 */
  reset: () => void
}

export const useMusicSettingsStore = create<MusicSettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_MUSIC_SETTINGS,
      set: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_MUSIC_SETTINGS }),
    }),
    { name: 'zviewer-music-settings', version: 1 }
  )
)

/** 数字设置收敛（≥1 整数，非法回退默认值） */
export function normalizeNumberSetting(
  value: number,
  fallback: number
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

/** 音质档位合法性（非法值回退默认无损） */
export function normalizeMusicLevel(level: string): string {
  return MUSIC_LEVEL_OPTIONS.some((o) => o.value === level)
    ? level
    : DEFAULT_MUSIC_SETTINGS.level
}
