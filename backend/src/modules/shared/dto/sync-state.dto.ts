/**
 * 同步播放状态 DTO —— 统一定义。
 *
 * 消除旧架构中三处重复定义：
 * - services/room/state.ts 的 RoomState['playback']
 * - services/room/sync.ts 的 WatchTogetherStatePayload['state']
 * - routes/room.ts register-host 回调中 inline 定义的 playback 类型
 *
 * 所有模块（sync handler、room state、register-host）统一引用此类型。
 */

/** 源类型枚举 */
export type SourceType =
  | 'url'
  | 'webdav'
  | 'ftp'
  | 'openlist'
  | 'smb'
  | 'bilibili'
  | 'anime';

/** 媒体容器格式 */
export type MediaFormat =
  | 'mp4'
  | 'webm'
  | 'dash'
  | 'hls'
  | 'flv'
  | 'mkv'
  | 'avi'
  | string;

/** 清晰度选项 */
export interface QualityOptionDto {
  id: number;
  name: string;
}

/**
 * 同步播放状态。
 *
 * 这是房主广播给观众的完整状态，也是后端持久化到 roomState.playback 的状态。
 * 任何字段变更只需修改此定义，所有模块自动同步。
 */
export interface SyncStateDto {
  /** 视频源 URL（B站 DASH 为视频流 m4s 地址） */
  sourceUrl: string;
  /** 源类型 */
  sourceType: SourceType;
  /** DASH 音频流地址（独立于视频流） */
  audioUrl?: string;
  /** 媒体容器格式 */
  format?: MediaFormat;
  /** 视频编码（如 avc1.64001E），用于 MSE addSourceBuffer mime */
  videoCodec?: string;
  /** 音频编码（如 mp4a.40.2） */
  audioCodec?: string;
  /** B站视频 cid，用于加载官方弹幕 */
  cid?: number;
  /** 是否正在播放 */
  isPlaying: boolean;
  /** 当前播放进度（秒） */
  currentTime: number;
  /** 播放倍速 */
  playbackRate: number;
  /** 视频总时长（秒） */
  duration?: number;
  /** B站当前清晰度 qn（如 80=1080P、120=4K） */
  currentQn?: number;
  /** B站可用清晰度列表 */
  acceptQuality?: QualityOptionDto[];
  /** 源指定的防盗链 headers */
  headers?: Record<string, string>;
  /** 是否为预览源（不入影片列表） */
  isPreview?: boolean;
  /** 预览源显示标题 */
  previewTitle?: string;
}

/**
 * 持久化的播放状态（用于房主刷新/重连恢复）。
 *
 * 比 SyncStateDto 多 currentMovieId 和 updatedAt 字段。
 */
export interface PlaybackStateDto extends SyncStateDto {
  /** 当前播放的影片 ID，用于房主刷新后匹配是否还是同一部影片 */
  currentMovieId?: number;
  /** 最近一次更新的时间戳 */
  updatedAt: number;
}

/**
 * watch-together-state 事件 payload。
 *
 * 客户端 → 服务端：{ roomId, state: SyncStateDto }
 * 服务端 → 客户端：{ state: SyncStateDto }（不含 roomId）
 */
export interface SyncStatePayload {
  roomId: string;
  state: SyncStateDto;
}

/** 控制动作类型 */
export type ControlAction = 'play' | 'pause' | 'seek' | 'rate';

/**
 * watch-together-control 事件 payload。
 *
 * 客户端 → 服务端：{ roomId, action, value? }
 * 服务端 → 客户端：{ action, value? }
 */
export interface SyncControlPayload {
  roomId: string;
  action: ControlAction;
  value?: number;
}

/** 心跳 payload */
export interface HeartbeatPayload {
  roomId: string;
  currentTime: number;
  isPlaying: boolean;
}

/** 轨道类型 */
export type TrackType = 'danmaku' | 'subtitle';

/** 轨道变更 payload */
export interface TrackChangePayload {
  roomId: string;
  type: TrackType;
  value: string | number | null;
}

/**
 * 观众申请跳转 payload。
 *
 * 客户端 → 服务端：{ roomId, time }
 * 服务端 → 房主：{ roomId, viewerSocketId, viewerUsername, time }
 */
export interface SeekRequestPayload {
  roomId: string;
  time: number;
}

/** 房主转发给观众的 seek-request */
export interface SeekRequestForwardPayload {
  roomId: string;
  viewerSocketId: string;
  viewerUsername: string;
  time: number;
}

/** 房主回应跳转申请 payload */
export interface SeekResponsePayload {
  roomId: string;
  viewerSocketId: string;
  accept: boolean;
  time?: number;
}

/** 观众申请暂停 payload */
export interface PauseRequestPayload {
  roomId: string;
}

/** 房主转发给观众的 pause-request */
export interface PauseRequestForwardPayload {
  roomId: string;
  viewerSocketId: string;
  viewerUsername: string;
}

/** 房主回应暂停申请 payload */
export interface PauseResponsePayload {
  roomId: string;
  viewerSocketId: string;
  accept: boolean;
}

/** 观众申请继续播放 payload */
export interface PlayRequestPayload {
  roomId: string;
}

/** 房主转发给观众的 play-request */
export interface PlayRequestForwardPayload {
  roomId: string;
  viewerSocketId: string;
  viewerUsername: string;
}

/** 房主回应继续播放申请 payload */
export interface PlayResponsePayload {
  roomId: string;
  viewerSocketId: string;
  accept: boolean;
}
