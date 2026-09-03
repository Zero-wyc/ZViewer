/**
 * 播放器模块公共 API（v2 重写，导出契约保持不变）。
 *
 * 模块结构（分离式架构）：
 * ```
 * player/
 * ├── types.ts                    引擎接口 + 源数据结构
 * ├── utils.ts                    视频元素工具（resetVideoElement / waitForMetadata）
 * ├── engine-selector.ts          引擎选择器（按 format + audioUrl 选择）
 * ├── engines/
 * │   ├── dash-engine.ts          DASH 引擎适配器（dash.js，双轨合并）
 * │   ├── hls-engine.ts           HLS 引擎（hls.js / Safari 原生）
 * │   ├── flv-engine.ts           FLV 引擎（flv.js）
 * │   ├── direct-engine.ts        Direct 引擎（浏览器原生播放）
 * │   ├── playsvideo-engine.ts    playsvideo 引擎（容器重封装 + 音轨转码）
 * │   ├── playsvideo-subtitle-bridge.ts  内嵌字幕 → ParsedCue[] 桥接
 * │   └── dash/                   DashPlayer 实现（虚拟 MPD + sidx 解析）
 * ├── services/
 * │   ├── audio-sync.ts           独立 Audio 元素音频同步
 * │   └── url-proxy.ts            B站 CDN 代理检测
 * └── index.ts                    本文件：公共 API 入口
 * ```
 *
 * 内嵌字幕完全由 playsvideo 提取，经 playsvideo-subtitle-bridge 转成
 * ParsedCue[] 交回上层字幕管线；播放器模块内不含字幕解析逻辑。
 */

// 引擎
export { dashEngine } from './engines/dash-engine'
export { hlsEngine } from './engines/hls-engine'
export { flvEngine } from './engines/flv-engine'
export { directEngine } from './engines/direct-engine'
export {
  playsVideoEngine,
  isPlaysVideoSupported,
} from './engines/playsvideo-engine'
export { selectEngine, shouldUsePlaysVideo } from './engine-selector'

// 工具函数
export { resetVideoElement, waitForMetadata } from './utils'

// 服务（供高级用例直接调用）
export { createAudioSync } from './services/audio-sync'
export {
  isBilibiliMediaUrl,
  buildProxyUrl,
  resolveProxyUrl,
  isLocalUrl,
  isRelativeUrl,
  isCliProxyUrl,
} from './services/url-proxy'

// DASH (dash.js) 专用导出
export { DashPlayer } from './engines/dash'
export type { DashPlayerOptions } from './engines/dash'

// Hooks
export { usePlayerSource } from './hooks'
export type { UsePlayerSourceOptions, UsePlayerSourceReturn } from './hooks'

// 类型
export type {
  EngineType,
  PlayerSource,
  EngineAttachResult,
  PlayerEngine,
  PlayerController,
  SeekResult,
} from './types'
