import { useEffect } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import type { ViewerJoinedPayload, ViewerLeftPayload } from '../types'
import { SOCKET_EVENT } from '../constants'

export type UseViewerListOptions = Record<string, never>

export type UseViewerListReturn = void

/**
 * 观众在线列表同步 Hook：房主与观众均监听 `viewer-joined` / `viewer-left` 事件，
 * 更新 useRoomStore.viewers 以驱动房主端 RoomInfoPanel 的在线观众列表。
 *
 * 后端在观众加入/离开房间时广播这两个事件（详见 routes/room.ts）。
 */
export function useViewerList(): UseViewerListReturn {
  const { socket } = useSocket()

  useEffect(() => {
    if (!socket) return

    const handleViewerJoined = (payload: ViewerJoinedPayload) => {
      if (!payload?.viewerSocketId) return
      useRoomStore.getState().addViewer({
        socketId: payload.viewerSocketId,
        userId: payload.userId,
        username: payload.username,
        role: payload.role,
      })
    }
    const handleViewerLeft = (payload: ViewerLeftPayload) => {
      if (!payload?.socketId) return
      useRoomStore.getState().removeViewer(payload.socketId)
    }

    socket.on(SOCKET_EVENT.VIEWER_JOINED, handleViewerJoined)
    socket.on(SOCKET_EVENT.VIEWER_LEFT, handleViewerLeft)

    return () => {
      socket.off(SOCKET_EVENT.VIEWER_JOINED, handleViewerJoined)
      socket.off(SOCKET_EVENT.VIEWER_LEFT, handleViewerLeft)
    }
  }, [socket])
}
