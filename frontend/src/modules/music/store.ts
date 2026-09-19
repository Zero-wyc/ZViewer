import { create } from 'zustand'
import {
  buildBilibiliImageProxyUrl,
  isBilibiliImageUrl,
} from '@/modules/room/watch-together/resolveSource'
import type { MusicQueueItem, PlayMode, NcmLoginStatus } from './types'

/**
 * 一起听模块全局状态。
 *
 * 说明：
 * - queue / currentKey / isPlaying / playMode 为房间同步状态的本地镜像，
 *   由 useListenTogether 依据 socket 事件与 audio 元素事件维护
 * - currentKey 为当前曲目的权威标识（`ncm:<songId>`），与队列条目匹配；
 *   currentSongId 为其兼容字段
 * - positionSec 为本地 audio 进度镜像（timeupdate 驱动），供进度条/歌词消费
 * - hostOffline 为观众端的房主离线判定（心跳超时），决定 canControl
 * - loginStatus 由 useNcmLogin 维护
 * - syncNotice 为播放器左上角提示文字（自动消失逻辑由组件实现）
 * - page / playerOverlayOpen / queuePopupOpen / loginModalOpen 为 Hydrogen
 *   主框架的 UI 状态（顶部导航多页切换 / 完整播放器覆盖层 / 队列弹窗 / 登录弹窗）
 */

/** 主区域页面标识（MusicAppShell 内容区多页切换） */
export type MusicPage =
  'home' | 'fm' | 'cloud' | 'mymusic' | 'search' | 'bilibili' | 'settings'

/** 上次所在主区域页面的持久化 key（刷新/重开应用后恢复原页面） */
const MUSIC_PAGE_STORAGE_KEY = 'zviewer-music-page'

const MUSIC_PAGE_VALUES: readonly MusicPage[] = [
  'home',
  'fm',
  'cloud',
  'mymusic',
  'search',
  'bilibili',
  'settings',
]

/**
 * 从 localStorage 恢复上次所在的主区域页面（如哔哩哔哩页，刷新后仍停留）；
 * 无记录/非法值/隐私模式读取失败一律回退首页
 */
function loadInitialPage(): MusicPage {
  try {
    const stored = localStorage.getItem(MUSIC_PAGE_STORAGE_KEY)
    if (stored && MUSIC_PAGE_VALUES.includes(stored as MusicPage)) {
      return stored as MusicPage
    }
  } catch {
    // ignore：隐私模式等场景读取失败
  }
  return 'home'
}

/** 观众同步回执（房主端左下角「xx 已同步」提示条目） */
export interface MusicSyncAck {
  /** 唯一标识（渲染 key + 过期清理） */
  id: number
  /** 已同步的观众用户名 */
  username: string
  /** 入列时间戳（毫秒，过期清理用） */
  at: number
}

/** 构造队列条目的权威 key：B站 条目 `bili:<bvid>:<cid>`，网易云 `ncm:<songId>` */
export function musicItemKey(item: MusicQueueItem): string {
  if (item.biliBvid) return `bili:${item.biliBvid}:${item.biliCid ?? 0}`
  return `ncm:${item.songId}`
}

/** 从 key 解析来源与标识（无法解析时返回 null）。
 *  siren: 前缀为塞壬支持移除前的历史数据，解析为 null（不可播放） */
export type ParsedMusicKey =
  | { source: 'ncm'; id: string; songId: number }
  | { source: 'bili'; bvid: string; cid: number }

export function parseMusicKey(
  key: string | null | undefined
): ParsedMusicKey | null {
  if (!key) return null
  if (key.startsWith('ncm:')) {
    const songId = Number(key.slice(4))
    if (!Number.isFinite(songId)) return null
    return { source: 'ncm', id: String(songId), songId }
  }
  if (key.startsWith('bili:')) {
    const rest = key.slice(5)
    const sep = rest.lastIndexOf(':')
    if (sep <= 0) return null
    const bvid = rest.slice(0, sep)
    const cid = Number(rest.slice(sep + 1))
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !Number.isFinite(cid)) return null
    return { source: 'bili', bvid, cid }
  }
  return null
}

/**
 * 当前播放来源对应的活动播放列表（两源列表完全独立的视图/切歌语义）。
 * B站 播放列表已并入房间队列（source=bili 条目，全房间同步）：
 * - 当前为 B站 曲目 → 房间队列中的 B站 条目
 * - 当前为网易云曲目 / 未播放 → 房间队列去除 B站 条目（网易云播放列表）
 */
export function activeQueueOf(state: {
  queue: MusicQueueItem[]
  currentKey: string | null
}): MusicQueueItem[] {
  if (state.currentKey?.startsWith('bili:')) {
    return state.queue.filter((it) => it.biliBvid)
  }
  return state.queue.filter((it) => !it.biliBvid)
}

export interface MusicState {
  /** 房间播放队列（按 order 升序） */
  queue: MusicQueueItem[]
  /** 当前播放曲目的权威 key（`ncm:<songId>`，null 表示未播放） */
  currentKey: string | null
  /** 兼容字段：当前曲目 songId（null 表示未播放） */
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
  /**
   * 提示类别：approval = 观众控制申请待审批（房主端渲染通过/拒绝按钮）；
   * info = 纯状态提示（解析进度、申请结果回执等，不渲染按钮）。
   * setSyncNotice(null) 时自动重置为 info
   */
  syncNoticeKind: 'info' | 'approval'
  /** 观众同步回执列表（房主端左下角「xx 已同步」，组件负责过期清理） */
  syncAcks: MusicSyncAck[]
  /**
   * B站 视频音频条目（哔哩哔哩页点击播放的「本地插播」虚拟条目）：
   * 不写入房间队列、不经同步，currentKey 匹配时作为 currentSong 供 UI 消费
   */
  biliItem: MusicQueueItem | null
  /**
   * B站 相关推荐自动加入的条目 key 集合（本地记忆，配合队列条目的
   * recommended 字段显示「推荐」tag）
   */
  biliRecommendedKeys: string[]

  // ===== UI 状态（Hydrogen 主框架） =====
  /** 主区域当前页面（切页即持久化，刷新/重开应用后恢复原页面） */
  page: MusicPage
  /** 顶部搜索关键词（搜索框回车写入，搜索页消费） */
  searchKeywords: string
  /** 完整播放器覆盖层（ListenTogetherPanel）开关 */
  playerOverlayOpen: boolean
  /** 完整播放器覆盖层滑出动画进行中（先播 0.5s 滑出再卸载） */
  playerOverlayClosing: boolean
  /** 队列弹窗（MusicQueuePopup）开关 */
  queuePopupOpen: boolean
  /** 网易云扫码登录弹窗开关 */
  loginModalOpen: boolean
  /** 待打开的专辑详情（播放条「查看专辑」跨页跳转目标；我的音乐页消费后置空） */
  pendingAlbumDetail: { id: number; name: string; cover?: string } | null
  /** 跨页跳转到「我的音乐」的详情打开目标（主页卡片：歌单/专辑/歌手/每日推荐） */
  pendingMyDetail: {
    kind: 'playlist' | 'album' | 'artist' | 'rec'
    id: number
    name: string
    cover?: string
  } | null

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
  /** 设置播放器提示文字（null 清除；kind 标记是否为待审批申请） */
  setSyncNotice: (notice: string | null, kind?: 'info' | 'approval') => void
  /** 追加一条观众同步回执（房主端；超出上限丢弃最旧的） */
  pushSyncAck: (username: string) => void
  /** 清理过期的同步回执（at 早于 now - ttlMs 的条目） */
  pruneSyncAcks: (ttlMs: number) => void
  /** 设置 B站 本地插播条目（null 清除；切到网易云曲目时保留不冲突） */
  setBiliItem: (item: MusicQueueItem | null) => void
  /** 记录 B站 相关推荐加入的条目 key（去重追加，供「推荐」tag 显示） */
  markBiliRecommended: (keys: string[]) => void
  /** 哔哩哔哩页顶栏搜索关键词（null = 未在搜索，列表回常规 tab 内容） */
  biliSearchKeyword: string | null
  setBiliSearchKeyword: (keyword: string | null) => void
  /** 切换主区域页面 */
  setPage: (page: MusicPage) => void
  /** 设置搜索关键词 */
  setSearchKeywords: (keywords: string) => void
  /** 设置完整播放器覆盖层开关 */
  setPlayerOverlayOpen: (open: boolean) => void
  /** 带滑出动画关闭完整播放器覆盖层（0.5s 后卸载） */
  closePlayerOverlay: () => void
  /** 设置队列弹窗开关 */
  setQueuePopupOpen: (open: boolean) => void
  /** 设置登录弹窗开关 */
  setLoginModalOpen: (open: boolean) => void
  /** 设置待打开的专辑详情（null 清除；写入后应切页到 mymusic 消费） */
  setPendingAlbumDetail: (
    d: { id: number; name: string; cover?: string } | null
  ) => void
  /** 设置跨页详情打开目标（null 清除；写入后应切页到 mymusic 消费） */
  setPendingMyDetail: (
    d: {
      kind: 'playlist' | 'album' | 'artist' | 'rec'
      id: number
      name: string
      cover?: string
    } | null
  ) => void
  /** 重置为初始状态（离开房间时调用） */
  reset: () => void
  /** 仅重置房间播放相关状态（queue/当前曲目/进度/播放标志），
   *  保留登录态与 UI 状态（音乐页卸载时调用，不清网易云登录） */
  resetPlayback: () => void
}

const defaultState = {
  queue: [] as MusicQueueItem[],
  currentKey: null as string | null,
  currentSongId: null as number | null,
  isPlaying: false,
  positionSec: 0,
  playMode: 'order' as PlayMode,
  hostOffline: false,
  loginStatus: { loggedIn: false } as NcmLoginStatus,
  syncNotice: null as string | null,
  syncNoticeKind: 'info' as 'info' | 'approval',
  syncAcks: [] as MusicSyncAck[],
  biliItem: null as MusicQueueItem | null,
  biliRecommendedKeys: [] as string[],
  biliSearchKeyword: null as string | null,
  page: loadInitialPage(),
  searchKeywords: '',
  playerOverlayOpen: false,
  playerOverlayClosing: false,
  queuePopupOpen: false,
  loginModalOpen: false,
  pendingAlbumDetail: null,
  pendingMyDetail: null,
}

export const useMusicStore = create<MusicState>((set) => ({
  ...defaultState,
  setQueue: (items) =>
    set({
      // B站 CDN 封面直链（hdslb.com）有 Referer 防盗链，直连会 403：在
      // 队列写入的统一入口做代理化兜底——相关推荐等未经哔哩哔哩页
      // withCoverProxy 预处理的原始直链在此转换，已有代理封面（指向
      // /api/stream/proxy-image）与网易云封面不受影响，历史落库的原始
      // 直链也在展示层一并修复
      queue: [...items]
        .sort((a, b) => a.order - b.order)
        .map((it) =>
          it.cover && isBilibiliImageUrl(it.cover)
            ? { ...it, cover: buildBilibiliImageProxyUrl(it.cover) }
            : it
        ),
    }),
  setCurrentKey: (key) => {
    const parsed = parseMusicKey(key)
    set({
      currentKey: key,
      currentSongId: parsed && parsed.source === 'ncm' ? parsed.songId : null,
    })
  },
  setPlaying: (playing) => set({ isPlaying: playing }),
  setPositionSec: (sec) => set({ positionSec: Number.isFinite(sec) ? sec : 0 }),
  setPlayMode: (mode) => set({ playMode: mode }),
  setHostOffline: (offline) => set({ hostOffline: offline }),
  setLoginStatus: (status) => set({ loginStatus: status }),
  setSyncNotice: (notice, kind) =>
    set({
      syncNotice: notice,
      // 清除时重置类别；设置时未指定默认为 info（纯状态提示）
      syncNoticeKind: notice == null ? 'info' : (kind ?? 'info'),
    }),
  pushSyncAck: (username) =>
    set((s) => {
      const next: MusicSyncAck[] = [
        ...s.syncAcks,
        { id: Date.now() + Math.random(), username, at: Date.now() },
      ]
      // 上限 4 条：多人同时同步完成时提示区不会无限堆叠
      return { syncAcks: next.slice(-4) }
    }),
  pruneSyncAcks: (ttlMs) =>
    set((s) => {
      const cutoff = Date.now() - ttlMs
      const next = s.syncAcks.filter((ack) => ack.at > cutoff)
      return next.length === s.syncAcks.length ? s : { syncAcks: next }
    }),
  setBiliItem: (item) => set({ biliItem: item }),
  markBiliRecommended: (keys) =>
    set((s) => {
      const merged = [...s.biliRecommendedKeys]
      for (const k of keys) {
        if (!merged.includes(k)) merged.push(k)
      }
      return merged.length === s.biliRecommendedKeys.length
        ? s
        : { biliRecommendedKeys: merged }
    }),
  setBiliSearchKeyword: (keyword) => set({ biliSearchKeyword: keyword }),
  setPage: (page) => {
    set({ page })
    // 记忆当前页面：刷新/重开应用后由 loadInitialPage 恢复
    try {
      localStorage.setItem(MUSIC_PAGE_STORAGE_KEY, page)
    } catch {
      // ignore：隐私模式等场景写入失败可忽略
    }
  },
  setSearchKeywords: (keywords) => set({ searchKeywords: keywords }),
  setPlayerOverlayOpen: (open) => set({ playerOverlayOpen: open }),
  /** 带滑出动画关闭完整播放器覆盖层：先标记 closing（0.5s 滑出动画），
   *  动画结束后真正卸载（对应 Hydrogen .player-leave 过渡） */
  closePlayerOverlay: () => {
    set({ playerOverlayClosing: true })
    setTimeout(() => {
      set({ playerOverlayOpen: false, playerOverlayClosing: false })
    }, 500)
  },
  setQueuePopupOpen: (open) => set({ queuePopupOpen: open }),
  setLoginModalOpen: (open) => set({ loginModalOpen: open }),
  setPendingAlbumDetail: (d) => set({ pendingAlbumDetail: d }),
  setPendingMyDetail: (d) => set({ pendingMyDetail: d }),
  /** 重置为初始状态（离开房间时调用；页面记忆仅应用加载时恢复，
   *  此处保持旧语义回首页） */
  reset: () => set({ ...defaultState, page: 'home' }),
  resetPlayback: () =>
    set({
      queue: [],
      currentKey: null,
      currentSongId: null,
      isPlaying: false,
      positionSec: 0,
      playMode: 'order',
      hostOffline: false,
      syncNotice: null,
      syncNoticeKind: 'info',
      syncAcks: [],
      biliItem: null,
      biliRecommendedKeys: [],
    }),
}))
