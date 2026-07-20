import { useEffect, useMemo, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuthStore } from '@/store/authStore'
import { refreshAccessToken, isAuthErrorMessage } from '@/lib/tokenRefresh'

// 生产环境通过 Nginx 反向代理，默认使用当前域名即可；
// 开发环境可通过 .env 文件设置 VITE_API_URL=http://localhost:3000
const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const SERVER_URL = rawApiUrl || window.location.origin

let globalSocket: Socket | null = null
let currentToken: string | null = null
let refCount = 0
let disconnectTimer: ReturnType<typeof setTimeout> | null = null

function getSocket(token: string): Socket {
  if (globalSocket && currentToken === token) {
    return globalSocket
  }

  if (globalSocket) {
    globalSocket.disconnect()
  }

  currentToken = token
  globalSocket = io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    autoConnect: false,
    auth: { token },
  })

  return globalSocket
}

export function useSocket() {
  const accessToken = useAuthStore((s) => s.accessToken)
  const logout = useAuthStore((s) => s.logout)

  // 防止 connect_error 触发多次并发 refresh
  const isRefreshingRef = useRef(false)

  // token 变化时重新创建 socket 实例；同 token 下全局复用，避免路由切换导致断连
  const socket = useMemo(() => {
    if (!accessToken) return null
    return getSocket(accessToken)
  }, [accessToken])

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

      // 认证类错误（access token 过期）：先尝试 refresh，refresh 成功后用新 token 重连；
      // 只有 refresh 也失败才真正 logout。
      // 这样服务器重启 / access token 过期场景下用户不会丢失会话。
      if (isAuthErrorMessage(err.message) && !isRefreshingRef.current) {
        isRefreshingRef.current = true
        try {
          const newToken = await refreshAccessToken()
          if (newToken) {
            // refresh 成功：accessToken 已更新到 store，
            // useMemo 会创建新 socket；这里主动断开旧 socket 让新 socket 重连
            console.log('[useSocket] token refreshed, reconnecting socket')
            socket.disconnect()
            // 当前 effect 会在 accessToken 变化后重新订阅新 socket
          } else {
            // refresh 失败：refresh token 也过期/无效，才真正登出
            console.warn('[useSocket] refresh failed, logging out')
            logout()
          }
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
