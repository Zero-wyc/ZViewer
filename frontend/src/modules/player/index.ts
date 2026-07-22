/**
 * 播放器模块公共 API
 *
 * 模块结构（分离式架构）：
 * ```
 * player/
 * ├── types.ts                    引擎接口 + 源数据结构
 * ├── utils.ts                    视频元素工具（resetVideoElement / waitForMetadata）
 * ├── engine-selector.ts          引擎选择器（按 format + audioUrl 选择）
 * ├── engines/
 * │   ├── mse-engine.ts           MSE DASH 引擎（流式合并 + 缓冲管理）
 * │   ├── hls-engine.ts           HLS 引擎（hls.js / Safari 原生）
 * │   ├── flv-engine.ts           FLV 引擎（flv.js）
 * │   └── direct-engine.ts        Direct 引擎（浏览器原生播放）
 * ├── services/
 * │   ├── buffer-manager.ts       SourceBuffer 缓冲管理（prune / append / quota 恢复）
 * │   ├── audio-sync.ts           独立 Audio 元素音频同步
 * │   └── url-proxy.ts            B站 CDN 代理检测
 * └── index.ts                    本文件：公共 API 入口
 * ```
 */

// 引擎
export { mseEngine } from './engines/mse-engine'
export { hlsEngine } from './engines/hls-engine'
export { flvEngine } from './engines/flv-engine'
export { directEngine } from './engines/direct-engine'
export { selectEngine } from './engine-selector'

// 工具函数
export { resetVideoElement, waitForMetadata } from './utils'

// 服务（供高级用例直接调用）
export { createAudioSync } from './services/audio-sync'
export { isBilibiliMediaUrl, buildProxyUrl } from './services/url-proxy'
export {
  appendBuffer,
  isQuotaExceededError,
  getBufferedEnd,
  getBufferedAhead,
  forcePruneSourceBuffer,
  pruneSourceBuffer,
  clearSourceBuffer,
} from './services/buffer-manager'

// MSE 专用导出（供 useBilibiliQuality 等需要直接控制 MSE 的场景）
export { createMseMediaUrl } from './engines/mse-engine'

// Hooks
export {
  usePlayerSource,
  usePlayerControls,
  usePlayerEvents,
  usePlayer,
} from './hooks'
export type {
  UsePlayerSourceOptions,
  UsePlayerSourceReturn,
  UsePlayerControlsOptions,
  UsePlayerControlsReturn,
  UsePlayerEventsOptions,
  UsePlayerEventsReturn,
  UsePlayerOptions,
  UsePlayerReturn,
} from './hooks'

// 类型
export type {
  EngineType,
  PlayerSource,
  EngineAttachResult,
  PlayerEngine,
} from './types'
