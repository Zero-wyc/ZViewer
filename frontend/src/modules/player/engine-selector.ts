/**
 * 引擎选择器
 *
 * 根据源格式与音频轨信息选择合适的播放引擎。
 *
 * 选择逻辑：
 * 1. format='dash' 或 含 audioUrl → MSE 引擎（DASH 视频轨 + 音频轨合并）
 * 2. format='hls' → HLS 引擎
 * 3. format='flv' → FLV 引擎
 * 4. 其他 → Direct 引擎（浏览器原生播放 mp4/webm 等）
 */
import type { PlayerEngine, PlayerSource, EngineType } from './types'
import { mseEngine } from './engines/mse-engine'
import { hlsEngine } from './engines/hls-engine'
import { flvEngine } from './engines/flv-engine'
import { directEngine } from './engines/direct-engine'

/** 所有引擎实例（单例，无需重复创建） */
const ENGINES: Record<EngineType, PlayerEngine> = {
  mse: mseEngine,
  hls: hlsEngine,
  flv: flvEngine,
  direct: directEngine,
}

/**
 * 根据源数据选择合适的播放引擎。
 *
 * @param source 播放源数据
 * @returns 对应的 PlayerEngine 实例
 */
export function selectEngine(source: PlayerSource): PlayerEngine {
  if (source.format === 'dash' || source.audioUrl) {
    return ENGINES.mse
  }
  if (source.format === 'hls') {
    return ENGINES.hls
  }
  if (source.format === 'flv') {
    return ENGINES.flv
  }
  return ENGINES.direct
}
