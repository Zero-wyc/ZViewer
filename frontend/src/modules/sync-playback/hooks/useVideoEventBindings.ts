import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState, ControlAction } from '../types'
import { BROADCAST_THROTTLE_MS, SEEK_DEBOUNCE_MS } from '../constants'

export interface UseVideoEventBindingsOptions {
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
  broadcastState: (state: WatchTogetherState) => void
  sendControl: (action: ControlAction, value?: number) => void
}

export type UseVideoEventBindingsReturn = void

/**
 * 房主 video 元素事件绑定 Hook：监听 play/pause/seeked/ratechange/timeupdate，
 * 在房主操作时广播状态与控制指令给观众。
 *
 * 性能要点：
 *
 * 1. **updateState 内部通过 useRoomStore.getState() 读取最新 watchTogether 源字段**，
 *    不依赖闭包变量，避免 setWatchTogether 触发组件 re-render 后 effect 依赖变化
 *    导致事件监听器频繁解绑/重新绑定（拖动进度条时严重卡顿）。
 *
 * 2. **timeupdate 频率高（~250ms），不每次都 setWatchTogether 更新 store**，
 *    仅做节流广播。store 中的 currentTime 在 play/pause/seeked/ratechange 等
 *    离散事件时更新即可，UI 上的实时进度由 useVideoControls 直接读取 video 元素。
 *
 * 3. **seek 事件防抖（SEEK_DEBOUNCE_MS=200ms）**：避免拖动进度条时频繁广播。
 *
 * 4. **timeupdate 节流（BROADCAST_THROTTLE_MS=500ms）**：仅当距离上次广播
 *    超过 500ms 时才触发新广播；forceBroadcast=true 时跳过节流（用于离散事件）。
 */
export function useVideoEventBindings({
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  broadcastState,
  sendControl,
}: UseVideoEventBindingsOptions): UseVideoEventBindingsReturn {
  const seekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastBroadcastTimeRef = useRef(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !isHostRef.current) return

    const updateState = (forceBroadcast = false, updateStore = true) => {
      if (suppressEventsRef.current) return
      const current = useRoomStore.getState().watchTogether
      const state: WatchTogetherState = {
        sourceUrl: current.sourceUrl,
        sourceType: current.sourceType,
        audioUrl: current.audioUrl,
        format: current.format,
        videoCodec: current.videoCodec,
        audioCodec: current.audioCodec,
        cid: current.cid,
        isPlaying: !video.paused,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
        duration: video.duration || current.duration,
        currentQn: current.currentQn,
        acceptQuality: current.acceptQuality,
      }
      if (updateStore) {
        setWatchTogether(state)
      }
      const now = Date.now()
      if (
        forceBroadcast ||
        now - lastBroadcastTimeRef.current > BROADCAST_THROTTLE_MS
      ) {
        broadcastState(state)
        lastBroadcastTimeRef.current = now
      }
    }

    const handlePlay = () => {
      if (suppressEventsRef.current) return
      sendControl('play')
      updateState(true)
    }
    const handlePause = () => {
      if (suppressEventsRef.current) return
      sendControl('pause')
      updateState(true)
    }
    const handleSeeked = () => {
      if (suppressEventsRef.current) return
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current)
      }
      seekDebounceRef.current = setTimeout(() => {
        sendControl('seek', video.currentTime)
        updateState(true)
      }, SEEK_DEBOUNCE_MS)
    }
    const handleRateChange = () => {
      if (suppressEventsRef.current) return
      sendControl('rate', video.playbackRate)
      updateState(true)
    }
    const handleTimeUpdate = () => {
      if (suppressEventsRef.current) return
      // timeupdate 频率高，只做节流广播，不更新 store
      // 避免 roomStore watchTogether 引用频繁变化触发订阅组件 re-render
      updateState(false, false)
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('ratechange', handleRateChange)
    video.addEventListener('timeupdate', handleTimeUpdate)

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('ratechange', handleRateChange)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current)
      }
    }
  }, [
    videoRef,
    broadcastState,
    sendControl,
    setWatchTogether,
    suppressEventsRef,
    isHostRef,
  ])
}
