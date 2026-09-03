import { create } from 'zustand'
import { apiFetch, safeJson } from '@/lib/api'
import type {
  ResolvedSource,
  QualityOption,
} from '@/modules/room/watch-together/resolveSource'
import type { BilibiliVideoPage } from '@/modules/bilibili/types'
import type { MediaFormat } from '@/lib/mediaFormat'
import type { WatchTogetherState } from '@/modules/sync-playback/types'
import type { AniSubsEpisode } from '@/modules/anisubs/types'

/**
 * ani-subs 番剧源元数据。
 *
 * 存储 sourceId 和 episode 信息，用于播放时重新解析播放地址。
 * 仅 sourceType='anime' 时有值。
 * ani-subs 的视频地址通常带 token/signature，短期有效，
 * 刷新后需要通过 sourceMeta 重新解析，而非使用过期的 URL。
 */
export interface AniSubsSourceMeta {
  sourceId: string
  episode: AniSubsEpisode
  originalTitle: string
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export interface Viewer {
  socketId: string
  userId?: number
  username?: string
  // socket.data.role: 'root' | 'admin' | 'user' | 'guest'
  role?: string
  // 是否被禁言（由房主端基于 mutedViewerIds 计算）
  muted?: boolean
}

export type RoomMode = 'screen-share' | 'watch-together'
export type ShareMethod = 'webrtc' | 'stream-push'

/** OBS 推流状态 */
export type StreamStatus = 'live' | 'offline' | 'unknown'

export interface RoomSettings {
  password: string | null
  maxViewers: number
  requireApproval: boolean
}

export type MovieSourceType =
  'bilibili' | 'mp4' | 'webdav' | 'ftp' | 'openlist' | 'smb' | string

export interface Movie {
  id: number
  sourceType: MovieSourceType
  title: string
  url: string
  cover?: string | null
  order?: number
  createdAt: string
  updatedAt?: string
  // 源类型特有参数
  serverUrl?: string | null
  path?: string | null
  username?: string | null
  directLink?: boolean
  // 以下为前端解析得到的临时字段（不持久化到后端）
  cid?: number
  duration?: number
  videoUrl?: string
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  /** 媒体容器格式。FTP/WebDAV/OpenList 可能返回 mkv/avi 等浏览器不支持的格式。 */
  format?: MediaFormat
  quality?: string
  // 持久化的清晰度信息
  currentQn?: number
  acceptQuality?: { id: number; label: string; resolution?: string }[]
  /** 多 P 视频的分集列表（单 P 视频为 undefined） */
  pages?: BilibiliVideoPage[]
  /** 当前播放的分集序号（从 1 开始，默认 1） */
  currentPage?: number
  /**
   * ani-subs 番剧源元数据。
   * 仅 sourceType='anime' 时有值，用于播放时重新解析播放地址。
   */
  sourceMeta?: AniSubsSourceMeta | null
}

export interface MovieDto {
  id: number
  roomId: string
  url: string
  title: string
  cover: string | null
  source: string | null
  audioUrl: string | null
  format: string | null
  videoCodec: string | null
  audioCodec: string | null
  duration: number | null
  cid: number | null
  currentQn: number | null
  acceptQuality: { id: number; label: string; resolution?: string }[] | null
  pages: { page: number; cid: number; part: string; duration: number }[] | null
  currentPage: number | null
  serverUrl: string | null
  path: string | null
  username: string | null
  directLink: boolean
  /** ani-subs 番剧源元数据（仅 source='anime' 时有值） */
  sourceMeta: AniSubsSourceMeta | null
  order: number
  createdAt: string
  updatedAt: string
}

export function mapDtoToMovie(dto: MovieDto): Movie {
  const sourceType = (dto.source as MovieSourceType) || 'mp4'
  return {
    id: dto.id,
    sourceType,
    title: dto.title,
    url: dto.url,
    cover: dto.cover,
    order: dto.order,
    serverUrl: dto.serverUrl,
    path: dto.path,
    username: dto.username,
    directLink: dto.directLink,
    audioUrl: dto.audioUrl ?? undefined,
    format: (dto.format as Movie['format']) ?? undefined,
    videoCodec: dto.videoCodec ?? undefined,
    audioCodec: dto.audioCodec ?? undefined,
    duration: dto.duration ?? undefined,
    cid: dto.cid ?? undefined,
    currentQn: dto.currentQn ?? undefined,
    acceptQuality: dto.acceptQuality ?? undefined,
    pages: dto.pages ?? undefined,
    currentPage: dto.currentPage ?? undefined,
    sourceMeta: dto.sourceMeta ?? null,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const data = await safeJson<T>(res, {} as T)
  return data
}

// WatchTogetherState 的唯一权威定义在 sync-playback/types.ts，
// 此处 re-export 以保持向后兼容的导入路径（`import type { WatchTogetherState } from '@/store/roomStore'`）。
export type { WatchTogetherState }

/**
 * 预览播放请求：由 MoviePushPanel 等外部组件写入 store，
 * useWatchTogether 通过 effect 监听并调用内部 previewPlay 方法执行实际加载。
 * 用于解耦 UI 触发点与 useWatchTogether（后者在 WatchTogetherPanel 内部调用）。
 */
export interface PreviewPlayRequest {
  url: string
  title?: string
  sourceType?: string
  format?: MediaFormat
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  headers?: Record<string, string>
  duration?: number
}

interface RoomState {
  roomId: string
  roomName: string
  password: string
  maxViewers: number
  mode: RoomMode
  /**
   * 当前活跃房间 ID。
   * - 用户进入房间时设置（房主创建/观众加入）
   * - 用户导航到非房间页面（如个人中心）时保留，RoomPage 卸载但不清除
   * - 用户明确退出房间（点击返回按钮）时清除为 null
   * 前端据此在非房间页面右上角显示"回到房间"浮动入口。
   */
  activeRoomId: string | null
  setActiveRoomId: (id: string | null) => void
  // 投屏模式（mode === 'screen-share'）下的子模式
  shareMethod: ShareMethod
  viewers: Viewer[]
  // 被禁言观众 userId 列表（仅房主维护，观众端不展示）
  mutedViewerIds: number[]
  // 房间运行时设置（密码/上限/审批开关）
  roomSettings: RoomSettings
  isSharing: boolean
  isPaused: boolean
  watchTogether: WatchTogetherState
  movies: Movie[]
  currentMovieId: number | null
  pendingQualityChange: { movieId: number; resolved: ResolvedSource } | null
  /**
   * 观众端通过本地 CLI 自主切换的清晰度解析结果。
   * 仅影响当前客户端播放，不写入影片列表也不广播给房主/其他观众。
   */
  viewerCliResolvedSource: { movieId: number; resolved: ResolvedSource } | null
  setViewerCliResolvedSource: (
    value: { movieId: number; resolved: ResolvedSource } | null
  ) => void
  /** 待处理的预览播放请求（由 MoviePushPanel 触发，useWatchTogether 消费） */
  pendingPreviewPlay: PreviewPlayRequest | null
  /**
   * 待处理的 B站 重新解析请求计数器（由 BilibiliParseSettings 触发，useWatchTogether 消费）。
   * 使用计数器而非布尔值，确保连续多次触发都能被消费（每次 set 都会使值变化）。
   */
  pendingReloadBilibili: number
  /**
   * 观众端待处理的源重载计数器（由 BilibiliParseSettings 触发，useWatchTogether 消费）。
   * 观众切换 CLI 等仅影响本客户端的代理设置后，需要重新 attach 当前源以生效。
   */
  pendingViewerSourceReload: number
  /**
   * MSE 流重新加载（seek 到未缓冲区域）状态。
   * - isReloading=true 期间进度条显示 reloadTargetTime 而非 video.currentTime（避免归零）
   * - 同时在播放器上展示加载动画
   * 纯 UI 状态，不广播到后端。房主与观众端各自独立维护。
   */
  isReloading: boolean
  reloadTargetTime: number | null
  /**
   * 缓冲模式下载进度（房主/观众共享）。
   * - 非空时表示正在下载 m4s 流到 IndexedDB
   * - 完成或失败后置为 null
   * 由 useWatchTogether（房主）和 useViewerStateSync（观众）共同写入，
   * UI 从此读取以显示缓冲进度覆盖层。
   */
  bufferProgress: {
    downloaded: number
    total: number
    title: string
  } | null
  setBufferProgress: (
    progress: { downloaded: number; total: number; title: string } | null
  ) => void
  /**
   * 房主端「自动通过申请」开关。
   * 开启后，seek / 暂停 / 继续播放 申请自动通过，无需手动确认。
   * 放在 roomStore 中，方便 RoomInfoPanel 与 WatchTogetherPanel 共享。
   */
  autoApproveRequests: boolean
  /** OBS 推流状态（stream-push 子模式专用）。
   * - live：NMS 已收到推流
   * - offline：NMS 未收到推流或推流已结束
   * - unknown：初始状态，尚未收到 stream-status 事件
   * 放在 roomStore 中实现单一数据源，供 SharePage、WatchPage、StreamStatusPanel 等组件共享。
   */
  streamStatus: StreamStatus
  setStreamStatus: (status: StreamStatus) => void
  /**
   * OBS 推流密钥（stream-push 子模式专用）。
   * 与 roomId 分离，用于 OBS 推流码和 HTTP-FLV 拉流 URL。
   */
  streamKey: string | null
  setStreamKey: (key: string | null) => void
  setReloadingState: (isReloading: boolean, targetTime: number | null) => void
  toggleAutoApproveRequests: () => void
  /**
   * 退出房间：清除 activeRoomId 并重置全部房间状态。
   * 用于用户明确离开房间（点击返回按钮）时调用，
   * 与"导航到其他页面但保留房间"的场景区分。
   */
  exitRoom: () => void
  setRoomId: (id: string) => void
  setRoomName: (name: string) => void
  setPassword: (password: string) => void
  setMaxViewers: (max: number) => void
  setMode: (mode: RoomMode) => void
  setShareMethod: (method: ShareMethod) => void
  addViewer: (viewer: Viewer) => void
  removeViewer: (viewerSocketId: string) => void
  setViewers: (viewers: Viewer[]) => void
  setMutedViewerIds: (ids: number[]) => void
  addMutedViewer: (userId: number) => void
  removeMutedViewer: (userId: number) => void
  setRoomSettings: (settings: Partial<RoomSettings>) => void
  setIsSharing: (value: boolean) => void
  setIsPaused: (value: boolean) => void
  setWatchTogether: (state: Partial<WatchTogetherState>) => void
  setMovies: (movies: Movie[]) => void
  setCurrentMovieId: (id: number | null) => void
  setPendingQualityChange: (
    value: { movieId: number; resolved: ResolvedSource } | null
  ) => void
  setPendingPreviewPlay: (value: PreviewPlayRequest | null) => void
  /** 触发一次 B站 重新解析（计数器递增） */
  triggerReloadBilibili: () => void
  /** 触发观众端重新 attach 当前源（计数器递增） */
  triggerViewerSourceReload: () => void
  reset: () => void
  // REST API
  fetchMovies: (roomId: string) => Promise<void>
  addMovie: (
    roomId: string,
    payload: {
      url: string
      title: string
      cover?: string
      source?: string
      audioUrl?: string
      format?: string
      videoCodec?: string
      audioCodec?: string
      duration?: number
      cid?: number
      currentQn?: number
      acceptQuality?: { id: number; label: string; resolution?: string }[]
      pages?: { page: number; cid: number; part: string; duration: number }[]
      currentPage?: number
      serverUrl?: string
      path?: string
      username?: string
      password?: string
      directLink?: boolean
      sourceMeta?: AniSubsSourceMeta | null
    }
  ) => Promise<void>
  updateMovie: (
    roomId: string,
    movieId: number,
    payload: {
      url?: string
      title?: string
      cover?: string | null
      order?: number
      audioUrl?: string
      format?: string
      videoCodec?: string
      audioCodec?: string
      duration?: number
      cid?: number
      currentQn?: number
      acceptQuality?: QualityOption[]
      pages?: { page: number; cid: number; part: string; duration: number }[]
      currentPage?: number
      serverUrl?: string
      path?: string
      username?: string
      password?: string
      directLink?: boolean
      sourceMeta?: AniSubsSourceMeta | null
    }
  ) => Promise<void>
  removeMovie: (roomId: string, movieId: number) => Promise<void>
  reorderMovies: (roomId: string, orderedIds: number[]) => Promise<void>
}

const defaultState = {
  roomId: '',
  roomName: '',
  password: '',
  maxViewers: 10,
  mode: 'watch-together' as RoomMode,
  activeRoomId: null as string | null,
  shareMethod: 'webrtc' as ShareMethod,
  viewers: [],
  mutedViewerIds: [] as number[],
  roomSettings: {
    password: null as string | null,
    maxViewers: 10,
    requireApproval: true,
  } as RoomSettings,
  isSharing: false,
  isPaused: false,
  watchTogether: {
    sourceUrl: '',
    sourceType: 'url' as const,
    isPlaying: false,
    currentTime: 0,
    playbackRate: 1,
    duration: 0,
  },
  movies: [],
  currentMovieId: null,
  pendingQualityChange: null,
  viewerCliResolvedSource: null,
  pendingPreviewPlay: null,
  pendingReloadBilibili: 0,
  pendingViewerSourceReload: 0,
  isReloading: false,
  reloadTargetTime: null,
  bufferProgress: null as {
    downloaded: number
    total: number
    title: string
  } | null,
  autoApproveRequests: true,
  streamStatus: 'unknown' as StreamStatus,
  streamKey: null,
}

export const useRoomStore = create<RoomState>((set, get) => ({
  ...defaultState,
  setRoomId: (id) => set({ roomId: id }),
  setRoomName: (name) => set({ roomName: name }),
  setPassword: (password) => set({ password }),
  setMaxViewers: (max) => set({ maxViewers: max }),
  setMode: (mode) => set({ mode }),
  setShareMethod: (method) => set({ shareMethod: method }),
  setStreamStatus: (status) => set({ streamStatus: status }),
  setStreamKey: (key) => set({ streamKey: key }),
  addViewer: (viewer) =>
    set((state) => {
      if (state.viewers.some((v) => v.socketId === viewer.socketId)) {
        return {}
      }
      const muted =
        viewer.userId != null
          ? state.mutedViewerIds.includes(viewer.userId)
          : false
      return { viewers: [...state.viewers, { ...viewer, muted }] }
    }),
  removeViewer: (socketId) =>
    set((state) => ({
      viewers: state.viewers.filter((v) => v.socketId !== socketId),
    })),
  setViewers: (viewers) =>
    set((state) => ({
      viewers: viewers.map((v) => ({
        ...v,
        muted:
          v.userId != null ? state.mutedViewerIds.includes(v.userId) : false,
      })),
    })),
  setMutedViewerIds: (ids) =>
    set((state) => ({
      mutedViewerIds: ids,
      viewers: state.viewers.map((v) => ({
        ...v,
        muted: v.userId != null ? ids.includes(v.userId) : false,
      })),
    })),
  addMutedViewer: (userId) =>
    set((state) => {
      if (state.mutedViewerIds.includes(userId)) return {}
      const ids = [...state.mutedViewerIds, userId]
      return {
        mutedViewerIds: ids,
        viewers: state.viewers.map((v) => ({
          ...v,
          muted: v.userId != null ? ids.includes(v.userId) : false,
        })),
      }
    }),
  removeMutedViewer: (userId) =>
    set((state) => {
      if (!state.mutedViewerIds.includes(userId)) return {}
      const ids = state.mutedViewerIds.filter((id) => id !== userId)
      return {
        mutedViewerIds: ids,
        viewers: state.viewers.map((v) => ({
          ...v,
          muted: v.userId != null ? ids.includes(v.userId) : false,
        })),
      }
    }),
  setRoomSettings: (settings) =>
    set((state) => ({
      roomSettings: { ...state.roomSettings, ...settings },
      // 同步顶层 maxViewers/password 用于历史调用方
      ...(settings.maxViewers !== undefined
        ? { maxViewers: settings.maxViewers }
        : {}),
      ...(settings.password !== undefined
        ? { password: settings.password ?? '' }
        : {}),
    })),
  setIsSharing: (value) => set({ isSharing: value }),
  setIsPaused: (value) => set({ isPaused: value }),
  setWatchTogether: (updates) =>
    set((state) => ({
      watchTogether: { ...state.watchTogether, ...updates },
    })),
  setMovies: (movies) => set({ movies }),
  setCurrentMovieId: (id) => set({ currentMovieId: id }),
  setPendingQualityChange: (value) => set({ pendingQualityChange: value }),
  setViewerCliResolvedSource: (value) =>
    set({ viewerCliResolvedSource: value }),
  setPendingPreviewPlay: (value) => set({ pendingPreviewPlay: value }),
  triggerReloadBilibili: () =>
    set((state) => ({
      pendingReloadBilibili: state.pendingReloadBilibili + 1,
    })),
  triggerViewerSourceReload: () =>
    set((state) => ({
      pendingViewerSourceReload: state.pendingViewerSourceReload + 1,
    })),
  setReloadingState: (isReloading, targetTime) =>
    set({ isReloading, reloadTargetTime: targetTime }),
  setBufferProgress: (progress) => set({ bufferProgress: progress }),
  toggleAutoApproveRequests: () =>
    set((state) => ({ autoApproveRequests: !state.autoApproveRequests })),
  setActiveRoomId: (id) => set({ activeRoomId: id }),
  exitRoom: () => set({ ...defaultState }),
  reset: () => set({ ...defaultState }),

  // REST API 调用：成功后由后端 socket 广播 movie-list 刷新本地 state；
  // 失败时抛出错误，调用方负责提示用户且不更新本地 state。
  fetchMovies: async (roomId) => {
    const res = await apiFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/movies`
    )
    const data = await parseResponse<{
      success: boolean
      message?: string
      movies?: MovieDto[]
    }>(res)
    if (!res.ok || !data.success || !Array.isArray(data.movies)) {
      throw new Error(data.message || '获取影片列表失败')
    }
    set({ movies: data.movies.map(mapDtoToMovie) })
  },

  addMovie: async (roomId, payload) => {
    const res = await apiFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/movies`,
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      }
    )
    const data = await parseResponse<{
      success: boolean
      message?: string
      movie?: MovieDto
    }>(res)
    if (!res.ok || !data.success) {
      throw new Error(data.message || '新增影片失败')
    }
    // 不直接更新本地 state，等待后端广播 movie-list 刷新
  },

  updateMovie: async (roomId, movieId, payload) => {
    const res = await apiFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/movies/${movieId}`,
      {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      }
    )
    const data = await parseResponse<{ success: boolean; message?: string }>(
      res
    )
    if (!res.ok || !data.success) {
      throw new Error(data.message || '更新影片失败')
    }
    // 不直接更新本地 state，等待后端广播 movie-list 刷新
  },

  removeMovie: async (roomId, movieId) => {
    const res = await apiFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/movies/${movieId}`,
      {
        method: 'DELETE',
      }
    )
    const data = await parseResponse<{ success: boolean; message?: string }>(
      res
    )
    if (!res.ok || !data.success) {
      throw new Error(data.message || '删除影片失败')
    }
    // 后端 REST 删除不会广播 current-movie 事件，需要本地清理
    if (get().currentMovieId === movieId) {
      set({ currentMovieId: null })
    }
    // movies 列表由后端广播 movie-list 事件刷新
  },

  reorderMovies: async (roomId, orderedIds) => {
    const res = await apiFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/movies/reorder`,
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ orderedIds }),
      }
    )
    const data = await parseResponse<{ success: boolean; message?: string }>(
      res
    )
    if (!res.ok || !data.success) {
      throw new Error(data.message || '重排序失败')
    }
    // 不直接更新本地 state，等待后端广播 movie-list 刷新
  },
}))
