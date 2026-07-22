/**
 * Sync Playback Services Barrel Export
 *
 * 同步播放服务层：从 hooks 中抽取的纯函数逻辑，便于复用与测试。
 *
 * 服务划分：
 * - state-merge: 状态构建与比较（buildStateFromVideo / isStateEqual）
 * - broadcast-throttle: 广播节流与防抖（throttled / debounced seek）
 * - seek-strategy: seek 跟随与缓冲检测（自适应阈值 / 未缓冲区域检测）
 * - mse-reload: MSE 流重新加载（seek 到未缓冲区域时重新创建流）
 */
export { buildStateFromVideo, isStateEqual } from './state-merge'

export {
  createThrottledBroadcaster,
  createForceThrottledBroadcaster,
  createDebouncedSeek,
} from './broadcast-throttle'

export {
  getAdaptiveSeekThreshold,
  shouldSeekToHost,
  isInBufferedRange,
  isMseStream,
  needsMseReloadForSeek,
  waitForBuffered,
  findNearestBufferedTime,
} from './seek-strategy'

export { reloadMseAtTime } from './mse-reload'
export type {
  ReloadMseAtTimeOptions,
  ReloadMseAtTimeResult,
} from './mse-reload'
