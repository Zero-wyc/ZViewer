/**
 * usePlaybackStateRequest Hook
 *
 * 观众加入房间或房主重连时，向服务器请求当前播放状态。
 *
 * 旧架构：emit watch-together-request-state，后端广播给房主，房主响应。
 * 新架构：emit watch-together-request-state，后端直接通过 ack 返回推算后的状态。
 *
 * 优势：
 * - 房主离线时观众仍可获取状态（从服务器持久化读取）
 * - 减少一次 socket 往返（ack vs 广播+响应）
 */
import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import type { WatchTogetherState } from '@/modules/sync-playback/types'
import { SOCKET_EVENT } from '@/modules/sync-playback/constants'
import { safePlay } from '@/modules/sync-playback/safePlay'
import type { RequestStateAckData } from '../types'

export interface UsePlaybackStateRequestOptions {
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
}

export type UsePlaybackStateRequestReturn = void

export function usePlaybackStateRequest({
  roomId,
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  applySourceToVideo,
}: UsePlaybackStateRequestOptions): UsePlaybackStateRequestReturn {
  const { socket } = useSocket()
  const requestedRef = useRef(false)

  useEffect(() => {
    if (!socket || isHostRef.current) return
    if (requestedRef.current) return
    requestedRef.current = true

    // emit 请求状态，ack 回调直接返回推算后的状态
    socket.emit(
      SOCKET_EVENT.REQUEST_STATE,
      { roomId },
      (response: {
        success: boolean
        data?: RequestStateAckData | null
        message?: string
      }) => {
        if (!response.success || !response.data?.state) {
          // 服务器无播放状态，可能房主尚未开始播放
          return
        }

        const state = response.data.state
        const video = videoRef.current
        if (!video) return

        suppressEventsRef.current = true
        setWatchTogether(state)

        void applySourceToVideo(video, state)
          .then(() => {
            const currentVideo = videoRef.current
            if (!currentVideo) return

            // 设置进度
            if (state.currentTime > 0) {
              try {
                currentVideo.currentTime = state.currentTime
              } catch {
                // ignore
              }
            }
            // 设置倍速
            if (currentVideo.playbackRate !== state.playbackRate) {
              currentVideo.playbackRate = state.playbackRate
            }
            // 播放/暂停
            if (state.isPlaying && currentVideo.paused) {
              void safePlay(currentVideo)
            } else if (!state.isPlaying && !currentVideo.paused) {
              currentVideo.pause()
            }
            suppressEventsRef.current = false
          })
          .catch((err: unknown) => {
            console.error('[usePlaybackStateRequest] 恢复状态失败:', err)
            suppressEventsRef.current = false
            message.error(err instanceof Error ? err.message : '状态恢复失败')
          })
      }
    )
  }, [
    socket,
    roomId,
    isHostRef,
    videoRef,
    suppressEventsRef,
    setWatchTogether,
    applySourceToVideo,
  ])
}
