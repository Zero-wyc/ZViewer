/**
 * 同步播放模块类型定义（单一权威源）
 *
 * 将 watch-together 场景下房主与观众共享的状态/事件类型集中管理。
 * `roomStore.ts` 不再自行定义 `WatchTogetherState`，从此处 re-export 以保持
 * 向后兼容的导入路径（`import type { WatchTogetherState } from '@/store/roomStore'`）。
 *
 * 协议精简（v2）：
 * - 合并 DanmakuTrackChangePayload + SubtitleTrackChangePayload → TrackChangePayload
 * - 移除 QualityChangePayload（清晰度信息已包含在 WatchTogetherState.currentQn）
 */
import type { QualityOption } from '@/modules/bilibili/types'
import type { MediaFormat } from '@/lib/mediaFormat'

/** 视频源类型（与 roomStore.Movie.sourceType 对齐） */
export type SourceType =
  'url' | 'webdav' | 'ftp' | 'openlist' | 'smb' | 'bilibili' | 'anime' | string

/**
 * 视频格式。
 *
 * 与 `lib/mediaFormat.ts` 中的 `MediaFormat` 对齐，允许 FTP/WebDAV/OpenList
 * 等模块返回 mkv/avi/webm 等容器格式，前端据此判断是否可播放。
 */
export type VideoFormat = MediaFormat

/**
 * 房主与观众之间同步的播放状态。
 * 房主通过 `watch-together-state` 广播，观众接收后应用到本地 video 元素。
 *
 * 此接口是整个前端 WatchTogetherState 的**唯一权威定义**，
 * store / hooks / components 均从此处导入。
 */
export interface WatchTogetherState {
  sourceUrl: string
  sourceType: SourceType
  audioUrl?: string
  format?: VideoFormat
  videoCodec?: string
  audioCodec?: string
  cid?: number
  isPlaying: boolean
  currentTime: number
  playbackRate: number
  duration: number
  /** B站当前清晰度 qn */
  currentQn?: number
  /** B站可用清晰度列表 */
  acceptQuality?: QualityOption[]
  /** 源指定的防盗链 headers（Referer/UA 等），由后端 resolve 返回 */
  headers?: Record<string, string>
  /** 是否为预览源（未加入影片列表的临时播放） */
  isPreview?: boolean
  /** 预览源的显示标题 */
  previewTitle?: string
  /**
   * 房主是否启用了 CLI 高画质代理（仅房主广播时设置）。
   *
   * CLI 是各客户端独立的本地代理，房主开启后走 CLI DASH 高画质。
   * 观众无法使用房主的 CLI，收到 hostCliEnabled=true 时应强制走 MP4，
   * 避免观众被迫走服务器 DASH 消耗带宽（CLI 仅为开启者本地高画质代理）。
   */
  hostCliEnabled?: boolean
  /**
   * 是否启用缓冲模式（仅 B站 DASH 源有效）。
   *
   * 启用后所有用户先从 B站 CDN 完整缓存 m4s 流到 IndexedDB，
   * 缓存完成后用 blob URL 播放，避免播放过程中 URL 过期或网络波动卡顿。
   * - 房主端：缓存完成后才广播 isPlaying=true
   * - 观众端：收到状态后独立缓存，缓存期间不应用 isPlaying，完成后跳转房主 currentTime
   */
  bufferMode?: boolean
  /**
   * MKV 快速路径：音轨为浏览器原生友好编码（AAC/MP3/Opus）时置位，
   * 跳过 playsvideo 重封装管线直接原生播放（原生失败自动回退管线）。
   */
  mkvFastPath?: boolean
  /**
   * 影片级浏览器播放引擎（playsvideo）开关（添加影片时设置并随状态广播）。
   * false 时强制原生直连播放；需与系统级开关（systemSettingsStore）
   * 同时开启才启用 playsvideo 管线。
   */
  playsvideoEnabled?: boolean
}

/** 房主发出的控制动作 */
export type ControlAction = 'play' | 'pause' | 'seek' | 'rate'

/** 房主发出的控制事件 payload */
export interface ControlPayload {
  action: ControlAction
  value?: number
}

/** `watch-together-state` 事件 payload */
export interface StatePayload {
  state: WatchTogetherState
  /** 增量字段（P1-Opt#7）：存在时观众端合并到现有 state，不存在时用 state 全量覆盖 */
  diff?: Partial<WatchTogetherState>
  /** 房主侧递增序号：观众检测跳号即请求全量状态自愈（避免 diff 基线错位） */
  seq?: number
}

/** `host-heartbeat` 事件 payload：房主定时广播的轻量心跳信息 */
export interface HeartbeatPayload {
  currentTime: number
  isPlaying: boolean
  /**
   * 播放倍速，用于观众端计算自适应 seek 阈值。
   *
   * v4 新增：旧版心跳不携带 playbackRate，观众端用 rate=1 计算阈值，
   * 在 2x 倍速下 5s 心跳间隔产生 10s 进度差异，超过 3s 阈值导致每次心跳都 seek。
   */
  playbackRate: number
  /**
   * 房主事件抑制标记。true 表示房主正在切换源/恢复进度，
   * 观众端收到时应仅重置离线计时器，不进行进度校正或 isPlaying 同步。
   *
   * v4 新增：旧版 suppress 期间完全不发心跳，大文件缓冲下载超过 15s 时
   * 观众端误判房主离线，进入自主控制模式。
   */
  suppressed?: boolean
}

/** 统一心跳协议（#14）：房主在线 / 房主离线共用同一事件 */
export interface SyncHeartbeatPayload {
  /** 来源：'host'（房主在线） | 'server'（房主离线，服务器接管） */
  source: 'host' | 'server'
  /** 房主在线时直接携带的字段 */
  currentTime?: number
  isPlaying?: boolean
  playbackRate?: number
  suppressed?: boolean
  /** 房主离线时由服务器推算的完整状态 */
  state?: WatchTogetherState
}

/** `viewer-joined` 事件 payload：观众加入房间通知 */
export interface ViewerJoinedPayload {
  viewerSocketId: string
  userId?: number
  username?: string
  role?: string
}

/** `viewer-left` 事件 payload：观众离开房间通知 */
export interface ViewerLeftPayload {
  viewerSocketId: string
}

/**
 * 轨道类型：弹幕或字幕。
 * 用于 `track-change` 事件的 type 字段。
 */
export type TrackType = 'danmaku' | 'subtitle'

/**
 * `track-change` 事件 payload（合并弹幕与字幕轨道切换）。
 *
 * - type='danmaku'：value 为弹幕轨道 ID（string）或 null（关闭弹幕）
 * - type='subtitle'：value 为字幕轨道索引（number）或 null（关闭字幕）
 *
 * 后端通过 `socket.to(roomId).emit('track-change', payload)` 转发给房间内其他成员。
 */
export interface TrackChangePayload {
  type: TrackType
  value: string | number | null
}

/**
 * 观众端轨道变化订阅回调的统一签名。
 * 弹幕轨道回调接收 string | null；字幕轨道回调接收 number | null。
 */
export type TrackChangeHandler<TValue> = (value: TValue | null) => void
