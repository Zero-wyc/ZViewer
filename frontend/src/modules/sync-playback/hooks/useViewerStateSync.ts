import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import type { WatchTogetherState, StatePayload, ControlPayload } from '../types'
import { SOCKET_EVENT, SEEK_FOLLOW_THRESHOLD } from '../constants'
import { safePlay } from '../safePlay'

export interface UseViewerStateSyncOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
  applySourceToVideo: (
    video: HTMLVideoElement,
    state: WatchTogetherState
  ) => Promise<void>
}

export type UseViewerStateSyncReturn = void

/**
 * 观众状态同步 Hook：接收房主的 `watch-together-state` 与 `watch-together-control` 事件，
 * 并应用到本地 video 元素。
 *
 * 关键设计：
 *
 * 1. **串行化 applySourceToVideo（Bug #8 修复）**：
 *    房主每 500ms 广播 state，若 sourceUrl 变化（切清晰度/切影片），
 *    两个 applySourceToVideo 会并发：后者的 resetVideoElement abort 前者 MSE attach，
 *    前者 .then() 用旧 state.currentTime 写入新 video.src，导致状态错乱。
 *    用 isApplyingRef 锁 + pendingStateRef 缓存最新 state，串行处理。
 *
 * 2. **自适应 seek 跟随阈值**：
 *    旧实现使用固定 0.5s 阈值，在 2x/4x 倍速下会高频 seek 导致抖动。
 *    新实现按播放倍速自适应：`max(0.5, playbackRate * 0.5)`，
 *    2x 倍速下阈值变为 1s，4x 倍速下变为 2s。
 *
 * 3. **加入房间时主动请求初始状态**：
 *    观众挂载该 Hook 后立即 emit `watch-together-request-state`，
 *    房主通过 useHostStateRequest 响应。
 */
export function useViewerStateSync({
  roomId,
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  applySourceToVideo,
}: UseViewerStateSyncOptions): UseViewerStateSyncReturn {
  const { socket } = useSocket()

  // Bug #8 修复：handleState 串行化处理
  const isApplyingRef = useRef(false)
  const pendingStateRef = useRef<WatchTogetherState | null>(null)

  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleState = (payload: StatePayload) => {
      const state = payload.state
      suppressEventsRef.current = true
      setWatchTogether(state)

      // 串行化 applySourceToVideo：若上一次 apply 还在进行中，
      // 仅缓存最新 state，等上一次完成后处理最新值。
      pendingStateRef.current = state
      if (isApplyingRef.current) return

      const processState = async (s: WatchTogetherState) => {
        isApplyingRef.current = true
        const video = videoRef.current
        if (!video) {
          isApplyingRef.current = false
          pendingStateRef.current = null
          suppressEventsRef.current = false
          return
        }

        try {
          // 先应用源（若 sourceUrl 未变则直接返回，不会重置视频），
          // 再设置进度/播放状态，避免在 MSE attach 完成前设置 currentTime 无效。
          await applySourceToVideo(video, s)

          // 异步期间 video 元素可能已被卸载或替换，重新获取最新引用
          const currentVideo = videoRef.current
          if (!currentVideo) {
            return
          }

          // 自适应 seek 跟随阈值：高倍速下放大阈值避免高频 seek 抖动
          const adaptiveThreshold = Math.max(
            SEEK_FOLLOW_THRESHOLD,
            s.playbackRate * 0.5
          )
          if (
            Math.abs(currentVideo.currentTime - s.currentTime) >
            adaptiveThreshold
          ) {
            currentVideo.currentTime = s.currentTime
          }
          if (currentVideo.playbackRate !== s.playbackRate) {
            currentVideo.playbackRate = s.playbackRate
          }
          if (s.isPlaying && currentVideo.paused) {
            // 观众端进入房间时通常无用户交互，浏览器自动播放策略会阻止 play()，
            // 需要自动静音重试；否则会出现"进度条动但黑屏"的现象。
            void safePlay(currentVideo)
          } else if (!s.isPlaying && !currentVideo.paused) {
            currentVideo.pause()
          }
        } catch (err: unknown) {
          console.error('[useViewerStateSync] applySourceToVideo failed:', err)
          // 向观众展示错误（如不支持的视频格式），避免黑屏无反馈
          message.error(err instanceof Error ? err.message : '视频源加载失败')
        } finally {
          isApplyingRef.current = false
        }
      }

      const drain = async () => {
        // 持续消费 pendingStateRef，直到清空
        while (pendingStateRef.current) {
          const next = pendingStateRef.current
          pendingStateRef.current = null
          await processState(next)
        }
        suppressEventsRef.current = false
      }

      void drain()
    }

    const handleControl = (payload: ControlPayload) => {
      const video = videoRef.current
      if (!video) return
      suppressEventsRef.current = true
      switch (payload.action) {
        case 'play':
          void safePlay(video)
          break
        case 'pause':
          video.pause()
          break
        case 'seek':
          if (typeof payload.value === 'number') {
            video.currentTime = payload.value
          }
          break
        case 'rate':
          if (typeof payload.value === 'number') {
            video.playbackRate = payload.value
          }
          break
      }
      suppressEventsRef.current = false
    }

    socket.on(SOCKET_EVENT.STATE, handleState)
    socket.on(SOCKET_EVENT.CONTROL, handleControl)

    // 刚加入时请求当前状态
    socket.emit(SOCKET_EVENT.REQUEST_STATE, { roomId })

    return () => {
      socket.off(SOCKET_EVENT.STATE, handleState)
      socket.off(SOCKET_EVENT.CONTROL, handleControl)
    }
  }, [
    socket,
    roomId,
    videoRef,
    setWatchTogether,
    applySourceToVideo,
    suppressEventsRef,
    isHostRef,
  ])
}
