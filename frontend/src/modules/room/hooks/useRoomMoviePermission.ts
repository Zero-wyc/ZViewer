/**
 * 一起看「允许成员点片」权限的加载与实时同步。
 *
 * 房主页 / 观众页各自调用一次：进房拉取一次权威值，之后跟随
 * socket 事件 movie:permission-changed 更新（房主改开关后全体立即生效）。
 */
import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { useRoomStore } from '@/store/roomStore'
import {
  fetchMoviePermission,
  normalizeMoviePermission,
} from '@/store/moviePermission'

export function useRoomMoviePermission(
  socket: Socket | null | undefined,
  roomId: string | undefined
) {
  const setMoviePermission = useRoomStore((state) => state.setMoviePermission)

  useEffect(() => {
    if (!roomId) return
    let cancelled = false
    void fetchMoviePermission(roomId)
      .then((permission) => {
        if (!cancelled) setMoviePermission(permission)
      })
      .catch((err) => {
        console.warn('[useRoomMoviePermission] 获取点片权限失败:', err)
      })
    return () => {
      cancelled = true
    }
  }, [roomId, setMoviePermission])

  useEffect(() => {
    if (!socket || !roomId) return
    const handler = (payload?: { roomId?: string; permission?: unknown }) => {
      if (!payload || payload.roomId !== roomId) return
      if (!payload.permission) return
      setMoviePermission(normalizeMoviePermission(payload.permission))
    }
    socket.on('movie:permission-changed', handler)
    return () => {
      socket.off('movie:permission-changed', handler)
    }
  }, [roomId, setMoviePermission, socket])
}
