/**
 * Seek 策略服务
 *
 * 提供观众端 seek 跟随与未缓冲区域检测的纯函数。
 *
 * - `getAdaptiveSeekThreshold`: 按播放倍速自适应的 seek 跟随阈值
 * - `shouldSeekToHost`: 判断观众是否需要 seek 到房主进度
 * - `isInBufferedRange`: 检查指定时间是否在 video 的缓冲范围内
 * - `isMseStream`: 判断当前源是否为 MSE 流（需要手动处理 seek 到未缓冲区域）
 */
import type { WatchTogetherState } from '../types'
import { SEEK_FOLLOW_THRESHOLD } from '../constants'

/**
 * 按播放倍速自适应的 seek 跟随阈值。
 *
 * 旧实现使用固定 0.5s 阈值，在 2x/4x 倍速下会高频 seek 导致抖动。
 * 新实现：`max(SEEK_FOLLOW_THRESHOLD, playbackRate * 0.5)`
 *   - 1x 倍速：0.5s
 *   - 2x 倍速：1.0s
 *   - 4x 倍速：2.0s
 *
 * @param playbackRate 当前播放倍速
 */
export function getAdaptiveSeekThreshold(playbackRate: number): number {
  return Math.max(SEEK_FOLLOW_THRESHOLD, playbackRate * 0.5)
}

/**
 * 判断观众是否需要 seek 到房主进度。
 *
 * 当本地进度与房主进度差距超过自适应阈值时返回 true。
 *
 * @param localTime 观众本地 video.currentTime
 * @param hostTime 房主广播的 currentTime
 * @param playbackRate 当前播放倍速（用于自适应阈值）
 */
export function shouldSeekToHost(
  localTime: number,
  hostTime: number,
  playbackRate: number
): boolean {
  const threshold = getAdaptiveSeekThreshold(playbackRate)
  return Math.abs(localTime - hostTime) > threshold
}

/**
 * 检查指定时间是否在 video 元素的缓冲范围内。
 *
 * 用于判断 seek 目标位置是否已有数据可播放：
 * - true：浏览器可直接 seek，无需重新加载
 * - false：需要重新创建 MSE 流（seek 到未缓冲区域）
 *
 * @param video video 元素
 * @param time 目标时间（秒）
 */
export function isInBufferedRange(
  video: HTMLVideoElement,
  time: number
): boolean {
  for (let i = 0; i < video.buffered.length; i++) {
    if (time >= video.buffered.start(i) && time <= video.buffered.end(i)) {
      return true
    }
  }
  return false
}

/**
 * 判断 seek 到未缓冲位置时是否需要重新加载 MSE 流。
 *
 * MSE 流的 SourceBuffer 被 pruneSourceBuffer 清理后，已播放位置的数据会被移除。
 * seek 到这些位置时浏览器无法恢复，必须重新创建 MSE 流（reload）。
 *
 * 但 seek 到**未来未缓冲区域**（buffered.end 之后）时，MSE 的 streamToSourceBuffer
 * 会基于新的 video.currentTime 继续下载，浏览器会自然等待缓冲后播放，
 * 通常几秒内即可恢复，**不需要 reload**。
 *
 * 旧实现只要 !isInBufferedRange 就触发 reload，导致 seek 到未来未缓冲区域时
 * 也重置 source 从头下载，等待数十秒。此函数修复该问题。
 *
 * @param video video 元素
 * @param time 目标时间（秒）
 * @returns true 表示需要 reload（过去已清理区域或无缓冲数据）
 */
export function needsMseReloadForSeek(
  video: HTMLVideoElement,
  time: number
): boolean {
  // 无缓冲数据：需要 reload
  if (video.buffered.length === 0) return true

  // 目标在缓冲范围内：不需要
  if (isInBufferedRange(video, time)) return false

  const bufferedStart = video.buffered.start(0)
  // 目标在第一个缓冲区间之前（过去已清理区域）：需要 reload
  if (time < bufferedStart) return true

  // 目标在最后一个缓冲区间之后（未来未缓冲区域）：
  // MSE 会基于新 currentTime 继续下载，浏览器自然等待，不需要 reload
  return false
}

/**
 * 判断当前源是否为 MSE 流（需要手动处理 seek 到未缓冲区域）。
 *
 * MSE 流（DASH / 含 audioUrl）的 SourceBuffer 会被 pruneSourceBuffer 清理，
 * seek 到已清理位置时需要重新创建流。普通 mp4 直链由浏览器原生处理。
 *
 * @param state 当前播放状态
 */
export function isMseStream(state: WatchTogetherState): boolean {
  return state.format === 'dash' || !!state.audioUrl
}

/**
 * 等待指定时间被缓冲（用于 seek 到未缓冲区域后等待数据下载）。
 *
 * 轮询检查 video.buffered，目标时间进入缓冲范围后 resolve。
 * 超时后强制 resolve（可能下载失败，避免永久卡死）。
 *
 * **修复**：旧实现超时后 checkBuffered 的递归 setTimeout 未被清理，
 * 会永久在后台轮询。新实现在 resolve 前清理所有未触发的 setTimeout。
 *
 * @param video video 元素
 * @param targetTime 目标时间（秒）
 * @param timeoutMs 超时时间（毫秒，默认 30s）
 * @param pollIntervalMs 轮询间隔（毫秒，默认 200ms）
 */
export function waitForBuffered(
  video: HTMLVideoElement,
  targetTime: number,
  timeoutMs = 30000,
  pollIntervalMs = 200
): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const finish = () => {
      if (resolved) return
      resolved = true
      if (pollTimer) clearTimeout(pollTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      resolve()
    }

    const checkBuffered = () => {
      if (resolved) return
      if (isInBufferedRange(video, targetTime)) {
        finish()
        return
      }
      pollTimer = setTimeout(checkBuffered, pollIntervalMs)
    }
    checkBuffered()

    // 超时保护：触发 finish，清理 pollTimer
    timeoutTimer = setTimeout(finish, timeoutMs)
  })
}

/**
 * 在 video.buffered 范围内找到最接近 targetTime 的位置。
 *
 * 用于 seek 到未缓冲区域超时后的降级处理：
 * 若目标位置未能缓冲，跳到最近的已缓冲位置，而不是回到开头。
 *
 * - 若 targetTime 在某个缓冲区间内，返回 targetTime
 * - 若 targetTime 在所有缓冲区间之前，返回第一个区间的 start
 * - 若 targetTime 在所有缓冲区间之后，返回最后一个区间的 end
 * - 若无缓冲数据，返回 -1
 *
 * @param video video 元素
 * @param targetTime 目标时间（秒）
 */
export function findNearestBufferedTime(
  video: HTMLVideoElement,
  targetTime: number
): number {
  if (!video.buffered.length) return -1

  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i)
    const end = video.buffered.end(i)
    if (targetTime < start) {
      // targetTime 在此区间之前
      if (i === 0) {
        // 第一个区间之前，返回第一个区间的 start
        return start
      }
      // 否则在前一个区间和此区间之间，返回前一个区间的 end（更近）
      return video.buffered.end(i - 1)
    }
    if (targetTime >= start && targetTime <= end) {
      // targetTime 在此区间内
      return targetTime
    }
  }

  // targetTime 在所有区间之后
  return video.buffered.end(video.buffered.length - 1)
}
