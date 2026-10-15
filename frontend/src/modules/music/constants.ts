/**
 * 一起听播放页共享常量（纯数据层）。
 *
 * 从 ListenTogetherPanel 抽出的零副作用常量集合：同一语义此前在多份文件里
 * 各写一份（如播放模式轮换顺序在播放面板与底栏 MusicWidgetBar 各存一份），
 * 现统一由此文件单点定义，组件侧一律 import，避免改一处漏一处。
 *
 * 约束：仅依赖 type-only import，不得引入运行时依赖，保持任何层可安全引用。
 */
import type { PlayMode } from './types'

/** syncNotice（房主审批提示）自动消失时长（毫秒） */
export const SYNC_NOTICE_AUTO_DISMISS_MS = 5000

/** 歌词高亮提前量（秒）：接近下一行时间标签前即切换高亮 */
export const LYRIC_ADVANCE_SEC = 0.2

/** 播放模式轮换顺序（order = 按顺序播放，不循环；B站 推荐连播仅此模式启用） */
export const PLAY_MODE_ORDER: PlayMode[] = [
  'order',
  'repeat-one',
  'shuffle',
  'sequence',
]

/** 播放模式按钮文案映射：label = 当前模式名，next = 点击后切换到的模式（合成 title） */
export const PLAY_MODE_META: Record<PlayMode, { label: string; next: string }> =
  {
    sequence: { label: '顺序循环', next: '切换为按顺序播放' },
    order: { label: '按顺序播放', next: '切换为单曲循环' },
    'repeat-one': { label: '单曲循环', next: '切换为随机播放' },
    shuffle: { label: '随机播放', next: '切换为顺序循环' },
  }

// ==================== 视频背景进度同步校正 ====================
// 背景 MV 与音频是两个独立媒体元素，随时间自然漂移；此处一组阈值定义
// 「何时安排 seek / 何时用倍速慢慢追赶」的策略参数，实际执行逻辑在播放页
// 主组件的后台同步 effect 中。

/** 漂移校正阈值（秒）：偏差超过该值才安排 seek，避免每次 timeupdate 都 seek
 *  造成视频反复卡顿 */
export const BG_VIDEO_SYNC_THRESHOLD_SEC = 1.5

/** 大漂移 seek 的去抖窗口（毫秒）：拖动进度条期间只更新目标位置，
 *  停止后仅执行一次 seek——避免拖动过程连续大跨度 seek 导致性能猛增 */
export const BG_VIDEO_SEEK_DEBOUNCE_MS = 350

/** 追赶完成判定（秒）：seek 后残余漂移小于该值视为已同步，恢复原速 */
export const BG_VIDEO_CATCHUP_EPSILON_SEC = 0.35

/** 追赶增益（秒）：rate = 1 + drift / 该值，漂移越大追得越快（约 4s 收敛） */
export const BG_VIDEO_CATCHUP_GAIN_SEC = 4

/** 追赶 playbackRate 上下限：顺序解码远比随机 seek 便宜，用倍速慢慢吸收
 *  seek 耗时内音频多走的量（背景视频无声，轻微变速无感知） */
export const BG_VIDEO_MAX_RATE = 1.5
export const BG_VIDEO_MIN_RATE = 0.6

// ==================== 一起听同步信令（架构对齐一起看 sync-playback） ====================
// 服务器权威心跳架构：房主上行（sync-state / host-heartbeat）附 clientTs，
// 服务器写侧补偿传输延迟锚定服务器时间轴；服务器每 2s 广播推算状态
// （music:sync-heartbeat source='server'）——观众进度唯一权威来源；
// 观众每 10s check-status 主动自检（±10s 容差）作心跳丢失时的自愈通道。

/** 一起听 Socket 事件名（与后端 MusicSyncHandler / MusicBroadcasterService 约定） */
export const MUSIC_SOCKET_EVENT = {
  /** 房主离散操作广播（换曲/播放暂停/seek/模式；低延迟操作通道） */
  SYNC_STATE: 'music:sync-state',
  /** 房主心跳（服务器基线更新通道；新前端观众仅在 fallback 时消费） */
  HOST_HEARTBEAT: 'music:host-heartbeat',
  /** 服务器心跳广播（source='server'，观众进度唯一权威来源） */
  SYNC_HEARTBEAT: 'music:sync-heartbeat',
  /** 观众主动自检（±10s 容差，服务器心跳丢失时的自愈通道） */
  CHECK_STATUS: 'music:check-status',
  /** 队列变更全房间广播 */
  QUEUE_CHANGED: 'music:queue-changed',
  /** 观众申请制控制 */
  CONTROL_REQUEST: 'music:control-request',
  CONTROL_RESPONSE: 'music:control-response',
  /** 观众切歌同步成功回执 */
  SYNC_ACK: 'music:sync-ack',
  /** 加入房间后的初始状态查询（ack 返回 queue/syncState/serverTs/hostOnline） */
  GET_STATE: 'music:get-state',
  /** 房主断连（房间级通用事件，服务器广播；观众进入自主控制模式） */
  HOST_DISCONNECTED: 'host-disconnected',
  /** 房主重连就绪（房间级通用事件，服务器广播；观众恢复跟随） */
  SHARER_READY: 'sharer-ready',
} as const

/** 观众 CHECK_STATUS 自检间隔（毫秒；远大于 2s 服务器心跳周期） */
export const MUSIC_CHECK_STATUS_INTERVAL_MS = 10000

/**
 * 服务器心跳失联判定（毫秒）：超过该时长未收到 music:sync-heartbeat 时，
 * 观众回退消费房主心跳（兼容旧后端未广播服务器心跳的窗口）。
 */
export const SERVER_HEARTBEAT_STALE_MS = 7000

/** 观众同曲进度对齐阈值（秒）：偏差超过该值才 seek，小偏差自然播放 */
export const SYNC_ALIGN_THRESHOLD_SEC = 2
