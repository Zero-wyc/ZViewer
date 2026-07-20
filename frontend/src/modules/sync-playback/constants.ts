/**
 * 同步播放模块常量
 *
 * 集中定义 Socket 事件名与同步参数，便于统一调整与测试。
 *
 * 协议精简说明（v2）：
 * - 合并 `danmaku-track-change` + `subtitle-track-change` → `track-change`（按 type 字段区分）
 * - 移除 `quality-change`：清晰度信息已包含在 `watch-together-state.currentQn` 中，
 *   房主切换清晰度后调用 forceSync 立即广播完整状态即可
 * - 后端新增 `track-change` + `host-heartbeat` 转发处理（旧版未转发导致功能失效）
 */

// ===== Socket 事件名 =====

export const SOCKET_EVENT = {
  /** 房主广播完整播放状态 */
  STATE: 'watch-together-state',
  /** 房主发送控制指令（play/pause/seek/rate） */
  CONTROL: 'watch-together-control',
  /** 观众请求房主当前状态（用于初始同步） */
  REQUEST_STATE: 'watch-together-request-state',
  /** 影片列表更新 */
  MOVIE_LIST: 'movie-list',
  /** 当前播放影片变更 */
  CURRENT_MOVIE: 'current-movie',
  /** 请求当前播放影片 */
  REQUEST_CURRENT_MOVIE: 'request-current-movie',
  /** 房主心跳：定时广播当前播放进度与播放状态，用于观众端离线检测 */
  HOST_HEARTBEAT: 'host-heartbeat',
  /** 观众加入房间通知（后端转发给房主） */
  VIEWER_JOINED: 'viewer-joined',
  /** 观众离开房间通知（后端转发给房主） */
  VIEWER_LEFT: 'viewer-left',
  /**
   * 轨道切换同步（合并事件）。
   * payload: { type: 'danmaku' | 'subtitle', value: string | number | null }
   * - type='danmaku'：value 为弹幕轨道 ID（string）或 null（关闭）
   * - type='subtitle'：value 为字幕轨道索引（number）或 null（关闭）
   */
  TRACK_CHANGE: 'track-change',
  /** 房主断开连接通知（后端在房主掉线时广播给观众） */
  HOST_DISCONNECTED: 'host-disconnected',
} as const

// ===== 同步参数 =====

/**
 * 房主 `timeupdate` 事件触发的状态广播节流间隔（毫秒）。
 * 降低该值可提升同步实时性，但会增加 Socket 流量。
 */
export const BROADCAST_THROTTLE_MS = 500

/**
 * 观众进度跟随阈值（秒）。
 * 当观众本地进度与房主状态差距超过该值时，自动 seek 到房主进度。
 *
 * 注意：实际阈值会按播放倍速自适应放大（见 useViewerStateSync）：
 *   adaptiveThreshold = max(SEEK_FOLLOW_THRESHOLD, playbackRate * 0.5)
 * 这样在 2x 倍速下阈值变为 1s，避免高频 seek 抖动；1x 倍速仍保持 0.5s。
 */
export const SEEK_FOLLOW_THRESHOLD = 0.5

/**
 * 房主 seek 事件防抖间隔（毫秒）。
 * 避免拖动进度条时频繁广播。
 */
export const SEEK_DEBOUNCE_MS = 200

/**
 * 房主心跳广播间隔（毫秒）。
 * 房主每隔该时长向房间广播一次 HOST_HEARTBEAT 事件，观众据此判断房主是否在线。
 */
export const HEARTBEAT_INTERVAL_MS = 2000

/**
 * 房主心跳超时阈值（毫秒）。
 * 观众若在该时长内未收到房主心跳，则判定房主已离线并暂停本地播放。
 */
export const HEARTBEAT_TIMEOUT_MS = 6000

/**
 * 状态广播时的 currentTime 差异阈值（秒）。
 * 当仅 currentTime 变化且差异小于该值时，跳过广播（视为自然播放进度）。
 * 差异大于该值（如 seek）或 isPlaying/playbackRate 变化时仍会广播。
 */
export const STATE_BROADCAST_TIME_THRESHOLD = 0.5
