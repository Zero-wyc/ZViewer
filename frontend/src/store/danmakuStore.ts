import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { apiFetch, safeJson } from '@/lib/api'
import type { DanmakuItem, DanmakuSource } from '@/modules/danmaku/types'
import { t as translate } from '@/i18n'

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

/** 实时弹幕记录（房间内用户互发），用于弹幕列表面板展示 */
export interface RealtimeDanmakuEntry {
  id: string
  content: string
  sender?: string
  /** 发送时的播放进度（秒） */
  time?: number
  /** 是否本人发送（仅本地状态，不持久化） */
  self?: boolean
}

/** 实时弹幕记录本地缓冲上限（超出后丢弃最旧的，后端同样限 500 条） */
const REALTIME_LOG_LIMIT = 500
/** 已删除弹幕记录上限 */
const DELETED_LOG_LIMIT = 200

/** 已删除弹幕记录（用于管理面板展示与恢复） */
export interface DeletedDanmakuEntry {
  trackId: string
  trackLabel: string
  item: DanmakuItem
}

/** 房间弹幕辅助数据（与后端 DanmakuMetaDto 对齐） */
export interface DanmakuMeta {
  blockKeywords: string[]
  deletedLog: DeletedDanmakuEntry[]
  realtimeLog: RealtimeDanmakuEntry[]
}

interface DanmakuState {
  tracks: DanmakuTrack[]
  style: DanmakuStyleState
  /** 当前房间 ID，用于调用弹幕轨道 API */
  roomId: string | null
  /** 是否正在与后端同步轨道 */
  syncing: boolean
  /** 实时弹幕记录（按房间持久化，由后端推送同步） */
  realtimeLog: RealtimeDanmakuEntry[]
  /** 弹幕屏蔽关键词（按房间持久化，由后端推送同步） */
  blockKeywords: string[]
  /** 已删除弹幕记录（按房间持久化，由后端推送同步） */
  deletedLog: DeletedDanmakuEntry[]
  /** 弹幕层刷新信号（侧栏屏蔽/删除后通知播放器弹幕层清屏重载） */
  refreshSignal: number
  triggerDanmakuRefresh: () => void
  /** 设置当前房间 ID */
  setRoomId: (roomId: string | null) => void
  /** 从后端加载当前房间的弹幕轨道 */
  loadTracks: (roomId: string) => Promise<void>
  /** 直接用后端推送的轨道列表替换本地状态（socket 同步） */
  setTracks: (tracks: DanmakuTrack[]) => void
  /** 从后端加载房间的弹幕辅助数据（屏蔽词/已删除/实时弹幕记录） */
  loadMeta: (roomId: string) => Promise<void>
  /** 直接用后端推送的辅助数据替换本地状态（socket 同步） */
  setMeta: (meta: DanmakuMeta) => void
  addTrack: (
    trackId: string,
    label: string,
    source: DanmakuSource,
    items: DanmakuItem[],
    offset?: number
  ) => Promise<void>
  removeTrack: (trackId: string) => Promise<void>
  updateTrackOffset: (trackId: string, offset: number) => Promise<void>
  toggleTrackHidden: (trackId: string) => Promise<void>
  setDefaultTrack: (items: DanmakuItem[]) => Promise<void>
  setStyle: (updates: Partial<DanmakuStyleState>) => void
  setFilters: (updates: Partial<DanmakuTypeFilters>) => void
  setAdvancedStyle: (updates: Partial<DanmakuAdvancedStyle>) => void
  resetStyle: () => void
  /**
   * 本地立即追加实时弹幕记录（发送者视角）。
   * 后端通过 send-danmaku 持久化并广播 danmaku-meta-updated，会覆盖此条目
   * （self 字段不持久化，仅用于发送者本地立即看到自己的弹幕）。
   */
  addRealtime: (entry: RealtimeDanmakuEntry) => void
  clearRealtime: () => void
  removeRealtime: (id: string) => void
  addBlockKeyword: (keyword: string) => Promise<void>
  removeBlockKeyword: (keyword: string) => Promise<void>
  /** 从时间轴轨道中删除指定弹幕项（本地生效，用于弹幕列表管理） */
  removeTrackItem: (trackId: string, itemId: string) => void
  restoreTrackItem: (trackId: string, item: DanmakuItem) => void
  addDeletedLog: (entry: DeletedDanmakuEntry) => Promise<void>
  removeDeletedLog: (trackId: string, itemId: string) => Promise<void>
  clearDeletedLog: () => Promise<void>
  /** 私有：整体替换屏蔽词和已删除弹幕（调用后端 API） */
  persistMeta: (updates: {
    blockKeywords?: string[]
    deletedLog?: DeletedDanmakuEntry[]
  }) => Promise<void>
}

export const useDanmakuStore = create<DanmakuState>()(
  persist(
    (set, get) => ({
      tracks: [],
      style: DEFAULT_DANMAKU_STYLE,
      roomId: null,
      syncing: false,
      realtimeLog: [],
      blockKeywords: [],
      deletedLog: [],
      refreshSignal: 0,
      triggerDanmakuRefresh: () => {
        set((state) => ({ refreshSignal: state.refreshSignal + 1 }))
      },

      setRoomId: (roomId) => {
        set({ roomId })
      },

      loadTracks: async (roomId) => {
        set({ syncing: true, roomId })
        try {
          const res = await apiFetch(
            `/api/rooms/${encodeURIComponent(roomId)}/danmaku-tracks`
          )
          const data = await safeJson<{
            success: boolean
            tracks?: DanmakuTrack[]
            message?: string
          }>(res, { success: false })
          if (data.success && Array.isArray(data.tracks)) {
            // 按 trackId 去重：后端历史可能因重复 setDefaultTrack 调用
            // 累积多条相同 trackId 的记录，保留最后一条（最新的）
            const byId = new Map<string, DanmakuTrack>()
            for (const t of data.tracks) {
              const items = Array.isArray(t.items)
                ? [...t.items].sort((a, b) => a.time - b.time)
                : []
              byId.set(t.trackId, { ...t, items })
            }
            set({ tracks: Array.from(byId.values()) })
          } else {
            console.error('[danmakuStore] load tracks failed:', data.message)
          }
        } catch (err) {
          console.error('[danmakuStore] load tracks error:', err)
        } finally {
          set({ syncing: false })
        }
      },

      setTracks: (tracks) => {
        // 按 trackId 去重，保留最后一条（与 loadTracks 保持一致）
        const byId = new Map<string, DanmakuTrack>()
        for (const t of tracks) {
          const items = Array.isArray(t.items)
            ? [...t.items].sort((a, b) => a.time - b.time)
            : []
          byId.set(t.trackId, { ...t, items })
        }
        set({ tracks: Array.from(byId.values()) })
      },

      loadMeta: async (roomId) => {
        try {
          const res = await apiFetch(
            `/api/rooms/${encodeURIComponent(roomId)}/danmaku-meta`
          )
          const data = await safeJson<{
            success: boolean
            meta?: DanmakuMeta
            message?: string
          }>(res, { success: false })
          if (data.success && data.meta) {
            // 保留本地 self 标记：用本地 realtimeLog 中的 self 标记覆盖后端推送的
            const localSelfIds = new Set(
              get()
                .realtimeLog.filter((e) => e.self)
                .map((e) => e.id)
            )
            set({
              blockKeywords: data.meta.blockKeywords ?? [],
              deletedLog: (data.meta.deletedLog ?? []) as DeletedDanmakuEntry[],
              realtimeLog: (data.meta.realtimeLog ?? []).map((e) => ({
                ...e,
                self: localSelfIds.has(e.id) ? true : e.self,
              })),
            })
          } else {
            console.error('[danmakuStore] load meta failed:', data.message)
          }
        } catch (err) {
          console.error('[danmakuStore] load meta error:', err)
        }
      },

      setMeta: (meta) => {
        // 保留本地 self 标记，避免发送者视角被覆盖
        const localSelfIds = new Set(
          get()
            .realtimeLog.filter((e) => e.self)
            .map((e) => e.id)
        )
        set({
          blockKeywords: meta.blockKeywords ?? [],
          deletedLog: meta.deletedLog ?? [],
          realtimeLog: (meta.realtimeLog ?? []).map((e) => ({
            ...e,
            self: localSelfIds.has(e.id) ? true : e.self,
          })),
        })
      },

      persistMeta: async (updates) => {
        const roomId = get().roomId
        if (!roomId) return
        try {
          const res = await apiFetch(
            `/api/rooms/${encodeURIComponent(roomId)}/danmaku-meta`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(updates),
            }
          )
          const data = await safeJson<{
            success: boolean
            message?: string
          }>(res, { success: false })
          if (!data.success) {
            console.error('[danmakuStore] persist meta failed:', data.message)
          }
        } catch (err) {
          console.error('[danmakuStore] persist meta error:', err)
        }
      },

      addTrack: async (trackId, label, source, items, offset = 0) => {
        const roomId = get().roomId
        // 先乐观更新本地状态，让观众/房主立即看到效果
        const next: DanmakuTrack = {
          trackId,
          label,
          source,
          items: [...items].sort((a, b) => a.time - b.time),
          offset,
          hidden: false,
        }
        set((state) => {
          const exists = state.tracks.findIndex((t) => t.trackId === trackId)
          if (exists >= 0) {
            const tracks = [...state.tracks]
            tracks[exists] = next
            return { tracks }
          }
          return { tracks: [...state.tracks, next] }
        })

        if (!roomId) return
        try {
          const res = await apiFetch(
            `/api/rooms/${encodeURIComponent(roomId)}/danmaku-tracks`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                trackId,
                label,
                source,
                items,
                offset,
                hidden: false,
              }),
            }
          )
          const data = await safeJson<{
            success: boolean
            message?: string
          }>(res, { success: false })
          if (!data.success) {
            console.error('[danmakuStore] add track failed:', data.message)
          }
        } catch (err) {
          console.error('[danmakuStore] add track error:', err)
        }
      },

      removeTrack: async (trackId) => {
        const roomId = get().roomId
        set((state) => ({
          tracks: state.tracks.filter((t) => t.trackId !== trackId),
          // 删除整条轨道后同步触发刷新信号，让播放器立即清屏并按当前时间
          // 重发剩余轨道的弹幕，避免已飞出的弹幕继续残留在画面上。
          refreshSignal: state.refreshSignal + 1,
        }))
        if (!roomId) return
        try {
          const res = await apiFetch(
            `/api/rooms/${encodeURIComponent(roomId)}/danmaku-tracks/${encodeURIComponent(trackId)}`,
            { method: 'DELETE' }
          )
          const data = await safeJson<{
            success: boolean
            message?: string
          }>(res, { success: false })
          if (!data.success) {
            console.error('[danmakuStore] remove track failed:', data.message)
          }
        } catch (err) {
          console.error('[danmakuStore] remove track error:', err)
        }
      },

      updateTrackOffset: async (trackId, offset) => {
        const roomId = get().roomId
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.trackId === trackId ? { ...t, offset } : t
          ),
        }))
        if (!roomId) return
        try {
          const res = await apiFetch(
            `/api/rooms/${encodeURIComponent(roomId)}/danmaku-tracks/${encodeURIComponent(trackId)}/offset`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ offset }),
            }
          )
          const data = await safeJson<{
            success: boolean
            message?: string
          }>(res, { success: false })
          if (!data.success) {
            console.error('[danmakuStore] update offset failed:', data.message)
          }
        } catch (err) {
          console.error('[danmakuStore] update offset error:', err)
        }
      },

      toggleTrackHidden: async (trackId) => {
        const roomId = get().roomId
        let hidden = false
        set((state) => ({
          tracks: state.tracks.map((t) => {
            if (t.trackId !== trackId) return t
            hidden = !t.hidden
            return { ...t, hidden }
          }),
        }))
        if (!roomId) return
        try {
          const res = await apiFetch(
            `/api/rooms/${encodeURIComponent(roomId)}/danmaku-tracks/${encodeURIComponent(trackId)}/offset`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ hidden }),
            }
          )
          const data = await safeJson<{
            success: boolean
            message?: string
          }>(res, { success: false })
          if (!data.success) {
            console.error('[danmakuStore] toggle hidden failed:', data.message)
          }
        } catch (err) {
          console.error('[danmakuStore] toggle hidden error:', err)
        }
      },

      setDefaultTrack: async (items) => {
        // items 为空时删除 default 轨道，避免空房间显示空轨道。
        // 非空时走 upsert（后端按 trackId 去重）。
        if (items.length === 0) {
          await get().removeTrack('default')
          return
        }
        await get().addTrack(
          'default',
          translate('当前视频'),
          'bilibili-video',
          items,
          0
        )
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

      addRealtime: (entry) => {
        set((state) => {
          const next = [...state.realtimeLog, entry]
          if (next.length > REALTIME_LOG_LIMIT) {
            next.splice(0, next.length - REALTIME_LOG_LIMIT)
          }
          return { realtimeLog: next }
        })
      },

      clearRealtime: () => {
        set({ realtimeLog: [] })
      },

      removeRealtime: (id) => {
        set((state) => ({
          realtimeLog: state.realtimeLog.filter((entry) => entry.id !== id),
        }))
      },

      addBlockKeyword: async (keyword) => {
        const trimmed = keyword.trim()
        if (!trimmed) return
        let shouldPersist = false
        let nextKeywords: string[] = []
        set((state) => {
          if (state.blockKeywords.includes(trimmed)) return state
          shouldPersist = true
          nextKeywords = [...state.blockKeywords, trimmed]
          return { blockKeywords: nextKeywords }
        })
        if (shouldPersist) {
          await get().persistMeta({ blockKeywords: nextKeywords })
        }
      },

      removeBlockKeyword: async (keyword) => {
        let nextKeywords: string[] = []
        set((state) => {
          nextKeywords = state.blockKeywords.filter((k) => k !== keyword)
          return { blockKeywords: nextKeywords }
        })
        await get().persistMeta({ blockKeywords: nextKeywords })
      },

      removeTrackItem: (trackId, itemId) => {
        set((state) => ({
          tracks: state.tracks.map((t) =>
            t.trackId === trackId
              ? { ...t, items: t.items.filter((item) => item.id !== itemId) }
              : t
          ),
          // 同步触发刷新信号，确保播放器弹幕层在删除后立即清屏重载
          refreshSignal: state.refreshSignal + 1,
        }))
      },

      restoreTrackItem: (trackId, item) => {
        set((state) => ({
          tracks: state.tracks.map((t) => {
            if (t.trackId !== trackId) return t
            if (t.items.some((i) => i.id === item.id)) return t
            const next = [...t.items, item]
            next.sort((a, b) => a.time - b.time)
            return { ...t, items: next }
          }),
          // 同步触发刷新信号，确保恢复的弹幕立即生效
          refreshSignal: state.refreshSignal + 1,
        }))
      },

      addDeletedLog: async (entry) => {
        let nextLog: DeletedDanmakuEntry[] = []
        set((state) => {
          const exists = state.deletedLog.some(
            (d) => d.trackId === entry.trackId && d.item.id === entry.item.id
          )
          if (exists) return state
          nextLog = [...state.deletedLog, entry]
          if (nextLog.length > DELETED_LOG_LIMIT) {
            nextLog.splice(0, nextLog.length - DELETED_LOG_LIMIT)
          }
          return { deletedLog: nextLog }
        })
        if (nextLog.length > 0) {
          await get().persistMeta({ deletedLog: nextLog })
        }
      },

      removeDeletedLog: async (trackId, itemId) => {
        let nextLog: DeletedDanmakuEntry[] = []
        set((state) => {
          nextLog = state.deletedLog.filter(
            (d) => !(d.trackId === trackId && d.item.id === itemId)
          )
          return { deletedLog: nextLog }
        })
        await get().persistMeta({ deletedLog: nextLog })
      },

      clearDeletedLog: async () => {
        set({ deletedLog: [] })
        await get().persistMeta({ deletedLog: [] })
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
