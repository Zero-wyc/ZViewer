/**
 * 字幕解析 Web Worker：把 `parseSubtitle` 的 CPU 密集解析移出主线程。
 *
 * 场景：内嵌字幕提取（playsvideo-subtitle-bridge）与自研 MKV demux 提取
 * 可能同时取回多条几 MB 的 ASS/SSA 轨道——主线程同帧解析会卡 UI 数秒，
 * 下放 worker 后解析完全不占用主线程。
 *
 * `parseSubtitle` 为纯函数（无 DOM / window 依赖），文本进 ParsedCue[] 出，
 * 结果可结构化克隆。调用方需带主线程回退（见
 * playsvideo-subtitle-bridge 的 parseOffMainThread）——worker 构建失败
 * （极端环境 CSP 等）时回退主线程解析，功能不降级。
 */
import { parseSubtitle, type SubtitleFormat } from './subtitleParser'

export interface SubtitleParseRequest {
  text: string
  format: SubtitleFormat
}

export interface SubtitleParseResponse {
  cues: import('./subtitleParser').ParsedCue[]
  error?: string
}

self.onmessage = (e: MessageEvent<SubtitleParseRequest>) => {
  const { text, format } = e.data
  try {
    self.postMessage({
      cues: parseSubtitle(text, format),
    } satisfies SubtitleParseResponse)
  } catch (err) {
    self.postMessage({
      cues: [],
      error: String(err),
    } satisfies SubtitleParseResponse)
  }
}
