import { useEffect } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import type { HeartbeatPayload } from '../types'
import { SOCKET_EVENT, HEARTBEAT_INTERVAL_MS } from '../constants'

export interface UseHostHeartbeatOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
}

export type UseHostHeartbeatReturn = void

/**
 * 房主心跳广播 Hook：每 `HEARTBEAT_INTERVAL_MS`（默认 2s）向房间广播一次
 * `host-heartbeat` 事件，携带当前播放进度与播放状态。
 *
 * 观众端通过 useViewerHeartbeat 监听该事件，用于房主离线检测：
 * 若 `HEARTBEAT_TIMEOUT_MS`（默认 6s）内未收到心跳，判定房主已离线。
 *
 * **修复说明**：旧实现前端 emit `host-heartbeat` 但后端无转发 handler，
 * 导致观众端永远收不到心跳，6s 后必然误报"房主已离线"。
 * 新增后端 handler 后该功能恢复正常。
 */
export function useHostHeartbeat({
  roomId,
  isHostRef,
  videoRef,
}: UseHostHeartbeatOptions): UseHostHeartbeatReturn {
  const { socket } = useSocket()

  useEffect(() => {
    if (!socket || !isHostRef.current) return

    const intervalId = setInterval(() => {
      const video = videoRef.current
      const payload: HeartbeatPayload = {
        currentTime: video ? video.currentTime : 0,
        isPlaying: video ? !video.paused : false,
      }
      socket.emit(SOCKET_EVENT.HOST_HEARTBEAT, { roomId, ...payload })
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [socket, roomId, videoRef, isHostRef])
}
