import { useEffect } from 'react'
import { useAuthStore } from '@/store/authStore'
import { useRoomDisplayNameStore } from '@/store/roomDisplayNameStore'

export interface RoomDisplayNameValue {
  /** 本房间显示名：登录用户默认账号名，游客默认「游客XXXX」 */
  name: string
  /** 修改昵称；校验失败返回 false */
  rename: (next: string) => boolean
}

/** 读取/修改「本房间内的显示名」。 */
export function useRoomDisplayName(roomId?: string): RoomDisplayNameValue {
  const user = useAuthStore((state) => state.user)
  const accountName =
    user && user.role !== 'guest' ? (user.username ?? null) : null

  const name = useRoomDisplayNameStore((state) =>
    roomId ? state.names[roomId] : undefined
  )
  const ensure = useRoomDisplayNameStore((state) => state.ensure)
  const rename = useRoomDisplayNameStore((state) => state.rename)

  useEffect(() => {
    if (roomId) ensure(roomId, accountName)
  }, [roomId, accountName, ensure])

  return {
    name: name ?? accountName ?? '',
    rename: (next: string) => (roomId ? rename(roomId, next) : false),
  }
}
