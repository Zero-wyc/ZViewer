/**
 * 播放记忆模块类型定义。
 *
 * 与后端 PlaybackStateDto 对应，但复用 sync-playback 的 WatchTogetherState
 * 避免类型重复定义。
 */
import type { WatchTogetherState } from '@/modules/sync-playback/types'

/**
 * 服务器心跳事件 payload。
 *
 * 服务器在房主离线期间每 2s 广播一次，携带推算后的播放状态。
 * 房主在线时由房主的 watch-together-state 事件驱动，服务器不广播。
 */
export interface ServerHeartbeatPayload {
  roomId: string
  state: WatchTogetherState
}

/**
 * 请求状态 ack 响应数据。
 *
 * 后端 PlaybackMemoryHandler 处理 watch-together-request-state 时返回。
 */
export interface RequestStateAckData {
  /** 推算后的播放状态，若房间无播放状态则为 null */
  state: WatchTogetherState | null
}
