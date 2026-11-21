import { create } from 'zustand'
import {
  ensureRoomDisplayName,
  isValidDisplayName,
  writeRoomDisplayName,
} from '@/modules/room/lib/displayName'

interface RoomDisplayNameState {
  /** roomId → 本房间昵称 */
  names: Record<string, string>
  ensure: (roomId: string, accountName?: string | null) => void
  rename: (roomId: string, name: string) => boolean
}

/**
 * 房间昵称的单一来源。
 *
 * RoomPage（推送昵称）、RoomInfoPanel（显示/编辑）、评论独立窗口都要读写
 * 同一份状态：localStorage 的 storage 事件不会在同一标签页触发，
 * 因此必须用 store 共享，不能各自读 localStorage。
 */
export const useRoomDisplayNameStore = create<RoomDisplayNameState>()(
  (set, get) => ({
    names: {},
    ensure: (roomId, accountName) => {
      if (!roomId || get().names[roomId]) return
      const name = ensureRoomDisplayName(roomId, accountName ?? null)
      set((state) => ({ names: { ...state.names, [roomId]: name } }))
    },
    rename: (roomId, name) => {
      const trimmed = name.trim()
      if (!roomId || !isValidDisplayName(trimmed)) return false
      writeRoomDisplayName(roomId, trimmed)
      set((state) => ({ names: { ...state.names, [roomId]: trimmed } }))
      return true
    },
  })
)
