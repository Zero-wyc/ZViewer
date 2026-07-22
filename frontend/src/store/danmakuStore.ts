import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { DanmakuItem, DanmakuSource } from '@/modules/danmaku/types'

export interface DanmakuTrack {
  trackId: string
  label: string
  source: DanmakuSource
  items: DanmakuItem[]
  offset: number
  /** 是否暂时隐藏该轨道的弹幕 */
  hidden?: boolean
}

export interface DanmakuTypeFilters {
  scroll: boolean
  fixed: boolean
  color: boolean
  advanced: boolean
}

export interface DanmakuAdvancedStyle {
  fontFamily: string
  strokeWidth: number
  shadowBlur: number
  density: number
}

export interface DanmakuStyleState {
  filters: DanmakuTypeFilters
  scaleWithScreen: boolean
  displayArea: number
  opacity: number
  fontSize: number
  speed: number
  advanced: DanmakuAdvancedStyle
}

export const DEFAULT_DANMAKU_STYLE: DanmakuStyleState = {
  filters: {
    scroll: true,
    fixed: true,
    color: true,
    advanced: true,
  },
  // 默认不随屏幕缩放：弹幕字号固定为用户设置的 fontSize，
  // 不根据视频容器尺寸自动放大，避免不同分辨率下字号不可预测
  scaleWithScreen: false,
  displayArea: 0.75,
  opacity: 1,
  fontSize: 25,
  speed: 1,
  advanced: {
    fontFamily:
      '"Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif',
    strokeWidth: 0,
    shadowBlur: 2,
    density: 1,
  },
}

interface DanmakuState {
  tracks: DanmakuTrack[]
  style: DanmakuStyleState
  addTrack: (
    trackId: string,
    label: string,
    source: DanmakuSource,
    items: DanmakuItem[],
    offset?: number
  ) => void
  removeTrack: (trackId: string) => void
  updateTrackOffset: (trackId: string, offset: number) => void
  toggleTrackHidden: (trackId: string) => void
  setDefaultTrack: (items: DanmakuItem[]) => void
  setStyle: (updates: Partial<DanmakuStyleState>) => void
  setFilters: (updates: Partial<DanmakuTypeFilters>) => void
  setAdvancedStyle: (updates: Partial<DanmakuAdvancedStyle>) => void
  resetStyle: () => void
}

export const useDanmakuStore = create<DanmakuState>()(
  persist(
    (set, get) => ({
      tracks: [],
      style: DEFAULT_DANMAKU_STYLE,

      addTrack: (trackId, label, source, items, offset = 0) => {
        set((state) => {
          const exists = state.tracks.findIndex((t) => t.trackId === trackId)
          const next: DanmakuTrack = {
            trackId,
            label,
            source,
            items: [...items].sort((a, b) => a.time - b.time),
            offset,
          }
          if (exists >= 0) {
            const tracks = [...state.tracks]
            tracks[exists] = next
            return { tracks }
          }
          return { tracks: [...state.tracks, next] }
        })
      },

      removeTrack: (trackId) => {
        set((state) => ({
          tracks: state.tracks.filter((t) => t.trackId !== trackId),
        }))
      },

      updateTrackOffset: (trackId, offset) => {
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.trackId === trackId ? { ...t, offset } : t
          ),
        }))
      },

      toggleTrackHidden: (trackId) => {
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.trackId === trackId ? { ...t, hidden: !t.hidden } : t
          ),
        }))
      },

      setDefaultTrack: (items) => {
        get().addTrack('default', '当前视频', 'bilibili', items, 0)
      },

      setStyle: (updates) => {
        set((state) => ({ style: { ...state.style, ...updates } }))
      },

      setFilters: (updates) => {
        set((state) => ({
          style: {
            ...state.style,
            filters: { ...state.style.filters, ...updates },
          },
        }))
      },

      setAdvancedStyle: (updates) => {
        set((state) => ({
          style: {
            ...state.style,
            advanced: { ...state.style.advanced, ...updates },
          },
        }))
      },

      resetStyle: () => {
        set({ style: DEFAULT_DANMAKU_STYLE })
      },
    }),
    {
      name: 'danmaku-storage',
      version: 1,
      partialize: (state) => ({ style: state.style }),
      migrate: (persisted: unknown): Partial<DanmakuState> => {
        const data = (persisted ?? {}) as Partial<DanmakuState>
        const style = { ...(data.style ?? {}) } as Record<string, unknown>
        // v0 -> v1: 清除已删除的 avoidSubtitle 字段，
        // 并重置 scaleWithScreen 让其回退到新默认值 false
        delete style.avoidSubtitle
        delete style.scaleWithScreen
        return { ...data, style: style as unknown as DanmakuStyleState }
      },
    }
  )
)
