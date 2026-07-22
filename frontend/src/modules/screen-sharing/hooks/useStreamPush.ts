import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import {
  useRoomStore,
  type ShareMethod,
  type StreamStatus,
} from '@/store/roomStore'

export type { StreamStatus, ShareMethod }

/**
 * 订阅 stream-status 事件，同步推流状态到 roomStore。
 *
 * 职责单一：仅监听 NMS 广播的 stream-status 事件并更新全局 store。
 * 房主和观众端均可使用，无角色差异。
 */
export function useStreamStatus(
  socket: Socket | null,
  roomId: string,
): StreamStatus {
  const streamStatus = useRoomStore((state) => state.streamStatus)
  const setStreamStatus = useRoomStore((state) => state.setStreamStatus)

  useEffect(() => {
    if (!socket || !roomId) return
    const handleStreamStatus = (payload: {
      roomId: string
      status: 'live' | 'offline'
    }) => {
      if (payload.roomId !== roomId) return
      setStreamStatus(payload.status)
    }
    socket.on('stream-status', handleStreamStatus)
    return () => {
      socket.off('stream-status', handleStreamStatus)
    }
  }, [socket, roomId, setStreamStatus])

  return streamStatus
}

/**
 * 子模式管理：订阅 share-method-changed + 暴露切换方法。
 *
 * 职责单一：仅管理 shareMethod 的读取与切换。
 * - 订阅 share-method-changed 事件，同步到 roomStore
 * - updateShareMethod 仅房主可调用，切换失败时返回错误信息
 *
 * @param isHost 是否房主（仅房主可调用 updateShareMethod）
 */
export function useShareMethod(
  socket: Socket | null,
  roomId: string,
  isHost: boolean,
) {
  const shareMethod = useRoomStore((state) => state.shareMethod)
  const setShareMethod = useRoomStore((state) => state.setShareMethod)
  const setStreamKey = useRoomStore((state) => state.setStreamKey)

  // 订阅 share-method-changed 事件，同步到 store
  useEffect(() => {
    if (!socket || !roomId) return
    const handleShareMethodChanged = (payload: {
      roomId: string
      shareMethod: ShareMethod
      streamKey?: string | null
    }) => {
      if (payload.roomId !== roomId) return
      setShareMethod(payload.shareMethod)
      // 同步推流密钥（stream-push 子模式使用）
      if (payload.streamKey !== undefined) {
        setStreamKey(payload.streamKey)
      }
    }
    socket.on('share-method-changed', handleShareMethodChanged)
    return () => {
      socket.off('share-method-changed', handleShareMethodChanged)
    }
  }, [socket, roomId, setShareMethod, setStreamKey])

  // 切换子模式
  const updateShareMethod = async (
    method: ShareMethod,
  ): Promise<{ success: boolean; message?: string }> => {
    if (!socket || !roomId) {
      return { success: false, message: 'Socket 未连接' }
    }
    if (!isHost) {
      return { success: false, message: '仅房主可切换子模式' }
    }
    return new Promise((resolve) => {
      socket.emit(
        'update-share-method',
        { roomId, shareMethod: method },
        (response: {
          success: boolean
          message?: string
          data?: { shareMethod?: ShareMethod; streamKey?: string | null }
        }) => {
          if (response.success) {
            setShareMethod(method)
            // 同步推流密钥（stream-push 子模式使用）
            if (response.data?.streamKey !== undefined) {
              setStreamKey(response.data.streamKey)
            }
          }
          resolve(response)
        },
      )
    })
  }

  return {
    shareMethod,
    updateShareMethod,
  }
}
