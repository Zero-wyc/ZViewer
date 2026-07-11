import { create } from 'zustand'
import { useAuthStore } from '@/store/authStore'
import type {
  ResolvedSource,
  QualityOption,
} from '@/modules/room/watch-together/resolveSource'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken
  return token
    ? {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      }
    : { 'Content-Type': 'application/json' }
}

export interface Viewer {
  socketId: string
  username?: string
}

export type RoomMode = 'screen-share' | 'watch-together' | 'bili-compat'

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
  format?: 'dash' | 'mp4'
  quality?: string
  // 持久化的清晰度信息
  currentQn?: number
  acceptQuality?: { id: number; label: string; resolution?: string }[]
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
  serverUrl: string | null
  path: string | null
  username: string | null
  directLink: boolean
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
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  }
}

async function parseResponse<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T
  return data
}

export interface WatchTogetherState {
  sourceUrl: string
  sourceType:
    'url' | 'webdav' | 'ftp' | 'openlist' | 'smb' | 'bilibili' | string
  audioUrl?: string
  format?: 'mp4' | 'dash'
  videoCodec?: string
  audioCodec?: string
  cid?: number
  isPlaying: boolean
  currentTime: number
  playbackRate: number
  duration: number
  currentQn?: number
  acceptQuality?: { id: number; label: string; resolution?: string }[]
}

interface RoomState {
  roomId: string
  roomName: string
  password: string
  maxViewers: number
  mode: RoomMode
  viewers: Viewer[]
  isSharing: boolean
  isPaused: boolean
  watchTogether: WatchTogetherState
  movies: Movie[]
  currentMovieId: number | null
  pendingQualityChange: { movieId: number; resolved: ResolvedSource } | null
  setRoomId: (id: string) => void
  setRoomName: (name: string) => void
  setPassword: (password: string) => void
  setMaxViewers: (max: number) => void
  setMode: (mode: RoomMode) => void
  addViewer: (viewer: Viewer) => void
  removeViewer: (viewerSocketId: string) => void
  setViewers: (viewers: Viewer[]) => void
  setIsSharing: (value: boolean) => void
  setIsPaused: (value: boolean) => void
  setWatchTogether: (state: Partial<WatchTogetherState>) => void
  setMovies: (movies: Movie[]) => void
  setCurrentMovieId: (id: number | null) => void
  setPendingQualityChange: (
    value: { movieId: number; resolved: ResolvedSource } | null
  ) => void
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
      serverUrl?: string
      path?: string
      username?: string
      password?: string
      directLink?: boolean
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
      serverUrl?: string
      path?: string
      username?: string
      password?: string
      directLink?: boolean
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
  mode: 'screen-share' as RoomMode,
  viewers: [],
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
}

export const useRoomStore = create<RoomState>((set, get) => ({
  ...defaultState,
  setRoomId: (id) => set({ roomId: id }),
  setRoomName: (name) => set({ roomName: name }),
  setPassword: (password) => set({ password }),
  setMaxViewers: (max) => set({ maxViewers: max }),
  setMode: (mode) => set({ mode }),
  addViewer: (viewer) =>
    set((state) => ({
      viewers: state.viewers.some((v) => v.socketId === viewer.socketId)
        ? state.viewers
        : [...state.viewers, viewer],
    })),
  removeViewer: (socketId) =>
    set((state) => ({
      viewers: state.viewers.filter((v) => v.socketId !== socketId),
    })),
  setViewers: (viewers) => set({ viewers }),
  setIsSharing: (value) => set({ isSharing: value }),
  setIsPaused: (value) => set({ isPaused: value }),
  setWatchTogether: (updates) =>
    set((state) => ({
      watchTogether: { ...state.watchTogether, ...updates },
    })),
  setMovies: (movies) => set({ movies }),
  setCurrentMovieId: (id) => set({ currentMovieId: id }),
  setPendingQualityChange: (value) => set({ pendingQualityChange: value }),
  reset: () => set({ ...defaultState }),

  // REST API 调用：成功后由后端 socket 广播 movie-list 刷新本地 state；
  // 失败时抛出错误，调用方负责提示用户且不更新本地 state。
  fetchMovies: async (roomId) => {
    const res = await fetch(
      `${API_URL}/api/rooms/${encodeURIComponent(roomId)}/movies`,
      {
        headers: getAuthHeaders(),
      }
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
    const res = await fetch(
      `${API_URL}/api/rooms/${encodeURIComponent(roomId)}/movies`,
      {
        method: 'POST',
        headers: getAuthHeaders(),
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
    const res = await fetch(
      `${API_URL}/api/rooms/${encodeURIComponent(roomId)}/movies/${movieId}`,
      {
        method: 'PUT',
        headers: getAuthHeaders(),
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
    const res = await fetch(
      `${API_URL}/api/rooms/${encodeURIComponent(roomId)}/movies/${movieId}`,
      {
        method: 'DELETE',
        headers: getAuthHeaders(),
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
    const res = await fetch(
      `${API_URL}/api/rooms/${encodeURIComponent(roomId)}/movies/reorder`,
      {
        method: 'POST',
        headers: getAuthHeaders(),
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
