import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BilibiliDanmakuItem } from '@/modules/room/watch-together/danmakuEngine'

export interface DanmakuTrack {
  trackId: string
  label: string
  items: BilibiliDanmakuItem[]
  offset: number
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
  avoidSubtitle: boolean
  avoidCollision: boolean
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
  scaleWithScreen: true,
  avoidSubtitle: false,
  avoidCollision: true,
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
    items: BilibiliDanmakuItem[],
    offset?: number
  ) => void
  removeTrack: (trackId: string) => void
  updateTrackOffset: (trackId: string, offset: number) => void
  setDefaultTrack: (items: BilibiliDanmakuItem[]) => void
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

      addTrack: (trackId, label, items, offset = 0) => {
        set((state) => {
          const exists = state.tracks.findIndex((t) => t.trackId === trackId)
          const next: DanmakuTrack = {
            trackId,
            label,
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

      setDefaultTrack: (items) => {
        get().addTrack('default', '当前视频', items, 0)
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
      partialize: (state) => ({ style: state.style }),
    }
  )
)
