import { useEffect, useMemo, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useAuthStore } from '@/store/authStore'

// 生产环境通过 Nginx 反向代理，默认使用当前域名即可；
// 开发环境可通过 .env 文件设置 VITE_API_URL=http://localhost:3000
const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const SERVER_URL = rawApiUrl || window.location.origin

function isAuthError(message: string): boolean {
  return (
    message.includes('未提供认证令牌') ||
    message.includes('认证令牌无效') ||
    message.includes('authentication') ||
    message.includes('token') ||
    message.includes('unauthorized') ||
    message.includes('not authenticated')
  )
}

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
  const { accessToken, logout } = useAuthStore()

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
    setConnected(socket.connected)

    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    const onConnectError = (err: Error) => {
      console.error('[useSocket] connection error:', err.message)
      if (isAuthError(err.message)) {
        console.warn('Socket 认证失败，请重新登录')
        logout()
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
