/**
 * 客户端进度推算服务。
 *
 * 当房主离线、服务器接管广播时，观众端在两次 server-heartbeat 之间
 * 也需要本地推算进度，保证播放流畅（避免每 2s 才更新一次 currentTime）。
 *
 * 推算公式与后端 playbackMemoryService.advanceState 一致：
 *   elapsed = (Date.now() - lastUpdatedAt) / 1000
 *   actualCurrentTime = currentTime + elapsed * playbackRate * (isPlaying ? 1 : 0)
 */
import type { WatchTogetherState } from '@/modules/sync-playback/types'

/**
 * 客户端推算当前播放进度。
 *
 * @param state 最近一次收到的状态（含 updatedAt 时间戳）
 * @returns 推算后的 currentTime（秒）
 */
export function estimateCurrentTime(
  state: WatchTogetherState & { updatedAt?: number }
): number {
  if (!state.isPlaying) {
    return state.currentTime
  }

  const updatedAt = state.updatedAt ?? Date.now()
  const elapsedSec = (Date.now() - updatedAt) / 1000
  const estimated = state.currentTime + elapsedSec * state.playbackRate

  // 超过时长则停止在末尾
  if (state.duration && estimated >= state.duration) {
    return state.duration
  }

  return estimated
}

/**
 * 判断视频是否已播放结束（基于推算进度）。
 */
export function isPlaybackEnded(
  state: WatchTogetherState & { updatedAt?: number }
): boolean {
  if (!state.duration) return false
  return estimateCurrentTime(state) >= state.duration
}
