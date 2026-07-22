/**
 * usePlayerControls Hook
 *
 * 提供视频元素的播放控制 API：play / pause / seek / setRate / togglePlay。
 *
 * - play 使用 safePlay 处理浏览器自动播放策略（首次失败时自动静音重试）
 * - 所有方法内部检查 videoRef.current 是否存在，避免空指针
 * - 不包含任何同步逻辑：仅做本地 video 元素操作
 *   同步广播由调用方（sync-playback/useVideoEventBindings）通过事件监听处理
 */
import { useCallback } from 'react'
import type { RefObject } from 'react'
import { safePlay } from '@/modules/sync-playback/safePlay'

export interface UsePlayerControlsOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  /** 自动播放策略触发强制静音时的回调，UI 层可据此更新静音按钮状态 */
  onAutoMuted?: () => void
}

export interface UsePlayerControlsReturn {
  /** 安全播放：处理自动播放策略，失败时自动静音重试 */
  play: () => Promise<void>
  /** 暂停视频 */
  pause: () => void
  /** 跳转到指定时间（秒） */
  seek: (time: number) => void
  /** 设置播放倍速 */
  setRate: (rate: number) => void
  /** 切换播放/暂停状态 */
  togglePlay: () => void
  /** 获取当前播放时间 */
  getCurrentTime: () => number
  /** 获取视频时长 */
  getDuration: () => number
  /** 获取是否暂停 */
  isPaused: () => boolean
}

export function usePlayerControls({
  videoRef,
  onAutoMuted,
}: UsePlayerControlsOptions): UsePlayerControlsReturn {
  const play = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    await safePlay(video, { onAutoMuted })
  }, [videoRef, onAutoMuted])

  const pause = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.pause()
  }, [videoRef])

  const seek = useCallback(
    (time: number) => {
      const video = videoRef.current
      if (!video) return
      try {
        video.currentTime = time
      } catch {
        // ignore: 某些情况下（如未加载 metadata）设置 currentTime 会抛错
      }
    },
    [videoRef]
  )

  const setRate = useCallback(
    (rate: number) => {
      const video = videoRef.current
      if (!video) return
      video.playbackRate = rate
    },
    [videoRef]
  )

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void safePlay(video, { onAutoMuted })
    } else {
      video.pause()
    }
  }, [videoRef, onAutoMuted])

  const getCurrentTime = useCallback(() => {
    return videoRef.current?.currentTime ?? 0
  }, [videoRef])

  const getDuration = useCallback(() => {
    return videoRef.current?.duration ?? 0
  }, [videoRef])

  const isPaused = useCallback(() => {
    return videoRef.current?.paused ?? true
  }, [videoRef])

  return {
    play,
    pause,
    seek,
    setRate,
    togglePlay,
    getCurrentTime,
    getDuration,
    isPaused,
  }
}
