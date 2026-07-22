/**
 * 状态合并服务
 *
 * 提供房主/观众状态构建与比较的纯函数，从 hooks 中抽取以便复用与测试。
 *
 * - `buildStateFromVideo`: 从 video 元素 + store 状态构建完整 WatchTogetherState
 * - `isStateEqual`: 浅比较两个状态是否等价（用于跳过等价广播）
 */
import type { WatchTogetherState } from '../types'

/**
 * 从 video 元素与 store 状态构建完整的 WatchTogetherState。
 *
 * 优先从 video 元素读取实时播放字段（isPlaying/currentTime/playbackRate/duration），
 * 源字段（sourceUrl/audioUrl/format 等）从 store 读取以保持稳定。
 *
 * 用于：
 * - 房主 forceSync（手动同步按钮）
 * - 房主响应观众 REQUEST_STATE
 * - 房主 timeupdate 广播
 *
 * @param video video 元素（可能为 null，此时回退到 store 状态）
 * @param storeState roomStore 中的 watchTogether 状态
 */
export function buildStateFromVideo(
  video: HTMLVideoElement | null,
  storeState: WatchTogetherState
): WatchTogetherState {
  const hasLoadedSource = !!video && video.currentSrc !== ''
  return {
    sourceUrl: storeState.sourceUrl,
    sourceType: storeState.sourceType,
    audioUrl: storeState.audioUrl,
    format: storeState.format,
    videoCodec: storeState.videoCodec,
    audioCodec: storeState.audioCodec,
    cid: storeState.cid,
    isPlaying: hasLoadedSource ? !video!.paused : storeState.isPlaying,
    currentTime: hasLoadedSource ? video!.currentTime : storeState.currentTime,
    playbackRate: hasLoadedSource
      ? video!.playbackRate
      : storeState.playbackRate,
    duration: hasLoadedSource
      ? video!.duration || storeState.duration
      : storeState.duration,
    currentQn: storeState.currentQn,
    acceptQuality: storeState.acceptQuality,
    headers: storeState.headers,
    isPreview: storeState.isPreview,
    previewTitle: storeState.previewTitle,
  }
}

/**
 * 浅比较两个 WatchTogetherState 是否等价。
 *
 * 用于房主广播前跳过等价状态，避免正常播放时（currentTime 自然增长）
 * 每 500ms 都触发广播。
 *
 * - currentTime 允许小幅差异（< 0.5s）视为相同
 * - acceptQuality 是数组，按引用 + 长度 + qn 字段比较
 *
 * @param a 上次广播的状态（null 表示首次，总是不等价）
 * @param b 当前状态
 */
export function isStateEqual(
  a: WatchTogetherState | null,
  b: WatchTogetherState
): boolean {
  if (!a) return false
  if (a === b) return true

  // 源字段
  if (
    a.sourceUrl !== b.sourceUrl ||
    a.sourceType !== b.sourceType ||
    a.audioUrl !== b.audioUrl ||
    a.format !== b.format ||
    a.videoCodec !== b.videoCodec ||
    a.audioCodec !== b.audioCodec ||
    a.cid !== b.cid
  ) {
    return false
  }

  // 播放字段
  if (
    a.isPlaying !== b.isPlaying ||
    a.playbackRate !== b.playbackRate ||
    a.duration !== b.duration
  ) {
    return false
  }

  // currentTime 单独处理：允许小幅差异（< 0.5s）视为相同，
  // 避免房主正常播放时每 500ms 都触发广播（自然进度差 ~0.5s）。
  if (Math.abs(a.currentTime - b.currentTime) > 0.5) return false

  // B站 清晰度字段
  if (a.currentQn !== b.currentQn) return false

  // acceptQuality 浅比较
  const aqA = a.acceptQuality
  const aqB = b.acceptQuality
  if (aqA === aqB) return true
  if (!aqA || !aqB || aqA.length !== aqB.length) return false
  for (let i = 0; i < aqA.length; i++) {
    if (aqA[i].id !== aqB[i].id || aqA[i].label !== aqB[i].label) return false
  }

  // 预览字段
  if (a.isPreview !== b.isPreview || a.previewTitle !== b.previewTitle) {
    return false
  }

  return true
}
