import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import type { HeartbeatPayload } from '../types'
import { SOCKET_EVENT, HEARTBEAT_TIMEOUT_MS } from '../constants'

export interface UseViewerHeartbeatOptions {
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
}

export type UseViewerHeartbeatReturn = void

/**
 * 观众心跳检测 Hook：监听房主 `host-heartbeat` 事件，
 * 若 `HEARTBEAT_TIMEOUT_MS`（默认 6s）内未收到心跳则判定房主已离线。
 *
 * 同时监听 `host-disconnected` 事件（后端在房主 socket 断开时广播），
 * 立即暂停本地播放并提示用户。
 *
 * **修复说明**：旧实现前端 emit `host-heartbeat` 但后端无转发 handler，
 * 导致观众端永远收不到心跳，6s 后必然误报"房主已离线"。
 * 新增后端 handler 后该功能恢复正常。
 *
 * 心跳的额外用途：房主心跳携带 isPlaying=false 时，静默暂停观众端
 * （用于容错同步，实际同步走 state/control 事件）。
 */
export function useViewerHeartbeat({
  isHostRef,
  videoRef,
}: UseViewerHeartbeatOptions): UseViewerHeartbeatReturn {
  const { socket } = useSocket()

  // 观众端记录最近一次心跳时间，用于离线检测
  // 初始化为 0，在 effect 中设置实际值（避免在 render 中调用 Date.now()）
  const lastHeartbeatRef = useRef<number>(0)
  // 防止观众端重复提示「房主已离线」
  const hostOfflineNotifiedRef = useRef(false)

  useEffect(() => {
    if (!socket || isHostRef.current) return

    // 进入房间时给房主 6s 宽限期
    lastHeartbeatRef.current = Date.now()
    hostOfflineNotifiedRef.current = false

    const handleHeartbeat = (payload: HeartbeatPayload) => {
      lastHeartbeatRef.current = Date.now()
      // 房主恢复在线后重置提示标记，便于下次离线再次提示
      hostOfflineNotifiedRef.current = false
      // 静默应用：心跳携带的进度/播放状态只用于容错同步
      // （实际同步走 state/control 事件）
      const video = videoRef.current
      if (!video) return
      if (!payload.isPlaying && !video.paused) {
        video.pause()
      }
    }
    socket.on(SOCKET_EVENT.HOST_HEARTBEAT, handleHeartbeat)

    const checkIntervalId = setInterval(() => {
      if (Date.now() - lastHeartbeatRef.current > HEARTBEAT_TIMEOUT_MS) {
        if (hostOfflineNotifiedRef.current) return
        hostOfflineNotifiedRef.current = true
        message.warning('房主已离线')
        const video = videoRef.current
        if (video && !video.paused) {
          video.pause()
        }
      }
    }, 1000)

    return () => {
      socket.off(SOCKET_EVENT.HOST_HEARTBEAT, handleHeartbeat)
      clearInterval(checkIntervalId)
    }
  }, [socket, videoRef, isHostRef])

  // 监听 host-disconnected：后端在房主 socket 断开时广播
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleHostDisconnected = () => {
      // 标记房主离线，避免心跳检测再次提示
      hostOfflineNotifiedRef.current = true
      lastHeartbeatRef.current = 0
      const video = videoRef.current
      if (video && !video.paused) {
        video.pause()
      }
      message.warning('房主已离开，播放已暂停')
    }
    socket.on(SOCKET_EVENT.HOST_DISCONNECTED, handleHostDisconnected)

    return () => {
      socket.off(SOCKET_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
    }
  }, [socket, videoRef, isHostRef])
}
