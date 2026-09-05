/**
 * 引擎选择器
 *
 * 根据源格式与音频轨信息选择合适的播放引擎。
 *
 * 选择逻辑：
 * 1. format='dash' 或 含 audioUrl → DASH 引擎（dash.js，动态生成 MPD 包装 m4s）
 * 2. format='hls' → HLS 引擎
 * 3. format='flv' → FLV 引擎
 * 4. 需要浏览器端重封装/转码 → playsvideo 引擎（见 shouldUsePlaysVideo）
 * 5. 其他 → Direct 引擎（浏览器原生播放 mp4/webm 等）
 *
 * 注：自研 MSE 引擎已移除（曾长期不可达：所有含独立音频轨的源统一由
 *    dash.js 引擎处理，失败时降级为 direct + audio-sync）。
 */
import type { PlayerEngine, PlayerSource } from './types'
import { dashEngine } from './engines/dash-engine'
import { hlsEngine } from './engines/hls-engine'
import { flvEngine } from './engines/flv-engine'
import { directEngine } from './engines/direct-engine'
import {
  playsVideoEngine,
  isPlaysVideoSupported,
} from './engines/playsvideo-engine'
import { needsBrowserTranscode } from '@/lib/audioCodecs'

/** 所有引擎实例（单例，无需重复创建） */
const ENGINES: Record<string, PlayerEngine> = {
  dash: dashEngine,
  hls: hlsEngine,
  flv: flvEngine,
  direct: directEngine,
  playsvideo: playsVideoEngine,
}

/**
 * 浏览器完全不支持的容器，必须经 playsvideo 重封装为 fMP4 才能播放。
 *
 * 这些格式在旧版中会被 usePlayerSource 的格式预检直接拒绝（黑屏 + 提示
 * 「不被浏览器原生支持」），playsvideo 让它们变为可播。
 */
const REMUX_ONLY_FORMATS = ['avi', 'ts', 'wmv']

/**
 * 判断该源是否应交给 playsvideo 引擎。
 *
 * 判定不受任何开关门控——只要浏览器具备运行条件（MSE + Worker）即生效：
 *
 * 1. **avi / ts / wmv** —— 浏览器无法原生打开，只能重封装。
 * 2. **mkv** —— 一律交给 playsvideo。理由有二：浏览器对 MKV 的原生支持
 *    仅限 H.264/AAC 组合，容错面窄；且 DTS/AC3 等音轨需要浏览器端转码。
 *    playsvideo 在直通模式下仍是 `video.src` 原生解码，不产生重封装开销。
 *    （内嵌字幕与此选择无关：由自研提取器 subtitles/mkv-embedded 提供）
 * 3. **其他容器（mp4 / webm / mov）** —— 仅当音轨明确不被浏览器支持时
 *    介入。这类源原生播放已经完美，无谓地走一遍 demux 只会徒增延迟与
 *    代理流量。
 *
 * 抽成本函数供 usePlayerSource 的格式预检复用，避免「预检放行」与
 * 「引擎选择」两处判定漂移。
 */
export function shouldUsePlaysVideo(source: PlayerSource): boolean {
  if (!isPlaysVideoSupported()) return false
  // MKV 快速路径：编解码原生友好时先尝试 <video> 原生播放，
  // 原生失败由 usePlayerSource 置 forcePlaysVideo 回退管线
  if (source.forcePlaysVideo) return true
  const format = source.format
  if (format && (REMUX_ONLY_FORMATS as string[]).includes(format)) return true
  if (format === 'mkv') return !source.mkvFastPath

  return !!source.audioCodec && needsBrowserTranscode(source.audioCodec)
}

/**
 * 根据源数据选择合适的播放引擎。
 */
export function selectEngine(source: PlayerSource): PlayerEngine {
  // DASH 源或含独立音频轨 → dash.js 引擎
  // （自研 MSE 引擎暂时禁用，统一由 dash.js 处理双轨合并）
  if (source.format === 'dash' || source.audioUrl) {
    return ENGINES.dash
  }
  if (source.format === 'hls') {
    return ENGINES.hls
  }
  if (source.format === 'flv') {
    return ENGINES.flv
  }
  if (shouldUsePlaysVideo(source)) {
    return ENGINES.playsvideo
  }
  return ENGINES.direct
}
