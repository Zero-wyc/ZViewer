import { useEffect, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { useRoomStore, type ShareMethod } from '@/store/roomStore'

export type StreamStatus = 'live' | 'offline' | 'unknown'

interface UseStreamPushOptions {
  socket: Socket | null
  roomId: string
  isHost: boolean
}

interface UseStreamPushReturn {
  streamStatus: StreamStatus
  shareMethod: ShareMethod
  updateShareMethod: (
    method: ShareMethod
  ) => Promise<{ success: boolean; message?: string }>
}

/**
 * 推流模式相关状态与事件订阅。
 * - 订阅 stream-status 事件，维护 streamStatus
 * - 订阅 share-method-changed 事件，同步到 roomStore
 * - 暴露 updateShareMethod 用于切换子模式
 */
export function useStreamPush({
  socket,
  roomId,
  isHost,
}: UseStreamPushOptions): UseStreamPushReturn {
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('unknown')
  const shareMethod = useRoomStore((state) => state.shareMethod)
  const setShareMethod = useRoomStore((state) => state.setShareMethod)

  // 订阅 stream-status 事件
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
  }, [socket, roomId])

  // 订阅 share-method-changed 事件，同步到 store
  useEffect(() => {
    if (!socket || !roomId) return
    const handleShareMethodChanged = (payload: {
      roomId: string
      shareMethod: ShareMethod
    }) => {
      if (payload.roomId !== roomId) return
      setShareMethod(payload.shareMethod)
    }
    socket.on('share-method-changed', handleShareMethodChanged)
    return () => {
      socket.off('share-method-changed', handleShareMethodChanged)
    }
  }, [socket, roomId, setShareMethod])

  // 切换子模式
  const updateShareMethod = async (
    method: ShareMethod
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
        (response: { success: boolean; message?: string }) => {
          if (response.success) {
            setShareMethod(method)
          }
          resolve(response)
        }
      )
    })
  }

  return {
    streamStatus,
    shareMethod,
    updateShareMethod,
  }
}
