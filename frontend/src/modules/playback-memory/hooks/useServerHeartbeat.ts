/**
 * useServerHeartbeat Hook
 *
 * 订阅服务器心跳事件（server-heartbeat）。
 *
 * 旧架构：房主每 2s 广播 host-heartbeat，房主断开后观众 6s 超时暂停。
 * 新架构：服务器每 2s 广播 server-heartbeat（仅房主离线时），观众端继续播放。
 *
 * 行为：
 * - 收到 server-heartbeat 时，更新本地状态（基于服务器推算的进度）
 * - 不再因房主离线而暂停播放
 * - 监听 host-disconnected 仅显示提示，不暂停
 * - 检测 URL 过期后暂停并提示
 */
import { useEffect, useRef, useCallback } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import type { WatchTogetherState } from '@/modules/sync-playback/types'
import { SOCKET_EVENT } from '@/modules/sync-playback/constants'
import { safePlay } from '@/modules/sync-playback/safePlay'
import { shouldSeekToHost } from '@/modules/sync-playback/services'
import type { ServerHeartbeatPayload } from '../types'
import { isVideoSourceExpired } from '../services/url-expiry'

export interface UseServerHeartbeatOptions {
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
  /** 当前播放状态（用于 URL 过期检测） */
  watchTogether: WatchTogetherState
}

export type UseServerHeartbeatReturn = void

export function useServerHeartbeat({
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  watchTogether,
}: UseServerHeartbeatOptions): UseServerHeartbeatReturn {
  const { socket } = useSocket()
  // 防止重复提示"房主已离开"
  const hostLeftNotifiedRef = useRef(false)
  // URL 过期状态标记
  const urlExpiredRef = useRef(false)
  // 缓存最新的 watchTogether 供 callback 读取
  const watchTogetherRef = useRef(watchTogether)
  watchTogetherRef.current = watchTogether

  // 处理服务器心跳：更新本地状态
  const handleServerHeartbeat = useCallback(
    (payload: ServerHeartbeatPayload) => {
      const state = payload.state
      suppressEventsRef.current = true
      setWatchTogether(state)

      const video = videoRef.current
      if (!video) {
        suppressEventsRef.current = false
        return
      }

      // URL 过期后不再应用状态（等待房主重连）
      if (urlExpiredRef.current) {
        suppressEventsRef.current = false
        return
      }

      // 检测 URL 过期
      if (isVideoSourceExpired(state.sourceUrl, video.error)) {
        urlExpiredRef.current = true
        if (!video.paused) video.pause()
        message.warning('视频源已过期，等待房主重连')
        suppressEventsRef.current = false
        return
      }

      // 自适应 seek 跟随
      if (
        shouldSeekToHost(
          video.currentTime,
          state.currentTime,
          state.playbackRate
        )
      ) {
        try {
          video.currentTime = state.currentTime
        } catch {
          // ignore
        }
      }

      // 同步播放/暂停状态
      if (state.isPlaying && video.paused) {
        void safePlay(video)
      } else if (!state.isPlaying && !video.paused) {
        video.pause()
      }

      // 同步倍速
      if (video.playbackRate !== state.playbackRate) {
        video.playbackRate = state.playbackRate
      }

      suppressEventsRef.current = false
    },
    [videoRef, suppressEventsRef, setWatchTogether]
  )

  // 订阅服务器心跳
  useEffect(() => {
    if (!socket || isHostRef.current) return

    socket.on(SOCKET_EVENT.SERVER_HEARTBEAT, handleServerHeartbeat)

    return () => {
      socket.off(SOCKET_EVENT.SERVER_HEARTBEAT, handleServerHeartbeat)
    }
  }, [socket, isHostRef, handleServerHeartbeat])

  // 监听 host-disconnected：仅提示，不暂停播放
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleHostDisconnected = () => {
      if (hostLeftNotifiedRef.current) return
      hostLeftNotifiedRef.current = true
      // 仅提示，不暂停播放（服务器继续广播 server-heartbeat）
      message.info('房主已离开，服务器继续维持播放')
    }

    // 房主重连时重置提示标记（通过 sharer-ready 事件判断）
    const handleHostReconnect = () => {
      hostLeftNotifiedRef.current = false
      urlExpiredRef.current = false
    }

    socket.on(SOCKET_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
    socket.on('sharer-ready', handleHostReconnect)

    return () => {
      socket.off(SOCKET_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
      socket.off('sharer-ready', handleHostReconnect)
    }
  }, [socket, isHostRef])

  // 监听 video error 事件（URL 过期兜底检测）
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleError = () => {
      if (urlExpiredRef.current) return
      const currentState = watchTogetherRef.current
      if (isVideoSourceExpired(currentState.sourceUrl, video.error)) {
        urlExpiredRef.current = true
        if (!video.paused) video.pause()
        message.warning('视频源已过期，等待房主重连')
      }
    }

    video.addEventListener('error', handleError)
    return () => {
      video.removeEventListener('error', handleError)
    }
  }, [videoRef])
}
