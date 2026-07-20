/**
 * 同步播放模块公共 API
 *
 * 模块结构（分离式架构）：
 * ```
 * sync-playback/
 * ├── constants.ts          Socket 事件名 + 同步参数
 * ├── types.ts              共享类型（WatchTogetherState / Payload 类型）
 * ├── safePlay.ts           浏览器自动播放策略工具
 * ├── index.ts              本文件：公共 API 入口
 * └── hooks/
 *     ├── useHostBroadcast.ts        房主状态广播 + 控制 + forceSync
 *     ├── useViewerStateSync.ts      观众状态接收 + 控制事件
 *     ├── useHostStateRequest.ts     房主响应观众状态请求
 *     ├── useVideoEventBindings.ts   房主 video 元素事件绑定
 *     ├── useHostHeartbeat.ts        房主心跳广播
 *     ├── useViewerHeartbeat.ts      观众心跳检测 + 房主离线
 *     ├── useViewerList.ts           观众在线列表同步
 *     ├── useTrackSync.ts            弹幕/字幕轨道同步（合并事件）
 *     └── useVideoSource.ts          视频源管理 + MSE DASH 合并
 * ```
 *
 * 对外仅导出 hook 函数 + 必要类型；constants/types/safePlay 仅供模块内部使用，
 * 但通过 index re-export 便于外部按需引用（如 useWatchTogether 需要 SOCKET_EVENT）。
 */

// Hooks
export { useHostBroadcast } from './hooks/useHostBroadcast'
export type {
  UseHostBroadcastOptions,
  UseHostBroadcastReturn,
} from './hooks/useHostBroadcast'

export { useViewerStateSync } from './hooks/useViewerStateSync'
export type {
  UseViewerStateSyncOptions,
  UseViewerStateSyncReturn,
} from './hooks/useViewerStateSync'

export { useHostStateRequest } from './hooks/useHostStateRequest'
export type {
  UseHostStateRequestOptions,
  UseHostStateRequestReturn,
} from './hooks/useHostStateRequest'

export { useVideoEventBindings } from './hooks/useVideoEventBindings'
export type {
  UseVideoEventBindingsOptions,
  UseVideoEventBindingsReturn,
} from './hooks/useVideoEventBindings'

export { useHostHeartbeat } from './hooks/useHostHeartbeat'
export type {
  UseHostHeartbeatOptions,
  UseHostHeartbeatReturn,
} from './hooks/useHostHeartbeat'

export { useViewerHeartbeat } from './hooks/useViewerHeartbeat'
export type {
  UseViewerHeartbeatOptions,
  UseViewerHeartbeatReturn,
} from './hooks/useViewerHeartbeat'

export { useViewerList } from './hooks/useViewerList'
export type {
  UseViewerListOptions,
  UseViewerListReturn,
} from './hooks/useViewerList'

export { useTrackSync } from './hooks/useTrackSync'
export type {
  UseTrackSyncOptions,
  UseTrackSyncReturn,
} from './hooks/useTrackSync'

export { useVideoSource } from './hooks/useVideoSource'
export type {
  UseVideoSourceOptions,
  UseVideoSourceReturn,
} from './hooks/useVideoSource'

// 工具函数
export { safePlay } from './safePlay'
export type { SafePlayOptions } from './safePlay'

// 常量与类型（供 useWatchTogether / useBilibiliQuality 引用）
export { SOCKET_EVENT } from './constants'
export type {
  SourceType,
  VideoFormat,
  WatchTogetherState,
  ControlAction,
  ControlPayload,
  StatePayload,
  HeartbeatPayload,
  ViewerJoinedPayload,
  ViewerLeftPayload,
  TrackType,
  TrackChangePayload,
  TrackChangeHandler,
} from './types'
