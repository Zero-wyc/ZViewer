import { useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuthStore, type User } from '@/store/authStore'
import {
  apiFetch,
  getSocketUrl,
  getRefreshToken,
  saveAuthTokens,
  resetSessionExpired,
} from '@/lib/api'
import { buildSocketAuth } from '@/lib/authTransport'

let globalSocket: Socket | null = null
/** 语音媒体专用连接（语音帧与业务消息隔离，消除 TCP 队头阻塞） */
let globalMediaSocket: Socket | null = null
let refCount = 0
let disconnectTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 创建 Socket.IO 连接。
 *
 * 关键点：
 * 1. `withCredentials: true`：让浏览器携带 httpOnly cookie（access_token）
 *    socket.io 中间件会从 handshake.headers.cookie 读取 access_token 进行认证
 * 2. `auth.token`：跨站 HTTP / 直连场景 cookie 不可用时，携带本地 Bearer token
 *    （后端 socket.io 中间件兼容 auth.token 字段）
 * 3. autoConnect: false，由调用方控制连接时机
 */
function getSocket(): Socket {
  if (globalSocket) return globalSocket

  const socketUrl = getSocketUrl()
  globalSocket = io(socketUrl, {
    transports: ['websocket', 'polling'],
    autoConnect: false,
    withCredentials: true,
    // 分离式鉴权：HTTPS 走 cookie（自动携带），HTTP 走 auth.token（每次握手取最新）
    // socket.io v4 的 auth 函数使用回调风格：cb(payload) 而非 return payload
    auth: (cb: (data: Record<string, string>) => void) => {
      cb(buildSocketAuth())
    },
  })

  // 调试钩子：暴露 socket 到 window 以便检查内部状态
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __debugSocket?: Socket }).__debugSocket =
      globalSocket
  }

  return globalSocket
}

/**
 * 获取/创建语音媒体专用连接。
 *
 * 与主连接同一认证、同一地址，但仅用 WebSocket 传输（无轮询降级），
 * 只承载语音帧——大消息（字幕同步/弹幕/成员列表）的 TCP 队头阻塞
 * 不再波及 20ms 的音频帧。生命周期由语音会话（join/leave）驱动
 */
export function getVoiceMediaSocket(): Socket {
  if (globalMediaSocket) return globalMediaSocket

  globalMediaSocket = io(getSocketUrl(), {
    transports: ['websocket'],
    autoConnect: false,
    withCredentials: true,
    auth: (cb: (data: Record<string, string>) => void) => {
      cb(buildSocketAuth())
    },
  })

  return globalMediaSocket
}

/** 销毁语音媒体专用连接（后端地址变化等场景） */
export function resetVoiceMediaSocket(): void {
  if (globalMediaSocket) {
    try {
      globalMediaSocket.disconnect()
    } catch {
      // ignore
    }
    globalMediaSocket = null
  }
}

/**
 * 触发 socket 重连。
 * access token 刷新后，旧连接的握手 token 已失效，需要断开重连让 socket.io 重新走握手流程
 * （重新发送 cookie）。socket.io 4.x 的 disconnect+connect 不会重建底层实例，
 * 但会重新发起握手，所以可以复用同一个 Socket 实例。
 */
export function reconnectSocket() {
  if (!globalSocket) return
  globalSocket.disconnect()
  // 微任务延迟避免 disconnect/connect 在同一事件循环中冲突
  setTimeout(() => {
    if (globalSocket && !globalSocket.connected) {
      globalSocket.connect()
    }
  }, 50)
}

/**
 * 强制销毁全局 socket 实例。
 * 当自定义后端地址变化时，旧实例仍指向原 SOCKET_URL，需要重建才能使用新地址。
 */
export function resetSocket(): void {
  if (globalSocket) {
    try {
      globalSocket.disconnect()
    } catch {
      // ignore
    }
    globalSocket = null
  }
  resetVoiceMediaSocket()
  refCount = 0
  if (disconnectTimer) {
    clearTimeout(disconnectTimer)
    disconnectTimer = null
  }
}

export function useSocket() {
  const logout = useAuthStore((s) => s.logout)

  // 防止 connect_error 触发多次并发 refresh
  const isRefreshingRef = useRef(false)

  // 已认证或游客身份均需要建立 socket（游客也有 accessToken cookie）
  // 这里只判断是否已通过 AuthInitializer 完成 autoLogin，避免过早创建 socket
  const autoLoginStatus = useAuthStore((s) => s.autoLoginStatus)
  const shouldCreateSocket = autoLoginStatus === 'done'

  const socket = useMemo(() => {
    if (!shouldCreateSocket) return null
    return getSocket()
  }, [shouldCreateSocket])

  const [connected, setConnected] = useState(() => socket?.connected ?? false)

  useEffect(() => {
    if (!socket) return

    refCount++
    if (disconnectTimer) {
      clearTimeout(disconnectTimer)
      disconnectTimer = null
    }
    if (!socket.connected) {
      socket.connect()
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初始化连接状态
    setConnected(socket.connected)

    const onConnect = () => {
      setConnected(true)
    }
    const onDisconnect = (reason: string) => {
      console.warn('[useSocket] disconnected:', reason)
      setConnected(false)
    }
    const onConnectError = async (err: Error) => {
      console.warn('[useSocket] connect_error:', err.message)
      // 认证类错误（access token 过期）：尝试 refresh → guest token → logout 三级降级
      const msg = err.message || ''
      const isAuthError =
        msg.includes('未提供认证令牌') ||
        msg.includes('认证令牌无效') ||
        msg.includes('认证令牌已过期') ||
        msg.includes('token') ||
        msg.includes('unauthorized') ||
        msg.includes('not authenticated')

      if (!isAuthError || isRefreshingRef.current) {
        setConnected(false)
        return
      }

      isRefreshingRef.current = true
      try {
        // Step 1: 尝试 refresh access token
        const res = await apiFetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: getRefreshToken() }),
        })
        if (res.ok) {
          const data = (await res.json()) as {
            success?: boolean
            accessToken?: string
          }
          if (data.success) {
            if (data.accessToken) saveAuthTokens(data.accessToken)
            reconnectSocket()
            return
          }
        }

        // Step 2: refresh 失败 → 获取 guest token 作为降级身份
        const guestRes = await apiFetch('/api/auth/guest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        if (guestRes.ok) {
          const guestData = (await guestRes.json()) as {
            success?: boolean
            user?: {
              id: string
              username: string
              role: string
              status?: 'active' | 'pending'
              avatar?: string | null
            }
            accessToken?: string
          }
          if (guestData.success && guestData.user) {
            if (guestData.accessToken) saveAuthTokens(guestData.accessToken)
            resetSessionExpired()
            useAuthStore.getState().setUser({
              id: guestData.user.id,
              username: guestData.user.username,
              role: guestData.user.role as User['role'],
              status: guestData.user.status,
              avatar: guestData.user.avatar,
            })
            reconnectSocket()
            return
          }
        }

        // Step 3: guest token 也失败 → 登出作为最后手段
        logout()
      } catch {
        // 网络错误 → 不登出，等待 socket.io 自动重试
      } finally {
        isRefreshingRef.current = false
      }
      setConnected(false)
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)

      refCount--
      if (refCount <= 0) {
        if (disconnectTimer) clearTimeout(disconnectTimer)
        disconnectTimer = setTimeout(() => {
          if (refCount <= 0 && globalSocket === socket) {
            socket.disconnect()
          }
        }, 100)
      }
    }
  }, [socket, logout])

  // socket 不存在时强制返回未连接，避免在 effect 中同步 setState
  return { socket, connected: socket ? connected : false }
}
