/**
 * 一起听（Listen Together）模块共享类型。
 *
 * 与后端约定的事件契约（Task 3 MusicSyncHandler）：
 * - `music:sync-state`：房主广播 MusicSyncState（换曲/播放暂停/进度/播放模式）
 * - `music:host-heartbeat`：房主每 2s 心跳，携带完整 MusicSyncState
 * - `music:queue-changed`：队列变更后全房间广播完整队列（items: MusicQueueItem[]）
 * - `music:control-request` / `music:control-response`：观众申请制控制
 */

/** 网易云歌曲（搜索结果条目） */
export interface NcmSong {
  /** 网易云歌曲 ID */
  songId: number
  /** 歌曲名 */
  name: string
  /** 艺术家（多人拼接字符串，如「周杰伦 / 费玉清」） */
  artist: string
  /** 专辑名 */
  album: string
  /** 封面图 URL */
  cover: string
  /** 时长（毫秒） */
  durationMs: number
  /** 是否 VIP 歌曲（未登录时不可播放） */
  vip: boolean
}

/** 房间播放队列条目（与后端 MusicQueueItemPayload 对齐） */
export interface MusicQueueItem {
  /** 队列条目 ID（后端实体主键，队列内唯一） */
  id: number
  /** 所属房间 ID */
  roomId: string
  /** 网易云歌曲 ID */
  songId: number
  /** 歌曲名 */
  name: string
  /** 艺术家（拼接字符串） */
  artist: string
  /** 专辑名 */
  album: string
  /** 封面图 URL */
  cover: string
  /** 时长（毫秒） */
  durationMs: number
  /** 是否 VIP 歌曲（未登录时不可播放） */
  vip: boolean
  /** 队列内排序序号（小在前） */
  order: number
  /** 添加者用户名 */
  addedBy: string
}

/** 播放模式：顺序循环 / 单曲循环 / 随机（Fisher-Yates 洗牌） */
export type PlayMode = 'sequence' | 'repeat-one' | 'shuffle'

/** 房间音乐同步状态（房主广播与心跳共用的状态快照） */
export interface MusicSyncState {
  /** 当前曲目 songId（null 表示未在播放） */
  trackSongId: number | null
  /** 是否正在播放 */
  isPlaying: boolean
  /** 播放进度（秒） */
  positionSec: number
  /** 播放模式 */
  playMode: PlayMode
  /** 状态生成时间戳（毫秒） */
  updatedAt: number
}

/** 观众控制申请（观众 → 房主） */
export interface MusicControlRequest {
  /** 申请的动作 */
  action: 'pause' | 'play' | 'next' | 'prev'
  /** 申请者 socketId（房主应答时定向回传） */
  from: string
  /** 申请者用户名（房主端提示文案用） */
  username?: string
}

/** 控制申请应答（房主 → 申请者） */
export interface MusicControlResponse {
  /** 是否通过 */
  approved: boolean
  /** 应答的动作 */
  action: MusicControlRequest['action']
  /** 申请者 socketId（回传用于定向应答） */
  from: string
}

/** 网易云登录状态（本地镜像，由 useNcmLogin 维护） */
export interface NcmLoginStatus {
  /** 是否已登录 */
  loggedIn: boolean
  /** 登录账号昵称 */
  nickname?: string
  /** 登录账号头像 */
  avatarUrl?: string
}

// ==================== 页面数据类型（Hydrogen 首页各区块） ====================

/** 首页轮播图条目（GET /api/music/ncm/banner → banners[]） */
export interface NcmBannerItem {
  /** 轮播图（ipad 端为 pic，部分端为 imageUrl） */
  pic?: string
  imageUrl?: string
  titleColor?: string
  typeTitle?: string
  targetType?: number
  targetId?: number
  url?: string
}

/** 推荐歌单卡片（GET /personalized?limit=10 → result[]） */
export interface NcmPlaylistCard {
  id: number
  name: string
  picUrl: string
  playCount?: number
}

/** 推荐歌手卡片（GET /top/artists?limit=50 → artists[]，前端随机取 5） */
export interface NcmArtistCard {
  id: number
  name: string
  img1v1Url: string
}

/** 最新专辑卡片（GET /album/new?area=all&limit=10 → albums[]） */
export interface NcmAlbumCard {
  id: number
  name: string
  picUrl: string
  /** 艺人（结构为 { name }，宽松可选） */
  artist?: { name?: string }
}

/** 排行榜卡片（GET /toplist → list[]，取 Hydrogen 同款索引 0,3,8,11,15） */
export interface NcmToplistCard {
  id: number
  name: string
  coverImgUrl: string
  updateFrequency?: string
}

/** 最新音乐条目（GET /personal/newsong → data[]） */
export interface NcmNewSongCard {
  id: number
  name: string
  picUrl: string
  /** 艺人（旧结构 artists / 新结构 ar） */
  artists?: Array<{ name?: string }>
  ar?: Array<{ name?: string }>
  /** 内嵌歌曲对象（部分响应把元数据挂在 song 下） */
  song?: { artists?: Array<{ name?: string }>; duration?: number }
  duration?: number
  dt?: number
}
