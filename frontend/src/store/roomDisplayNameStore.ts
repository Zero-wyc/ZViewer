import { create } from 'zustand'
import {
  ensureRoomDisplayName,
  isValidDisplayName,
  readRoomDisplayName,
  writeRoomDisplayName,
} from '@/modules/room/lib/displayName'

interface RoomDisplayNameState {
  /** roomId → 本房间昵称 */
  names: Record<string, string>
  /** roomId → 本次进入时是否还没有保存过的昵称（游客需要弹一次设置框） */
  fresh: Record<string, boolean>
  ensure: (roomId: string, accountName?: string | null) => void
  rename: (roomId: string, name: string) => boolean
  markSeen: (roomId: string) => void
}

/**
 * 房间昵称的单一来源。
 *
 * RoomPage（推送昵称）、昵称设置弹窗、RoomInfoPanel（显示/编辑）三处都要读写
 * 同一份状态：localStorage 的 storage 事件不会在同一标签页触发，
 * 因此必须用 store 共享，不能各自读 localStorage。
 */
export const useRoomDisplayNameStore = create<RoomDisplayNameState>()((set, get) => ({
  names: {},
  fresh: {},
  ensure: (roomId, accountName) => {
    if (!roomId || get().names[roomId]) return
    const stored = readRoomDisplayName(roomId)
    const name = ensureRoomDisplayName(roomId, accountName ?? null)
    set((state) => ({
      names: { ...state.names, [roomId]: name },
      fresh: { ...state.fresh, [roomId]: !stored },
    }))
  },
  rename: (roomId, name) => {
    const trimmed = name.trim()
    if (!roomId || !isValidDisplayName(trimmed)) return false
    writeRoomDisplayName(roomId, trimmed)
    set((state) => ({
      names: { ...state.names, [roomId]: trimmed },
      fresh: { ...state.fresh, [roomId]: false },
    }))
    return true
  },
  markSeen: (roomId) => {
    if (!roomId) return
    set((state) => ({ fresh: { ...state.fresh, [roomId]: false } }))
  },
}))
