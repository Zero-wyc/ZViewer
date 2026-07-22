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
  | 'url'
  | 'webdav'
  | 'ftp'
  | 'openlist'
  | 'smb'
  | 'bilibili'
  | 'anime'
  | string

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
}

/** `host-heartbeat` 事件 payload：房主定时广播的轻量心跳信息 */
export interface HeartbeatPayload {
  currentTime: number
  isPlaying: boolean
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
  socketId: string
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
