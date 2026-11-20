/**
 * 房间共享账号状态（网易云 / B站）。
 *
 * 需求：一位成员在房间内登录账号后，房间内其他成员也能直接用这个账号点歌 / 点片。
 * 服务端把账号绑定到房间（room_account 表），并把所有账号类请求解析到这份凭证；
 * 前端不再各自持号搜索/解析——只负责展示「当前房间用的是谁的账号」并发起登录/退出。
 *
 * 约定（后端 `GET /api/rooms/{roomId}/accounts`）：
 * - source='room'  成员登录后绑定给全房间用的账号（binderName 为登录者昵称）
 * - source='owner' 房间没有绑定时回退用房主的个人账号
 * - source='self'  仅当前请求者自己的账号（旧行为，其他人看不到）
 * 账号变化由服务端广播 `room-account-changed`，收到后整体刷新。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { apiGet, apiPost } from '@/lib/api'

export type RoomAccountProvider = 'ncm' | 'bilibili'

export interface RoomAccountInfo {
  loggedIn: boolean
  userId?: number
  nickname?: string
  avatarUrl?: string
  source?: 'room' | 'owner' | 'self' | ''
  /** 把账号共享给房间的成员昵称（source='room' 时有值） */
  binderName?: string
}

export interface RoomAccountsState {
  ncm?: RoomAccountInfo
  bilibili?: RoomAccountInfo
}

interface AccountsResponse {
  success?: boolean
  accounts?: RoomAccountsState
}

export interface UseRoomAccountsResult {
  accounts: RoomAccountsState
  /** 主动刷新（登录成功/退出后调用）；返回请求是否成功 */
  refresh: () => Promise<boolean>
  /** 退出房间共享账号（只解绑房间，不删除登录者的个人凭证） */
  logout: (provider: RoomAccountProvider) => Promise<boolean>
}

export function useRoomAccounts(
  socket: Socket | null,
  roomId: string | undefined
): UseRoomAccountsResult {
  const [accounts, setAccounts] = useState<RoomAccountsState>({})
  const roomIdRef = useRef(roomId)
  roomIdRef.current = roomId

  /** 拉取一次账号状态；返回 true 表示请求成功（403 说明还没通过房间准入）。 */
  const refresh = useCallback(async (): Promise<boolean> => {
    const id = roomIdRef.current
    if (!id) {
      setAccounts({})
      return false
    }
    try {
      const { data, ok } = await apiGet<AccountsResponse>(
        `/api/rooms/${encodeURIComponent(id)}/accounts`
      )
      if (!ok || !data || !data.accounts) return false
      // 房间切换后丢弃过期响应
      if (roomIdRef.current !== id) return false
      setAccounts(data.accounts)
      return true
    } catch {
      // 后端旧版本没有该接口时静默降级：面板按「未登录」展示
      return false
    }
  }, [])

  // 面板在观众「加入房间」之前就已挂载（RoomPage 观众分支同时渲染 WatchPage 与
  // 面板），此时 /accounts 会因房间准入未通过返回 403。这里按退避重试，
  // 直到拿到账号状态为止——否则账号区会一直停在「未登录」。
  useEffect(() => {
    if (!roomId) {
      setAccounts({})
      return undefined
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    const RETRY_DELAYS = [800, 1600, 3200, 5000]
    const run = async () => {
      const ok = await refresh()
      if (cancelled || ok) return
      if (attempt >= RETRY_DELAYS.length) return
      const delay = RETRY_DELAYS[attempt]
      attempt += 1
      timer = setTimeout(() => {
        void run()
      }, delay)
    }
    void run()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [refresh, roomId])

  useEffect(() => {
    if (!socket) return undefined
    const handler = (payload?: { roomId?: string }) => {
      if (payload?.roomId && payload.roomId !== roomIdRef.current) return
      void refresh()
    }
    socket.on('room-account-changed', handler)
    // 断线重连后房间绑定可能已变化（成员在此期间登录/退出），补一次刷新
    const onConnect = () => {
      void refresh()
    }
    socket.on('connect', onConnect)
    return () => {
      socket.off('room-account-changed', handler)
      socket.off('connect', onConnect)
    }
  }, [socket, refresh])

  const logout = useCallback(
    async (provider: RoomAccountProvider) => {
      const id = roomIdRef.current
      if (!id) return false
      try {
        const { data, ok } = await apiPost<{ success?: boolean; message?: string }>(
          `/api/rooms/${encodeURIComponent(id)}/accounts/logout`,
          { provider }
        )
        const refreshed = await refresh()
        return (ok && data?.success !== false) || refreshed
      } catch {
        return false
      }
    },
    [refresh]
  )

  return { accounts, refresh, logout }
}