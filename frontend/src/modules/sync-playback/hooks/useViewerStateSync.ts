import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState, StatePayload, ControlPayload } from '../types'
import { SOCKET_EVENT } from '../constants'
import { safePlay } from '../safePlay'
import {
  shouldSeekToHost,
  needsMseReloadForSeek,
  isMseStream,
  reloadMseAtTime,
} from '../services'

export interface UseViewerStateSyncOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
  applySourceToVideo: (
    video: HTMLVideoElement,
    state: WatchTogetherState,
    startTime?: number
  ) => Promise<void>
  /** 已应用 sourceUrl 的 ref，seek 到未缓冲区域时重置以允许重新加载 */
  appliedSourceUrlRef: MutableRefObject<string | null>
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
 *    使用 `shouldSeekToHost` 服务函数按播放倍速自适应判断是否需要 seek，
 *    避免高倍速下高频 seek 抖动。
 *
 * 3. **seek 到未缓冲区域的重新加载**：
 *    观众端跟随房主 seek 时，若目标位置不在缓冲范围内且为 MSE 流，
 *    调用 reloadMseAtTime 重新创建 MSE 流。用 isReloadingRef 锁防止并发。
 *
 * 4. **初始状态请求由 usePlaybackStateRequest 负责**：
 *    该 Hook 仅处理实时 state/control 事件，加入房间时的初始状态请求
 *    由 usePlaybackStateRequest 通过 ack 直接从服务器获取推算后的状态。
 */
export function useViewerStateSync({
  roomId,
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  applySourceToVideo,
  appliedSourceUrlRef,
}: UseViewerStateSyncOptions): UseViewerStateSyncReturn {
  const { socket } = useSocket()

  // Bug #8 修复：handleState 串行化处理
  const isApplyingRef = useRef(false)
  const pendingStateRef = useRef<WatchTogetherState | null>(null)
  // seek 重新加载锁：防止 reloadMseAtTime 期间重复触发
  const isReloadingRef = useRef(false)

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

          // 自适应 seek 跟随：使用 shouldSeekToHost 服务函数判断是否需要 seek
          if (
            shouldSeekToHost(
              currentVideo.currentTime,
              s.currentTime,
              s.playbackRate
            )
          ) {
            // 仅 seek 到过去已清理区域才需要 reload；
            // 未来未缓冲区域 MSE 会继续下载，浏览器自然等待
            if (
              !isReloadingRef.current &&
              needsMseReloadForSeek(currentVideo, s.currentTime) &&
              isMseStream(s) &&
              s.sourceUrl
            ) {
              isReloadingRef.current = true
              useRoomStore.getState().setReloadingState(true, s.currentTime)
              void reloadMseAtTime({
                video: currentVideo,
                targetTime: s.currentTime,
                state: s,
                applySourceToVideo,
                appliedSourceUrlRef,
                suppressEventsRef,
              })
                .then((result) => {
                  if (!result.success && result.message) {
                    message.warning(result.message)
                  }
                })
                .finally(() => {
                  isReloadingRef.current = false
                  useRoomStore.getState().setReloadingState(false, null)
                })
            }
          } else {
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

      // seek 到未缓冲区域：交给 reloadMseAtTime 处理（内部管理 suppressEventsRef）
      if (
        payload.action === 'seek' &&
        typeof payload.value === 'number' &&
        !isReloadingRef.current
      ) {
        const targetTime = payload.value
        const state = useRoomStore.getState().watchTogether
        if (
          needsMseReloadForSeek(video, targetTime) &&
          isMseStream(state) &&
          state.sourceUrl
        ) {
          isReloadingRef.current = true
          useRoomStore.getState().setReloadingState(true, targetTime)
          void reloadMseAtTime({
            video,
            targetTime,
            state,
            applySourceToVideo,
            appliedSourceUrlRef,
            suppressEventsRef,
          })
            .then((result) => {
              if (!result.success && result.message) {
                message.warning(result.message)
              }
            })
            .finally(() => {
              isReloadingRef.current = false
              useRoomStore.getState().setReloadingState(false, null)
            })
          return
        }
      }

      // 普通控制：使用 suppressEventsRef 包围，防止本地事件回环
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

    // 初始状态请求由 usePlaybackStateRequest 通过 ack 直接获取（不在此处重复 emit）

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
    appliedSourceUrlRef,
  ])
}
