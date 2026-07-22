/**
 * MSE 流重新加载服务。
 *
 * 当 seek 到 SourceBuffer 中已清理的位置时，MSE 无法自动重新下载已清理的数据。
 * 此时需要重置 appliedSourceUrlRef，调用 applySourceToVideo 重新创建 MSE 流，
 * 等待数据下载到目标位置后再 seek。
 *
 * 限制：MSE 必须从 init segment 开始 append，因此会从头下载。
 * 下载到目标位置的时间取决于网络速度与目标位置距开头的距离。
 *
 * **关键优化**：
 * 1. applySourceToVideo 后立即设置 video.currentTime = targetTime
 *    - 让 MSE 缓冲前瞻量调控基于 targetTime 计算（而非 0）
 *    - 避免下载到 60s 时因 bufferedAhead > 60 而暂停下载（导致永远到不了 targetTime）
 * 2. 超时后跳到最近的已缓冲位置（而非回到开头）
 * 3. 使用 AbortSignal 在取消时立即终止等待
 */
import type { MutableRefObject } from 'react'
import type { WatchTogetherState } from '../types'
import { safePlay } from '../safePlay'
import {
  isInBufferedRange,
  isMseStream,
  waitForBuffered,
  findNearestBufferedTime,
} from './seek-strategy'

export interface ReloadMseAtTimeOptions {
  video: HTMLVideoElement
  /** 目标播放位置（秒） */
  targetTime: number
  /** 当前播放状态（用于获取 sourceUrl/audioUrl 等） */
  state: WatchTogetherState
  /** 应用视频源到 video 元素的函数（可选 startTime 用于 seek 模式加速加载） */
  applySourceToVideo: (
    video: HTMLVideoElement,
    state: WatchTogetherState,
    startTime?: number
  ) => Promise<void>
  /** 已应用 sourceUrl 的 ref，重置后允许重新加载同一源 */
  appliedSourceUrlRef: MutableRefObject<string | null>
  /** 事件抑制 ref，加载期间设为 true 防止连锁触发 */
  suppressEventsRef: MutableRefObject<boolean>
  /** 超时时间（毫秒），默认 30s（seek 模式从目标位置附近加载，通常几秒内完成） */
  timeoutMs?: number
}

export interface ReloadMseAtTimeResult {
  /** true 表示成功加载并 seek 到目标位置；false 表示超时或失败 */
  success: boolean
  /** 超时或失败时的错误信息（用于 UI 提示） */
  message?: string
}

/**
 * 重新加载 MSE 流并 seek 到目标时间。
 *
 * 流程：
 * 1. 重置 appliedSourceUrlRef，允许 attachSource 重新加载同一源
 * 2. 设置 suppressEventsRef = true，防止加载过程中连锁触发 seeking 事件
 * 3. 调用 applySourceToVideo 重新创建 MSE 流（从头下载）
 * 4. **立即设置 video.currentTime = targetTime**
 *    - 让 MSE 缓冲前瞻量调控基于 targetTime 计算
 *    - video 进入 seeking 状态，等待目标位置缓冲
 * 5. 轮询等待目标位置被缓冲
 * 6. 成功：恢复播放（currentTime 已在目标位置）
 * 7. 超时：跳到最近的已缓冲位置（而非回到开头）
 *
 * 调用方负责维护 isReloading 锁，防止并发调用。
 */
export async function reloadMseAtTime(
  options: ReloadMseAtTimeOptions
): Promise<ReloadMseAtTimeResult> {
  const {
    video,
    targetTime,
    state,
    applySourceToVideo,
    appliedSourceUrlRef,
    suppressEventsRef,
    timeoutMs = 30000,
  } = options

  if (!isMseStream(state) || !state.sourceUrl) {
    return { success: false, message: '非 MSE 流，无需重新加载' }
  }
  if (isInBufferedRange(video, targetTime)) {
    // 目标位置已缓冲，直接 seek
    try {
      video.currentTime = targetTime
    } catch {
      // ignore
    }
    return { success: true }
  }

  const wasPlaying = !video.paused

  // 重置 appliedSourceUrlRef，允许 attachSource 重新加载同一源
  appliedSourceUrlRef.current = null
  suppressEventsRef.current = true

  try {
    // 传入 targetTime 作为 startTime，让 MSE 引擎通过 Range 请求从目标位置附近开始下载，
    // 而非从头下载整个文件。引擎内部会先下载 init segment，再估算字节偏移定位分片。
    await applySourceToVideo(video, state, targetTime)

    // 关键优化：立即设置 currentTime = targetTime
    // 1. 让 MSE streamToSourceBuffer 的缓冲前瞻量调控基于 targetTime 计算
    //    避免 video.currentTime=0 时下载到 60s 就暂停（bufferedAhead=60 > 60）
    // 2. video 进入 seeking 状态，用户看到 loading 指示
    // 3. 下载到 targetTime 附近后 video 自动恢复播放
    try {
      video.currentTime = targetTime
    } catch {
      // ignore - 某些浏览器在 MSE 刚 attach 时设置 currentTime 可能抛错
    }

    // 等待目标位置缓冲
    await waitForBuffered(video, targetTime, timeoutMs)

    // 检查目标位置是否已缓冲
    if (isInBufferedRange(video, targetTime)) {
      // 目标位置已缓冲，currentTime 已在目标位置（之前设置过）
      // 确保 currentTime 精确指向 targetTime（等待期间可能被浏览器调整）
      try {
        video.currentTime = targetTime
      } catch {
        // ignore
      }
      if (wasPlaying) {
        void safePlay(video)
      }
      return { success: true }
    }

    // 超时：目标位置仍未缓冲
    // 降级：跳到最近的已缓冲位置，而不是回到开头
    const nearestTime = findNearestBufferedTime(video, targetTime)
    if (nearestTime >= 0) {
      try {
        video.currentTime = nearestTime
      } catch {
        // ignore
      }
      if (wasPlaying) {
        void safePlay(video)
      }
      return {
        success: false,
        message:
          nearestTime === 0
            ? '加载目标位置超时，已从开头播放'
            : `加载目标位置超时，已跳到 ${Math.floor(nearestTime)}秒`,
      }
    }

    // 完全没有缓冲数据
    if (wasPlaying) {
      void safePlay(video)
    }
    return {
      success: false,
      message: '加载目标位置超时，请检查网络后重试',
    }
  } catch (err) {
    console.error('[reloadMseAtTime] 重新加载失败:', err)
    // 加载失败时恢复播放状态，避免卡在暂停
    if (wasPlaying) {
      void safePlay(video)
    }
    return {
      success: false,
      message: err instanceof Error ? err.message : '重新加载失败',
    }
  } finally {
    suppressEventsRef.current = false
  }
}
