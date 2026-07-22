import { useEffect, useRef } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { ThemeProvider } from '@/components/ThemeProvider'
import { RequireAuth } from '@/components/RequireAuth'
import { useAuthStore, type User } from '@/store/authStore'
import { apiFetch } from '@/lib/api'
import HomePage from '@/pages/HomePage'
import LoginPage from '@/pages/LoginPage'
import RoomPage from '@/modules/room/RoomPage'
import AdminPage from '@/pages/AdminPage'
import ProfilePage from '@/pages/ProfilePage'
import RoomsListPage from '@/pages/RoomsListPage'
import JoinByRoomIdPage from '@/pages/JoinByRoomIdPage'

function AuthInitializer() {
  const { setUser, setAutoLoginStatus } = useAuthStore()
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const MAX_RETRIES = 8
    let attempts = 0

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }

    /**
     * 拉取匿名 guest token 并设置 user。
     * 无论用户之前是否登出，guest 是默认降级身份，始终可用。
     */
    const fetchGuestToken = async () => {
      try {
        const res = await apiFetch('/api/auth/guest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        }
      } catch (err) {
        console.warn('[AuthInitializer] guest token fetch failed:', err)
      } finally {
        // 无论成功失败都标记为 done，避免 UI 永久卡在"正在校验登录状态"
        setAutoLoginStatus('done')
      }
    }

    /**
     * 调用 /api/auth/me 验证当前会话。
     * apiFetch 内部会在 401 时自动调 /api/auth/refresh，refresh 成功后自动重试原请求。
     * 所以这里只要 res.ok 即可视为会话有效。
     */
    const validate = async () => {
      clearRetryTimer()
      attempts += 1

      try {
        const res = await apiFetch('/api/auth/me')
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
          setAutoLoginStatus('done')
          return
        }

        // 任何非成功响应（401/403/500 等）→ 降级为 guest
        // 注意：apiFetch 内部可能已经调过 expireSession，这里不重复调用
        void fetchGuestToken()
        return
      } catch (err) {
        console.warn('[AuthInitializer] validate network error:', err)
        // 网络错误（服务器重启中）→ 重试，重试耗尽后降级为 guest
        if (attempts < MAX_RETRIES) {
          retryTimerRef.current = setTimeout(validate, 2000)
        } else {
          void fetchGuestToken()
        }
        return
      }
    }

    // 应用启动时：始终尝试 /auth/me（cookie 自动带上）。
    // 有 access_token cookie 且未过期 → 恢复登录
    // access_token 过期但 refresh_token 有效 → apiFetch 自动 refresh 后重试
    // 都没有 → 降级为 guest
    // 注意：不再检查 hasLoggedOut —— guest 是默认匿名身份，即使登出后也应自动降级
    void validate()

    return () => {
      clearRetryTimer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
