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
 *
 * v3 同步参数调优（解决观众端频繁卡顿）：
 * - 房主 timeupdate 不再触发广播，仅离散事件 + 定时心跳广播
 * - 观众端 seek 跟随阈值从 0.5s 提升至 3s，避免小幅漂移触发 seek
 * - 房主定时心跳广播间隔从 2s 提升至 5s，降低网络压力
 * - 观众端收到 state 时仅在大幅差异时 seek，小差异让视频自然播放
 */

// ===== Socket 事件名 =====

export const SOCKET_EVENT = {
  /** 房主广播完整播放状态 */
  STATE: 'watch-together-state',
  /** 房主发送控制指令（play/pause/seek/rate） */
  CONTROL: 'watch-together-control',
  /** 观众请求当前播放状态（ack 直返服务器推算状态） */
  REQUEST_STATE: 'watch-together-request-state',
  /**
   * 观众主动自检（Step 3，参考 synctv CHECK_STATUS）：
   * 观众每 10s 上报本地播放状态，服务端与权威推算状态比对（±10s 容差），
   * 分歧超限通过 ack 下发权威进度——服务器周期心跳丢失时的自愈通道。
   */
  CHECK_STATUS: 'watch-together-check-status',
  /** 影片列表更新 */
  MOVIE_LIST: 'movie-list',
  /** 当前播放影片变更 */
  CURRENT_MOVIE: 'current-movie',
  /** 请求当前播放影片 */
  REQUEST_CURRENT_MOVIE: 'request-current-movie',
  /** 房主播放预览源（不写入影片列表，直接广播播放状态） */
  PREVIEW_SOURCE: 'preview-source',
  /** 房主心跳：定时广播当前播放进度与播放状态，用于观众端跟随与离线检测 */
  HOST_HEARTBEAT: 'host-heartbeat',
  /**
   * 服务器心跳：房主离线期间由服务器每 2s 广播，携带推算后的播放状态。
   * 观众端据此继续播放，不因房主断开而暂停。
   */
  SERVER_HEARTBEAT: 'server-heartbeat',
  /**
   * 统一心跳协议（#14）：房主在线(source='host')与房主离线(source='server')
   * 共用同一事件，viewer 端按 source 字段区分来源。
   */
  SYNC_HEARTBEAT: 'sync-heartbeat',
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
 *
 * v3：仅用于离散事件后的节流兜底，正常 timeupdate 不再触发广播。
 * 降低该值可提升离散事件响应实时性。
 */
export const BROADCAST_THROTTLE_MS = 500

/**
 * 观众进度跟随阈值（秒）。
 * 当观众本地进度与房主状态差距超过该值时，自动 seek 到房主进度。
 *
 * v3：从 0.5s 提升至 3s，避免小幅网络抖动 / 倍速差异导致高频 seek 卡顿。
 * 实际阈值会按播放倍速自适应放大（见 useViewerStateSync）：
 *   adaptiveThreshold = max(SEEK_FOLLOW_THRESHOLD, playbackRate * 1.5)
 * 这样在 2x 倍速下阈值变为 3s（保持 3s 基准），1x 倍速也保持 3s。
 */
export const SEEK_FOLLOW_THRESHOLD = 3

/**
 * 房主 seek 事件防抖间隔（毫秒）。
 * 避免拖动进度条时频繁广播。
 */
export const SEEK_DEBOUNCE_MS = 300

/** play/pause 事件防抖间隔（毫秒）。快速切换播放/暂停时避免冗余广播。 */
export const PLAY_PAUSE_DEBOUNCE_MS = 100

/**
 * 房主心跳广播间隔（毫秒）。
 * 房主每隔该时长向房间广播一次 HOST_HEARTBEAT 事件，
 * 携带完整 state 用于观众端进度校正与离线检测。
 *
 * v3：从 2s 提升至 5s，降低高频广播带来的网络压力与观众端卡顿。
 * 观众端通过离散事件（play/pause/seek/rate）获得即时响应，
 * 心跳仅用于周期性进度校正，5s 间隔足够保持同步。
 */
export const HEARTBEAT_INTERVAL_MS = 5000

/**
 * 房主心跳超时阈值（毫秒）。
 * 观众若在该时长内未收到房主心跳，则判定房主已离线。
 *
 * v3：从 6s 提升至 15s（3 倍心跳间隔），避免网络抖动导致误判。
 */
export const HEARTBEAT_TIMEOUT_MS = 15000

/**
 * 观主动自检间隔（毫秒，Step 3）。
 * 观众每隔该时长 emit CHECK_STATUS 上报本地状态，服务端比对 ±10s 容差，
 * 超限才下发权威进度。作为服务器心跳（2s）丢失时的自愈通道，
 * 间隔远大于心跳周期，正常情况下自检几乎不触发纠偏。
 */
export const CHECK_STATUS_INTERVAL_MS = 10000

/**
 * 状态广播时的 currentTime 差异阈值（秒）。
 * 当仅 currentTime 变化且差异小于该值时，跳过广播（视为自然播放进度）。
 * 差异大于该值（如 seek）或 isPlaying/playbackRate 变化时仍会广播。
 *
 * v3：从 0.5s 提升至 2s，房主正常播放时几乎不触发广播，
 * 仅离散事件与定时心跳驱动同步。
 */
export const STATE_BROADCAST_TIME_THRESHOLD = 2
