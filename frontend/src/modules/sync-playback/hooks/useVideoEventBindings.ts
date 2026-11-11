import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState, ControlAction } from '../types'
import { SEEK_DEBOUNCE_MS, PLAY_PAUSE_DEBOUNCE_MS } from '../constants'
import { buildStateFromVideo } from '../services'

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
 * v3 重构（解决观众端频繁卡顿）：
 *
 * 1. **timeupdate 不再触发广播**：
 *    旧实现每 500ms 节流广播一次完整 state，观众端每秒收到 2 次完整状态，
 *    每次都设置 currentTime 导致视频频繁卡顿。
 *    新实现 timeupdate 仅更新本地 store 的 currentTime 字段（用于 UI 显示），
 *    不触发 broadcastState。观众端进度由离散事件 + 定时心跳驱动。
 *
 * 2. **离散事件立即广播**：
 *    play/pause/seeked/ratechange 事件立即通过 sendControl 发送控制指令，
 *    并通过 broadcastState 广播完整状态（forceBroadcast=true 跳过节流）。
 *    观众端通过 control 事件获得亚秒级响应。
 *
 * 3. **定时心跳广播**：
 *    useHostHeartbeat 每 5s 广播一次完整 state（含 currentTime），
 *    观众端据此校正小幅进度漂移（仅差异 > 3s 才 seek）。
 *
 * 4. **seek 事件防抖（SEEK_DEBOUNCE_MS=300ms）**：避免拖动进度条时频繁广播。
 *
 * 5. **updateState 通过 useRoomStore.getState() 读取最新源字段**，
 *    不依赖闭包变量，避免 re-render 导致事件监听器频繁解绑/重新绑定。
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
  const playPauseDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  useEffect(() => {
    const video = videoRef.current
    if (!video || !isHostRef.current) return

    /**
     * 构建当前状态并广播（离散事件专用，forceBroadcast=true 跳过节流）。
     * updateStore=true 时同时更新 roomStore（用于 UI 同步）。
     *
     * 使用 buildStateFromVideo 构建完整 state，确保包含所有字段（bufferMode / headers /
     * isPreview / previewTitle 等）。旧实现手写 state 时遗漏了这些字段，导致观众端收到
     * bufferMode=undefined 的 state 后跳过缓冲下载，直接走 CDN URL 流式播放，
     * 破坏缓冲模式一致性。
     */
    const updateAndBroadcast = (updateStore = true) => {
      if (suppressEventsRef.current) return
      const current = useRoomStore.getState().watchTogether
      const state = buildStateFromVideo(video, current)
      if (updateStore) {
        setWatchTogether(state)
      }
      // 离散事件总是强制广播，跳过节流
      broadcastState(state)
    }

    const handlePlay = () => {
      if (suppressEventsRef.current) return
      if (playPauseDebounceRef.current) {
        clearTimeout(playPauseDebounceRef.current)
      }
      playPauseDebounceRef.current = setTimeout(() => {
        sendControl('play')
        updateAndBroadcast(true)
      }, PLAY_PAUSE_DEBOUNCE_MS)
    }
    const handlePause = () => {
      if (suppressEventsRef.current) return
      if (playPauseDebounceRef.current) {
        clearTimeout(playPauseDebounceRef.current)
      }
      playPauseDebounceRef.current = setTimeout(() => {
        sendControl('pause')
        updateAndBroadcast(true)
      }, PLAY_PAUSE_DEBOUNCE_MS)
    }
    const handleSeeked = () => {
      if (suppressEventsRef.current) return
      // 直播源没有可对齐的进度：seek 只影响本机缓冲，广播给观众毫无意义
      //（观众收到 seek 会在自己的直播时间轴上跳，副作用只有卡顿）。
      if (useRoomStore.getState().watchTogether.isLive === true) return
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current)
      }
      seekDebounceRef.current = setTimeout(() => {
        sendControl('seek', video.currentTime)
        updateAndBroadcast(true)
      }, SEEK_DEBOUNCE_MS)
    }
    const handleRateChange = () => {
      if (suppressEventsRef.current) return
      if (useRoomStore.getState().watchTogether.isLive === true) return
      sendControl('rate', video.playbackRate)
      updateAndBroadcast(true)
    }
    /**
     * timeupdate 仅更新本地 store 的 currentTime（用于 UI 进度条显示），
     * 不触发广播。观众端进度同步由：
     * - 离散事件（play/pause/seek/rate）即时响应
     * - 定时心跳（useHostHeartbeat 每 5s）周期校正
     * 驱动，避免高频广播导致观众端卡顿。
     */
    const handleTimeUpdate = () => {
      if (suppressEventsRef.current) return
      // 仅更新 store 的 currentTime 字段，不触发广播
      // 使用 partial update 避免 setWatchTogether 触发引用变化导致订阅组件 re-render
      const current = useRoomStore.getState().watchTogether
      // 仅当差异 > 0.1s 才更新，避免无意义的 store 写入
      if (Math.abs(current.currentTime - video.currentTime) > 0.1) {
        setWatchTogether({
          ...current,
          currentTime: video.currentTime,
          isPlaying: !video.paused,
        })
      }
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
      if (playPauseDebounceRef.current) {
        clearTimeout(playPauseDebounceRef.current)
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
