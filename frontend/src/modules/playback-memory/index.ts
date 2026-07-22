/**
 * 播放记忆模块公共 API。
 *
 * 模块结构（分离式架构）：
 * ```
 * playback-memory/
 * ├── types.ts                       类型定义（ServerHeartbeatPayload / RequestStateAckData）
 * ├── services/
 * │   ├── state-advance.ts           客户端进度推算
 * │   ├── url-expiry.ts              B站 URL 过期检测
 * │   └── index.ts                   服务层 barrel export
 * ├── hooks/
 * │   ├── useServerHeartbeat.ts      订阅服务器心跳（房主离线时接管）
 * │   ├── usePlaybackStateRequest.ts 请求初始播放状态（ack 直返）
 * │   └── index.ts                   hooks barrel export
 * └── index.ts                       模块 barrel export
 * ```
 *
 * 设计目标：
 * - 播放进度由服务器端持久化存储
 * - 房主刷新/退出后视频继续播放（服务器推算进度并广播）
 * - 观众可继续观看，不受房主断开影响
 * - B站 URL 过期后观众端暂停并提示
 */
// Hooks
export { useServerHeartbeat, usePlaybackStateRequest } from './hooks'
export type {
  UseServerHeartbeatOptions,
  UseServerHeartbeatReturn,
  UsePlaybackStateRequestOptions,
  UsePlaybackStateRequestReturn,
} from './hooks'

// Services
export {
  estimateCurrentTime,
  isPlaybackEnded,
  isBilibiliUrlExpired,
  isVideoErrorFromExpiry,
  isVideoSourceExpired,
} from './services'

// Types
export type { ServerHeartbeatPayload, RequestStateAckData } from './types'
