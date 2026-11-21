import { useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useRoomDisplayNameStore } from '@/store/roomDisplayNameStore'

export interface RoomDisplayNameValue {
  /** 本房间显示名：登录用户默认账号名，游客默认「游客XXXX」 */
  name: string
  /** 当前是否游客（游客才弹首次昵称设置框） */
  isGuest: boolean
  /** 本次进入房间时还没有保存过昵称（用于只弹一次设置框） */
  fresh: boolean
  /** 修改昵称；校验失败返回 false */
  rename: (next: string) => boolean
  /** 关闭首次设置框但保留默认昵称 */
  markSeen: () => void
}

/** 读取/修改「本房间内的显示名」。 */
export function useRoomDisplayName(roomId?: string): RoomDisplayNameValue {
  const user = useAuthStore((state) => state.user)
  const isGuest = !user || user.role === 'guest'
  const accountName = isGuest ? null : (user?.username ?? null)

  const name = useRoomDisplayNameStore((state) => (roomId ? state.names[roomId] : undefined))
  const fresh = useRoomDisplayNameStore((state) => (roomId ? state.fresh[roomId] : undefined))
  const ensure = useRoomDisplayNameStore((state) => state.ensure)
  const rename = useRoomDisplayNameStore((state) => state.rename)
  const markSeen = useRoomDisplayNameStore((state) => state.markSeen)

  useEffect(() => {
    if (roomId) ensure(roomId, accountName)
  }, [roomId, accountName, ensure])

  return {
    name: name ?? accountName ?? '',
    isGuest,
    fresh: Boolean(fresh),
    rename: (next: string) => (roomId ? rename(roomId, next) : false),
    markSeen: () => {
      if (roomId) markSeen(roomId)
    },
  }
}
