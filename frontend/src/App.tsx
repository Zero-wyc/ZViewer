import { useEffect, useRef } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { ThemeProvider } from '@/components/ThemeProvider'
import { RequireAuth } from '@/components/RequireAuth'
import { useAuthStore, type User } from '@/store/authStore'
import { refreshAccessToken } from '@/lib/tokenRefresh'
import HomePage from '@/pages/HomePage'
import LoginPage from '@/pages/LoginPage'
import RoomPage from '@/modules/room/RoomPage'
import AdminPage from '@/pages/AdminPage'
import ProfilePage from '@/pages/ProfilePage'
import RoomsListPage from '@/pages/RoomsListPage'
import JoinByRoomIdPage from '@/pages/JoinByRoomIdPage'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

function AuthInitializer() {
  const {
    accessToken,
    expireSession,
    setUser,
    autoLoginStatus,
    setAutoLoginStatus,
  } = useAuthStore()
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const isAuthFailure = (status: number) => status === 401 || status === 403
    const MAX_RETRIES = 8
    let attempts = 0

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }

    const fetchGuestToken = async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/guest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
        const data = (await res.json()) as {
          success: boolean
          accessToken?: string
          refreshToken?: string
          user?: {
            id: string
            username: string
            role: string
            status?: 'active' | 'pending'
          }
        }
        if (res.ok && data.success && data.accessToken && data.user) {
          // 注意：guest 不需要持久化登录，直接 setUser + setTokens 即可。
          // 这里复用 login 把 autoLoginStatus 置为 'done'，避免重复触发。
          const { setTokens } = useAuthStore.getState()
          setTokens(data.accessToken, data.refreshToken || '')
          setUser({
            id: data.user.id,
            username: data.user.username,
            role: data.user.role as User['role'],
            status: data.user.status,
          })
          setAutoLoginStatus('done')
        } else {
          setAutoLoginStatus('done')
        }
      } catch (err) {
        console.warn('[AuthInitializer] guest token fetch failed:', err)
        setAutoLoginStatus('done')
      }
    }

    const validate = async () => {
      clearRetryTimer()
      attempts += 1

      try {
        const res = await fetch(`${API_URL}/api/auth/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        const data = (await res.json()) as {
          success: boolean
          user?: {
            id: string
            username: string
            role: string
            status?: 'active' | 'pending'
          }
        }
        if (res.ok && data.success && data.user) {
          setUser({
            id: data.user.id,
            username: data.user.username,
            role: data.user.role as User['role'],
            status: data.user.status,
          })
          return
        }
        // access token 过期/无效（401/403）：尝试 refresh，不直接 expireSession
        if (!res.ok && isAuthFailure(res.status)) {
          const newToken = await refreshAccessToken()
          if (newToken) {
            // refresh 成功 → 用新 token 再验证一次用户信息
            try {
              const retryRes = await fetch(`${API_URL}/api/auth/me`, {
                headers: { Authorization: `Bearer ${newToken}` },
              })
              const retryData = (await retryRes.json()) as {
                success: boolean
                user?: {
                  id: string
                  username: string
                  role: string
                  status?: 'active' | 'pending'
                }
              }
              if (retryRes.ok && retryData.success && retryData.user) {
                setUser({
                  id: retryData.user.id,
                  username: retryData.user.username,
                  role: retryData.user.role as User['role'],
                  status: retryData.user.status,
                })
              }
            } catch {
              // refresh 后 /auth/me 网络失败：不登出，等待下次重试
            }
          } else {
            // refresh 也失败：refresh token 过期/无效，才真正登出
            expireSession()
            void fetchGuestToken()
          }
          return
        }
      } catch (err) {
        console.warn('[AuthInitializer] validate network error:', err)
        // 网络错误（服务器重启中）→ 不 expireSession，等待重试
        if (attempts < MAX_RETRIES) {
          retryTimerRef.current = setTimeout(validate, 2000)
        }
        return
      }
    }

    if (!accessToken) {
      if (autoLoginStatus !== 'pending') {
        void fetchGuestToken()
      }
      return () => {
        clearRetryTimer()
      }
    }

    void validate()

    return () => {
      clearRetryTimer()
    }
  }, [accessToken, expireSession, setUser, autoLoginStatus, setAutoLoginStatus])

  return null
}

function ShareRedirect() {
  // 旧链接 /share/:roomId 兼容：直接跳转到 /room/:roomId（不带任何参数）
  // 房主身份由 sessionStorage 标记判断，URL 保持干净
  const { roomId } = useParams<{ roomId?: string }>()
  return <Navigate to={`/room/${roomId ?? ''}`} replace />
}

function WatchRedirect() {
  // 旧链接 /watch/:roomId 兼容：直接跳转到 /room/:roomId
  const { roomId } = useParams<{ roomId?: string }>()
  return <Navigate to={`/room/${roomId ?? ''}`} replace />
}

function App() {
  return (
    <Layout>
      <ThemeProvider>
        <AuthInitializer />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/room/:roomId?"
            element={
              <RequireAuth>
                <RoomPage />
              </RequireAuth>
            }
          />
          <Route path="/share/:roomId?" element={<ShareRedirect />} />
          <Route path="/watch/:roomId?" element={<WatchRedirect />} />
          <Route path="/direct-share" element={<Navigate to="/" replace />} />
          <Route path="/direct-watch" element={<Navigate to="/" replace />} />
          <Route
            path="/admin"
            element={
              <RequireAuth adminOnly>
                <AdminPage />
              </RequireAuth>
            }
          />
          <Route
            path="/profile"
            element={
              <RequireAuth forbiddenRoles={['guest']}>
                <ProfilePage />
              </RequireAuth>
            }
          />
          <Route
            path="/rooms"
            element={
              <RequireAuth>
                <RoomsListPage />
              </RequireAuth>
            }
          />
          <Route
            path="/join"
            element={
              <RequireAuth>
                <JoinByRoomIdPage />
              </RequireAuth>
            }
          />
        </Routes>
      </ThemeProvider>
    </Layout>
  )
}

export default App
