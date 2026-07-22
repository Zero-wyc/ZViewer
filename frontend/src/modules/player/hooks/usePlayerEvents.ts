/**
 * usePlayerEvents Hook
 *
 * 订阅 video 元素的媒体事件，通过回调通知调用方。
 *
 * 该 Hook 是引擎无关的通用事件订阅层：
 * - 不关心是房主还是观众
 * - 不包含广播逻辑（由 sync-playback/useVideoEventBindings 在此基础上扩展）
 * - 所有回调可选，未提供的回调不会注册监听器
 *
 * 性能要点：
 * - 使用稳定的回调引用：调用方应使用 useCallback 包裹回调
 * - effect 依赖仅 videoRef，避免回调变化导致频繁解绑/重绑
 *   （回调通过 ref 读取最新值，不进入 effect 依赖）
 */
import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

export interface UsePlayerEventsOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  /** 是否暂停事件分发（如加载新源时） */
  suppressRef?: RefObject<boolean>
  onPlay?: () => void
  onPause?: () => void
  onSeeking?: () => void
  onSeeked?: () => void
  onRateChange?: () => void
  onTimeUpdate?: () => void
  onLoadedMetadata?: () => void
  onDurationChange?: () => void
  onWaiting?: () => void
  onPlaying?: () => void
  onEnded?: () => void
  onError?: (e: Event) => void
  onVolumeChange?: () => void
  onProgress?: () => void
}

export type UsePlayerEventsReturn = void

export function usePlayerEvents({
  videoRef,
  suppressRef,
  onPlay,
  onPause,
  onSeeking,
  onSeeked,
  onRateChange,
  onTimeUpdate,
  onLoadedMetadata,
  onDurationChange,
  onWaiting,
  onPlaying,
  onEnded,
  onError,
  onVolumeChange,
  onProgress,
}: UsePlayerEventsOptions): UsePlayerEventsReturn {
  // 使用 ref 存储回调，避免回调变化导致 effect 重新绑定监听器。
  // 拖动进度条时 timeupdate 频繁触发，如果回调每次都进入 effect 依赖
  // 会导致严重卡顿。
  const callbacksRef = useRef({
    onPlay,
    onPause,
    onSeeking,
    onSeeked,
    onRateChange,
    onTimeUpdate,
    onLoadedMetadata,
    onDurationChange,
    onWaiting,
    onPlaying,
    onEnded,
    onError,
    onVolumeChange,
    onProgress,
  })
  callbacksRef.current = {
    onPlay,
    onPause,
    onSeeking,
    onSeeked,
    onRateChange,
    onTimeUpdate,
    onLoadedMetadata,
    onDurationChange,
    onWaiting,
    onPlaying,
    onEnded,
    onError,
    onVolumeChange,
    onProgress,
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const shouldSuppress = () => suppressRef?.current === true

    const handlers: Array<[keyof HTMLVideoElementEventMap, () => void]> = []

    const wrap = <K extends keyof HTMLVideoElementEventMap>(
      type: K,
      cb: (() => void) | undefined
    ) => {
      if (!cb) return
      const handler = () => {
        if (shouldSuppress()) return
        cb()
      }
      video.addEventListener(type, handler as EventListener)
      handlers.push([type, handler as () => void])
    }

    const wrapEvent = <K extends keyof HTMLVideoElementEventMap>(
      type: K,
      cb: ((e: Event) => void) | undefined
    ) => {
      if (!cb) return
      const handler = (e: Event) => {
        if (shouldSuppress()) return
        cb(e)
      }
      video.addEventListener(type, handler as EventListener)
      handlers.push([type, handler as () => void])
    }

    wrap('play', callbacksRef.current.onPlay)
    wrap('pause', callbacksRef.current.onPause)
    wrap('seeking', callbacksRef.current.onSeeking)
    wrap('seeked', callbacksRef.current.onSeeked)
    wrap('ratechange', callbacksRef.current.onRateChange)
    wrap('timeupdate', callbacksRef.current.onTimeUpdate)
    wrap('loadedmetadata', callbacksRef.current.onLoadedMetadata)
    wrap('durationchange', callbacksRef.current.onDurationChange)
    wrap('waiting', callbacksRef.current.onWaiting)
    wrap('playing', callbacksRef.current.onPlaying)
    wrap('ended', callbacksRef.current.onEnded)
    wrap('volumechange', callbacksRef.current.onVolumeChange)
    wrap('progress', callbacksRef.current.onProgress)
    wrapEvent('error', callbacksRef.current.onError)

    return () => {
      for (const [type, handler] of handlers) {
        video.removeEventListener(
          type as keyof HTMLVideoElementEventMap,
          handler as EventListener
        )
      }
    }
  }, [videoRef, suppressRef])
}
