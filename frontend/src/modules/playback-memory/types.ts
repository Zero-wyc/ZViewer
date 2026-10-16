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
 * 服务器每 2s 恒定广播一次（Step 2：房主在线/离线同一路径），
 * 携带推算后的播放状态（权威进度，基线已经传输延迟补偿）。
 */
export interface ServerHeartbeatPayload {
  roomId: string
  state: WatchTogetherState
  /** 房主在线状态（服务器随心跳持续下发，驱动观众自主控制模式判定） */
  hostOnline?: boolean
}

/**
 * 请求状态 ack 响应数据。
 *
 * 后端 PlaybackMemoryHandler 处理 watch-together-request-state 时返回。
 */
export interface RequestStateAckData {
  /** 推算后的播放状态，若房间无播放状态则为 null */
  state: WatchTogetherState | null
  /** 服务器应答时刻（Unix 毫秒），客户端可据此估算时钟偏移（时钟校准铺路） */
  serverTs?: number
  /**
   * 房主在线状态（与一起听 get-state 的 hostOnline 对齐）。
   * false = 观众在房主离线后才加入/刷新，应直接进入自主控制模式。
   */
  hostOnline?: boolean
}

/**
 * 观众主动自检 ack 响应数据（CHECK_STATUS，Step 3）。
 *
 * needsSync=true 时携带服务器权威推算状态，观众端复用服务器心跳
 * 的校正逻辑应用；false 表示本地状态在容差内，无需纠偏。
 */
export interface CheckStatusAckData {
  needsSync: boolean
  /** 服务器权威推算状态（仅 needsSync=true 时存在） */
  state?: WatchTogetherState
  /** 服务器应答时刻（Unix 毫秒），时钟偏移估算铺路 */
  serverTs?: number
}
