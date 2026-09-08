import { create } from 'zustand'
import type { MusicQueueItem, PlayMode, NcmLoginStatus } from './types'

/**
 * 一起听模块全局状态。
 *
 * 说明：
 * - queue / currentSongId / isPlaying / playMode 为房间同步状态的本地镜像，
 *   由 useListenTogether 依据 socket 事件与 audio 元素事件维护
 * - positionSec 为本地 audio 进度镜像（timeupdate 驱动），供进度条/歌词消费
 * - hostOffline 为观众端的房主离线判定（心跳超时），决定 canControl
 * - loginStatus 由 useNcmLogin 维护
 * - syncNotice 为播放器左上角提示文字（观众申请等），自动消失逻辑由组件实现
 */
export interface MusicState {
  /** 房间播放队列（按 order 升序） */
  queue: MusicQueueItem[]
  /** 当前播放曲目 songId（null 表示未播放） */
  currentSongId: number | null
  /** 是否正在播放（audio 元素事件镜像） */
  isPlaying: boolean
  /** 本地播放进度镜像（秒） */
  positionSec: number
  /** 播放模式 */
  playMode: PlayMode
  /** 房主是否离线（观众端心跳超时判定） */
  hostOffline: boolean
  /** 网易云登录状态 */
  loginStatus: NcmLoginStatus
  /** 播放器左上角提示文字（自动消失逻辑放组件） */
  syncNotice: string | null

  // ===== Actions =====
  /** 覆盖队列（按 order 升序排序后写入） */
  setQueue: (items: MusicQueueItem[]) => void
  /** 设置当前播放曲目 */
  setCurrentSong: (songId: number | null) => void
  /** 设置播放状态镜像 */
  setPlaying: (playing: boolean) => void
  /** 设置本地进度镜像 */
  setPositionSec: (sec: number) => void
  /** 设置播放模式 */
  setPlayMode: (mode: PlayMode) => void
  /** 设置房主离线标记（观众端） */
  setHostOffline: (offline: boolean) => void
  /** 设置网易云登录状态 */
  setLoginStatus: (status: NcmLoginStatus) => void
  /** 设置播放器提示文字（null 清除） */
  setSyncNotice: (notice: string | null) => void
  /** 重置为初始状态（离开房间时调用） */
  reset: () => void
}

const defaultState = {
  queue: [] as MusicQueueItem[],
  currentSongId: null as number | null,
  isPlaying: false,
  positionSec: 0,
  playMode: 'sequence' as PlayMode,
  hostOffline: false,
  loginStatus: { loggedIn: false } as NcmLoginStatus,
  syncNotice: null as string | null,
}

export const useMusicStore = create<MusicState>((set) => ({
  ...defaultState,
  setQueue: (items) =>
    set({ queue: [...items].sort((a, b) => a.order - b.order) }),
  setCurrentSong: (songId) => set({ currentSongId: songId }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setPositionSec: (sec) => set({ positionSec: Number.isFinite(sec) ? sec : 0 }),
  setPlayMode: (mode) => set({ playMode: mode }),
  setHostOffline: (offline) => set({ hostOffline: offline }),
  setLoginStatus: (status) => set({ loginStatus: status }),
  setSyncNotice: (notice) => set({ syncNotice: notice }),
  reset: () => set({ ...defaultState }),
}))
