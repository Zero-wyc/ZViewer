/**
 * Player Hooks Barrel Export
 *
 * 播放器 Hooks 层公共 API。
 *
 * - usePlayerSource: 引擎选择 + 源 attach/cleanup（引擎无关）。
 *   ArtPlayer 重构后，引擎 attach 目标为 art.video（原生 video 元素），
 *   本 Hook 的串行队列 / 去重 / forceReload 语义保持不变。
 */
export { usePlayerSource, getActiveEngineType } from './usePlayerSource'
export type {
  UsePlayerSourceOptions,
  UsePlayerSourceReturn,
} from './usePlayerSource'
