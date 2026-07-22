/**
 * Player Hooks Barrel Export
 *
 * 播放器 Hooks 层公共 API。
 *
 * Hook 职责分层：
 * - usePlayerSource: 引擎选择 + 源 attach/cleanup（引擎无关）
 * - usePlayerControls: 播放/暂停/seek/倍速控制（纯本地操作）
 * - usePlayerEvents: 通用事件订阅（回调式，不含广播逻辑）
 * - usePlayer: 顶层编排，组合以上三个 hooks
 */
export { usePlayerSource } from './usePlayerSource'
export type {
  UsePlayerSourceOptions,
  UsePlayerSourceReturn,
} from './usePlayerSource'

export { usePlayerControls } from './usePlayerControls'
export type {
  UsePlayerControlsOptions,
  UsePlayerControlsReturn,
} from './usePlayerControls'

export { usePlayerEvents } from './usePlayerEvents'
export type {
  UsePlayerEventsOptions,
  UsePlayerEventsReturn,
} from './usePlayerEvents'

export { usePlayer } from './usePlayer'
export type { UsePlayerOptions, UsePlayerReturn } from './usePlayer'
