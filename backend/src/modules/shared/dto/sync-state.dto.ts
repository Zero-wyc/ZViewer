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
  /**
   * 房主是否启用了 CLI 高画质代理（仅房主广播时设置）。
   * 观众收到此标记后强制走 MP4，避免被迫走服务器 DASH。
   */
  hostCliEnabled?: boolean;
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
  /** 是否启用缓冲模式（B站 DASH 源：先完整缓存到 IndexedDB 再播放） */
  bufferMode?: boolean;
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
  /** 增量字段（P1-Opt#7）：观众端合并到现有 state，不存在时用 state 全量覆盖 */
  diff?: Partial<SyncStateDto>;
  /**
   * 房主侧递增序号：观众检测到跳号（seq > lastSeq + 1）说明错失了中间
   * 广播（socket 重连窗口），主动请求全量状态自愈，避免 diff 合并基线错位。
   */
  seq?: number;
  /**
   * 客户端发送时刻的 Unix 毫秒时间戳。
   * 服务端据此补偿传输延迟（clamp 0~1.5s × playbackRate），
   * 使持久化基线锚定在服务器时间轴上（Step 1：服务器权威化写入）。
   */
  clientTs?: number;
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
  /**
   * 客户端发送时刻的 Unix 毫秒时间戳。
   * 服务端对 play/seek 指令补偿传输延迟（同 SyncStatePayload.clientTs）。
   */
  clientTs?: number;
}

/** 心跳 payload */
export interface HeartbeatPayload {
  roomId: string;
  currentTime: number;
  isPlaying: boolean;
  /** 当前播放倍速（观众端据此计算进度校正阈值） */
  playbackRate: number;
  /** suppressed 标记：源切换/恢复进度期间的心跳，仅用于存活检测，不用于状态同步 */
  suppressed?: boolean;
  /**
   * 客户端发送时刻的 Unix 毫秒时间戳。
   * 服务端据此补偿传输延迟后再合并进播放记忆基线（仅播放中）。
   */
  clientTs?: number;
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
