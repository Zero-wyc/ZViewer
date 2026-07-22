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
 * ├── services/             纯函数服务层（从 hooks 抽取的可复用逻辑）
 * │   ├── state-merge.ts            状态构建与比较（buildStateFromVideo / isStateEqual）
 * │   ├── broadcast-throttle.ts     广播节流与防抖（throttled / debounced seek）
 * │   ├── seek-strategy.ts          seek 跟随与缓冲检测（自适应阈值 / 未缓冲区域检测）
 * │   └── index.ts                  服务层 barrel export
 * └── hooks/
 *     ├── useHostSync.ts             房主统一同步（组合广播+请求+心跳+事件绑定）
 *     ├── useViewerSync.ts           观众统一同步（组合状态接收+服务器心跳）
 *     ├── useHostBroadcast.ts        房主状态广播 + 控制 + forceSync
 *     ├── useViewerStateSync.ts      观众状态接收 + 控制事件
 *     ├── useHostStateRequest.ts     房主响应观众状态请求
 *     ├── useVideoEventBindings.ts   房主 video 元素事件绑定
 *     ├── useHostHeartbeat.ts        房主心跳广播
 *     ├── useViewerList.ts           观众在线列表同步
 *     ├── useTrackSync.ts            弹幕/字幕轨道同步（合并事件）
 *     └── useVideoSource.ts          视频源管理 + MSE DASH 合并
 * ```
 *
 * 对外仅导出 hook 函数 + 必要类型；constants/types/safePlay 仅供模块内部使用，
 * 但通过 index re-export 便于外部按需引用（如 useWatchTogether 需要 SOCKET_EVENT）。
 */

// Hooks
// 统一编排 hooks（推荐使用，组合了多个子 hook）
export { useHostSync } from './hooks/useHostSync'
export type { UseHostSyncOptions, UseHostSyncReturn } from './hooks/useHostSync'

export { useViewerSync } from './hooks/useViewerSync'
export type {
  UseViewerSyncOptions,
  UseViewerSyncReturn,
} from './hooks/useViewerSync'

// 子 hooks（供需要精细控制的场景使用）
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

// Services（纯函数服务层）
export {
  buildStateFromVideo,
  isStateEqual,
  createThrottledBroadcaster,
  createForceThrottledBroadcaster,
  createDebouncedSeek,
  getAdaptiveSeekThreshold,
  shouldSeekToHost,
  isInBufferedRange,
  isMseStream,
  needsMseReloadForSeek,
  waitForBuffered,
  findNearestBufferedTime,
  reloadMseAtTime,
} from './services'
export type {
  ReloadMseAtTimeOptions,
  ReloadMseAtTimeResult,
} from './services'

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
