import { create } from 'zustand'
import type {
  MusicQueueItem,
  PlayMode,
  NcmLoginStatus,
  MusicSource,
} from './types'

/**
 * 一起听模块全局状态。
 *
 * 说明：
 * - queue / currentKey / isPlaying / playMode 为房间同步状态的本地镜像，
 *   由 useListenTogether 依据 socket 事件与 audio 元素事件维护
 * - currentKey 为当前曲目的权威标识（`ncm:<songId>` / `siren:<cid>`），
 *   与队列条目匹配；currentSongId 为 ncm 兼容字段（siren 播放时为 0）
 * - positionSec 为本地 audio 进度镜像（timeupdate 驱动），供进度条/歌词消费
 * - hostOffline 为观众端的房主离线判定（心跳超时），决定 canControl
 * - loginStatus 由 useNcmLogin 维护
 * - syncNotice 为播放器左上角提示文字（观众申请等），自动消失逻辑由组件实现
 * - page / playerOverlayOpen / queuePopupOpen / loginModalOpen 为 Hydrogen
 *   主框架的 UI 状态（顶部导航多页切换 / 完整播放器覆盖层 / 队列弹窗 / 登录弹窗）
 */

/** 主区域页面标识（MusicAppShell 内容区多页切换） */
export type MusicPage =
  'home' | 'fm' | 'cloud' | 'mymusic' | 'siren' | 'search' | 'daily'

/**
 * 构造队列条目的权威 key（与 MusicSyncHandler 广播契约对应）。
 * - ncm 条目：`ncm:<songId>`
 * - siren 条目：`siren:<sourceId>`（songId 恒 0）
 */
export function musicItemKey(item: MusicQueueItem): string {
  if (item.source === 'siren') return `siren:${item.sourceId ?? ''}`
  return `ncm:${item.songId}`
}

/** 条目来源兜底（旧广播数据缺省视为 ncm） */
export function itemSource(item: MusicQueueItem): MusicSource {
  return item.source === 'siren' ? 'siren' : 'ncm'
}

/** 从 key 解析来源与标识（无法解析时返回 null） */
export function parseMusicKey(
  key: string | null | undefined
): { source: MusicSource; id: string; songId: number } | null {
  if (!key) return null
  if (key.startsWith('ncm:')) {
    const songId = Number(key.slice(4))
    if (!Number.isFinite(songId)) return null
    return { source: 'ncm', id: String(songId), songId }
  }
  if (key.startsWith('siren:')) {
    const id = key.slice(6)
    if (!id) return null
    return { source: 'siren', id, songId: 0 }
  }
  return null
}

export interface MusicState {
  /** 房间播放队列（按 order 升序） */
  queue: MusicQueueItem[]
  /** 当前播放曲目的权威 key（`ncm:<songId>` / `siren:<cid>`，null 表示未播放） */
  currentKey: string | null
  /** ncm 兼容字段：当前曲目 songId（siren 播放时为 0，null 表示未播放） */
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

  // ===== UI 状态（Hydrogen 主框架） =====
  /** 主区域当前页面 */
  page: MusicPage
  /** 顶部搜索关键词（搜索框回车写入，搜索页消费） */
  searchKeywords: string
  /** 完整播放器覆盖层（ListenTogetherPanel）开关 */
  playerOverlayOpen: boolean
  /** 队列弹窗（MusicQueuePopup）开关 */
  queuePopupOpen: boolean
  /** 网易云扫码登录弹窗开关 */
  loginModalOpen: boolean

  // ===== Actions =====
  /** 覆盖队列（按 order 升序排序后写入） */
  setQueue: (items: MusicQueueItem[]) => void
  /** 设置当前播放曲目 key（同步维护 ncm 兼容字段 currentSongId） */
  setCurrentKey: (key: string | null) => void
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
  /** 切换主区域页面 */
  setPage: (page: MusicPage) => void
  /** 设置搜索关键词 */
  setSearchKeywords: (keywords: string) => void
  /** 设置完整播放器覆盖层开关 */
  setPlayerOverlayOpen: (open: boolean) => void
  /** 设置队列弹窗开关 */
  setQueuePopupOpen: (open: boolean) => void
  /** 设置登录弹窗开关 */
  setLoginModalOpen: (open: boolean) => void
  /** 重置为初始状态（离开房间时调用） */
  reset: () => void
}

const defaultState = {
  queue: [] as MusicQueueItem[],
  currentKey: null as string | null,
  currentSongId: null as number | null,
  isPlaying: false,
  positionSec: 0,
  playMode: 'sequence' as PlayMode,
  hostOffline: false,
  loginStatus: { loggedIn: false } as NcmLoginStatus,
  syncNotice: null as string | null,
  page: 'home' as MusicPage,
  searchKeywords: '',
  playerOverlayOpen: false,
  queuePopupOpen: false,
  loginModalOpen: false,
}

export const useMusicStore = create<MusicState>((set) => ({
  ...defaultState,
  setQueue: (items) =>
    set({ queue: [...items].sort((a, b) => a.order - b.order) }),
  setCurrentKey: (key) => {
    // ncm 兼容字段：解析 key 前缀；siren 曲目 songId 恒 0
    const parsed = parseMusicKey(key)
    set({
      currentKey: key,
      currentSongId: parsed ? parsed.songId : null,
    })
  },
  setPlaying: (playing) => set({ isPlaying: playing }),
  setPositionSec: (sec) => set({ positionSec: Number.isFinite(sec) ? sec : 0 }),
  setPlayMode: (mode) => set({ playMode: mode }),
  setHostOffline: (offline) => set({ hostOffline: offline }),
  setLoginStatus: (status) => set({ loginStatus: status }),
  setSyncNotice: (notice) => set({ syncNotice: notice }),
  setPage: (page) => set({ page }),
  setSearchKeywords: (keywords) => set({ searchKeywords: keywords }),
  setPlayerOverlayOpen: (open) => set({ playerOverlayOpen: open }),
  setQueuePopupOpen: (open) => set({ queuePopupOpen: open }),
  setLoginModalOpen: (open) => set({ loginModalOpen: open }),
  reset: () => set({ ...defaultState }),
}))
