import { useEffect } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { SOCKET_EVENT } from '../constants'
import { buildStateFromVideo } from '../services'

export interface UseHostStateRequestOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
}

export type UseHostStateRequestReturn = void

/**
 * 房主状态请求响应 Hook：监听观众的 `watch-together-request-state` 事件，
 * 将当前 video 元素 + store 的最新状态广播给请求方。
 *
 * 触发时机：
 * - 观众加入房间时（useViewerStateSync emit REQUEST_STATE）
 * - 观众刷新页面后重新挂载
 * - 观众手动点击"请求同步"按钮（如有）
 *
 * 注意：若 video 元素尚未完成源恢复（例如房主刚切回一起看模式），
 * 回退到 roomStore 中保存的状态，避免把观众重置到 00:00。
 * 状态构建统一使用 `buildStateFromVideo` 服务函数。
 */
export function useHostStateRequest({
  roomId,
  isHostRef,
  videoRef,
}: UseHostStateRequestOptions): UseHostStateRequestReturn {
  const { socket } = useSocket()

  useEffect(() => {
    if (!socket || !isHostRef.current) return

    const handleRequestState = () => {
      const video = videoRef.current
      const storeState = useRoomStore.getState().watchTogether
      const newState = buildStateFromVideo(video, storeState)
      socket.emit(SOCKET_EVENT.STATE, { roomId, state: newState })
    }

    socket.on(SOCKET_EVENT.REQUEST_STATE, handleRequestState)
    return () => {
      socket.off(SOCKET_EVENT.REQUEST_STATE, handleRequestState)
    }
  }, [socket, roomId, videoRef, isHostRef])
}
