import { useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuthStore } from '@/store/authStore'

// 生产环境通过 Nginx 反向代理，默认使用当前域名即可；
// 开发环境可通过 .env 文件设置 VITE_API_URL=http://localhost:3333
const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const SERVER_URL = rawApiUrl || window.location.origin

let globalSocket: Socket | null = null
let refCount = 0
let disconnectTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 创建 Socket.IO 连接。
 *
 * 关键点：
 * 1. `withCredentials: true`：让浏览器携带 httpOnly cookie（access_token）
 *    socket.io 中间件会从 handshake.headers.cookie 读取 access_token 进行认证
 * 2. 不再通过 auth.token 显式传递 token（前端无法读取 httpOnly cookie）
 * 3. autoConnect: false，由调用方控制连接时机
 */
function getSocket(): Socket {
  if (globalSocket) {
    return globalSocket
  }

  globalSocket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    autoConnect: false,
    withCredentials: true,
  })

  return globalSocket
}

/**
 * 触发 socket 重连。
 * access token 刷新后，旧连接的握手 token 已失效，需要断开重连让 socket.io 重新走握手流程
 * （重新发送 cookie）。socket.io 4.x 的 disconnect+connect 不会重建底层实例，
 * 但会重新发起握手，所以可以复用同一个 Socket 实例。
 */
function reconnectSocket() {
  if (!globalSocket) return
  globalSocket.disconnect()
  // 微任务延迟避免 disconnect/connect 在同一事件循环中冲突
  setTimeout(() => {
    if (globalSocket && !globalSocket.connected) {
      globalSocket.connect()
    }
  }, 50)
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

    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    const onConnectError = async (err: Error) => {
      console.error('[useSocket] connection error:', err.message)

      // 认证类错误（access token 过期）：调 /api/auth/refresh，成功后重连
      // 失败才 logout。socket.io 的认证错误消息由后端中间件返回。
      const msg = err.message || ''
      const isAuthError =
        msg.includes('未提供认证令牌') ||
        msg.includes('认证令牌无效') ||
        msg.includes('认证令牌已过期') ||
        msg.includes('token') ||
        msg.includes('unauthorized') ||
        msg.includes('not authenticated')

      if (isAuthError && !isRefreshingRef.current) {
        isRefreshingRef.current = true
        try {
          const res = await fetch(`${SERVER_URL}/api/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
          })
          if (res.ok) {
            const data = (await res.json()) as { success?: boolean }
            if (data.success) {
              // refresh 成功：cookie 已更新，断开重连让 socket 重新握手
              console.log('[useSocket] token refreshed, reconnecting socket')
              reconnectSocket()
              return
            }
          }
          // refresh 失败：refresh token 也过期/无效，登出
          console.warn('[useSocket] refresh failed, logging out')
          logout()
        } catch (refreshErr) {
          console.warn('[useSocket] refresh network error:', refreshErr)
        } finally {
          isRefreshingRef.current = false
        }
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
