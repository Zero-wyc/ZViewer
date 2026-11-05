import { useEffect } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore, type Viewer } from '@/store/roomStore'
import { useAuthStore } from '@/store/authStore'
import { message } from '@/components/ui/message'
import { t } from '@/i18n'
import type { ViewerJoinedPayload, ViewerLeftPayload } from '../types'
import { SOCKET_EVENT } from '../constants'

export type UseViewerListOptions = Record<string, never>

export type UseViewerListReturn = void

/**
 * 观众在线列表同步 Hook：房主与观众均监听 `viewer-joined` / `viewer-left` 事件，
 * 更新成员与房管状态，并用全量快照修复漏事件和旧 socket 身份。
 *
 * 挂在 RoomPage，覆盖所有房间模式，不依赖管理面板是否打开。
 */
export function useViewerList(roomId?: string): UseViewerListReturn {
  const { socket } = useSocket()

  useEffect(() => {
    if (!socket || !roomId) return
    let active = true
    let requestPending = false
    let membershipRevision = 0

    interface MembersSnapshot {
      roomId: string
      viewers: Viewer[]
      moderators: number[]
      mutedViewerIds: number[]
    }
    const applySnapshot = (payload: MembersSnapshot) => {
      if (
        !active ||
        payload?.roomId !== roomId ||
        !Array.isArray(payload.viewers) ||
        !Array.isArray(payload.moderators) ||
        !Array.isArray(payload.mutedViewerIds)
      )
        return
      const store = useRoomStore.getState()
      store.setMutedViewerIds(payload.mutedViewerIds)
      store.setViewers(payload.viewers)
      store.setModerators(payload.moderators)
    }
    const requestSnapshot = () => {
      if (!socket.connected || requestPending) return
      requestPending = true
      const socketId = socket.id
      const revision = membershipRevision
      socket
        .timeout(5000)
        .emit(
          'get-room-members',
          { roomId },
          (
            error: Error | null,
            response?: { success: boolean; data?: MembersSnapshot }
          ) => {
            requestPending = false
            if (
              !active ||
              error ||
              socket.id !== socketId ||
              revision !== membershipRevision ||
              !response?.success ||
              !response.data
            )
              return
            applySnapshot(response.data)
          }
        )
    }

    const handleViewerJoined = (payload: ViewerJoinedPayload) => {
      if (!payload?.viewerSocketId) return
      membershipRevision++
      useRoomStore.getState().addViewer({
        socketId: payload.viewerSocketId,
        userId: payload.userId,
        username: payload.username,
        role: payload.role,
      })
    }
    const handleViewerLeft = (payload: ViewerLeftPayload) => {
      if (!payload?.viewerSocketId) return
      membershipRevision++
      useRoomStore.getState().removeViewer(payload.viewerSocketId)
    }
    const handleModeratorsChanged = (payload: {
      roomId: string
      moderators: number[]
    }) => {
      if (payload?.roomId !== roomId || !Array.isArray(payload.moderators))
        return
      membershipRevision++
      const store = useRoomStore.getState()
      const userId = Number(useAuthStore.getState().user?.id)
      const wasModerator = store.moderators.includes(userId)
      store.setModerators(payload.moderators)
      const isModerator = payload.moderators.includes(userId)
      if (wasModerator !== isModerator) {
        if (isModerator) message.success(t('您已被任命为房管'))
        else message.info(t('您的房管权限已被撤销'))
      }
    }
    const handleMembers = (payload: MembersSnapshot) => {
      if (payload?.roomId !== roomId) return
      membershipRevision++
      applySnapshot(payload)
    }
    const onConnect = () => {
      membershipRevision++
      requestPending = false
      requestSnapshot()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') requestSnapshot()
    }

    socket.on(SOCKET_EVENT.VIEWER_JOINED, handleViewerJoined)
    socket.on(SOCKET_EVENT.VIEWER_LEFT, handleViewerLeft)
    socket.on('room-members', handleMembers)
    socket.on('moderators-changed', handleModeratorsChanged)
    socket.on('connect', onConnect)
    socket.on('join-approved', requestSnapshot)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = setInterval(requestSnapshot, 30_000)
    requestSnapshot()

    return () => {
      active = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      socket.off(SOCKET_EVENT.VIEWER_JOINED, handleViewerJoined)
      socket.off(SOCKET_EVENT.VIEWER_LEFT, handleViewerLeft)
      socket.off('room-members', handleMembers)
      socket.off('moderators-changed', handleModeratorsChanged)
      socket.off('connect', onConnect)
      socket.off('join-approved', requestSnapshot)
    }
  }, [socket, roomId])
}
