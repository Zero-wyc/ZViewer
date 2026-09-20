import { useEffect, useRef } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { ThemeProvider } from '@/components/ThemeProvider'
import { RequireAuth } from '@/components/RequireAuth'
import { useAuthStore, type User } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { apiFetch, resetSessionExpired, saveAuthTokens } from '@/lib/api'
import { reconnectSocket } from '@/hooks/useSocket'
import { useBackendHealth } from '@/hooks/useBackendHealth'
import { ReturnToRoomButton } from '@/components/ReturnToRoomButton'
import HomePage from '@/pages/HomePage'
import LoginPage from '@/pages/LoginPage'
import RoomPage from '@/modules/room/RoomPage'
import AdminPage from '@/pages/AdminPage'
import ProfilePage from '@/pages/ProfilePage'
import RoomsListPage from '@/pages/RoomsListPage'
import JoinByRoomIdPage from '@/pages/JoinByRoomIdPage'

function AuthInitializer() {
  const setUser = useAuthStore((s) => s.setUser)
  const setAutoLoginStatus = useAuthStore((s) => s.setAutoLoginStatus)
  const markAuthResolved = useAuthStore((s) => s.markAuthResolved)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const MAX_RETRIES = 8
    let attempts = 0
    // 记录挂载时的用户 ID，用于区分"持久化的过期会话"和"验证期间的手动登录"
    const userIdAtMount = useAuthStore.getState().user?.id

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }

    /**
     * 拉取匿名 guest token 并设置 user。
     * 无论用户之前是否登出，guest 是默认降级身份，始终可用。
     *
     * 网络错误 / 5xx / 429 时自动重试（最多 3 次尝试）：首访用户点开房间
     * 链接时常撞上后端恰好重启/短暂不可达，若一次失败就放弃，RequireAuth
     * 会拿到终态并把用户弹去 /login——表现为「房间链接要输两次地址才能进」。
     */
    const fetchGuestToken = async () => {
      // 竞态条件保护：如果用户在此期间已手动登录，不要用 guest 覆盖
      const { isAuthenticated } = useAuthStore.getState()
      if (isAuthenticated) {
        setAutoLoginStatus('done')
        markAuthResolved()
        return
      }

      const MAX_GUEST_ATTEMPTS = 3
      for (let attempt = 1; attempt <= MAX_GUEST_ATTEMPTS; attempt++) {
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
              avatar?: string | null
            }
            accessToken?: string
          }

          // 再次检查：网络请求期间用户可能已手动登录
          const { isAuthenticated: nowAuthed } = useAuthStore.getState()
          if (nowAuthed) {
            setAutoLoginStatus('done')
            markAuthResolved()
            return
          }

          if (res.ok && data.success && data.user) {
            // 保存 guest token（跨站 HTTP 场景 cookie 不可用时 fallback 到 Bearer 头）
            if (data.accessToken) saveAuthTokens(data.accessToken)
            // guest token 获取成功 → 重置 session 过期标志
            resetSessionExpired()
            setUser({
              id: data.user.id,
              username: data.user.username,
              role: data.user.role as User['role'],
              status: data.user.status,
              avatar: data.user.avatar,
            })
            // guest token 是新凭据，socket 需要断开重连以重新握手
            reconnectSocket()
            break
          }

          // 明确的业务失败（4xx 非 429 / success:false）：重试大概率同样失败，
          // 但 429（限流）/5xx（后端异常）值得等一拍再试
          const retryable = res.status === 429 || res.status >= 500
          if (!retryable || attempt >= MAX_GUEST_ATTEMPTS) break
        } catch (err) {
          console.warn(
            `[AuthInitializer] guest token fetch failed (attempt ${attempt}/${MAX_GUEST_ATTEMPTS}):`,
            err
          )
          if (attempt >= MAX_GUEST_ATTEMPTS) break
        }
        // 重试间隔：1.5s 逐次退避
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      }

      // 无论成功失败都标记为 done，避免 UI 永久卡在"正在校验登录状态"
      setAutoLoginStatus('done')
      markAuthResolved()
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
            avatar?: string | null
          }
        }
        if (res.ok && data.success && data.user) {
          setUser({
            id: data.user.id,
            username: data.user.username,
            role: data.user.role as User['role'],
            status: data.user.status,
            avatar: data.user.avatar,
          })
          setAutoLoginStatus('done')
          markAuthResolved()
          return
        }

        // 会话验证失败（401/403/500 等）
        // 检查是否为"验证期间手动登录"的竞态条件
        const userIdNow = useAuthStore.getState().user?.id
        if (userIdNow !== userIdAtMount) {
          // 用户 ID 已变化 → 手动登录发生，不要覆盖
          setAutoLoginStatus('done')
          markAuthResolved()
          return
        }
        // 用户 ID 未变 → 持久化的会话已过期，清除过期状态后降级为 guest
        // （guest 降级由 fetchGuestToken 在终态处 markAuthResolved）
        useAuthStore.getState().expireSession()
        void fetchGuestToken()
        return
      } catch (err) {
        console.warn('[AuthInitializer] validate network error:', err)
        // 网络错误（服务器重启中）→ 重试，重试耗尽后降级为 guest
        if (attempts < MAX_RETRIES) {
          retryTimerRef.current = setTimeout(validate, 2000)
        } else {
          // 重试耗尽：同样检查竞态条件
          const userIdNow = useAuthStore.getState().user?.id
          if (userIdNow !== userIdAtMount) {
            setAutoLoginStatus('done')
            markAuthResolved()
            return
          }
          useAuthStore.getState().expireSession()
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
  // 监听后端自动重启：socket 重连后对比 /health.startedAt，变化时在网页内提示
  useBackendHealth()

  // 启动时拉取公开系统设置（registrationMode / roomCreationMode / betaFeaturesEnabled）。
  // 此接口无需鉴权，guest 也可访问；用于 HomePage 决定是否显示「开始共享」按钮。
  const fetchSettings = useSystemSettingsStore((s) => s.fetchSettings)
  useEffect(() => {
    void fetchSettings()
  }, [fetchSettings])

  return (
    <Layout>
      <ThemeProvider>
        <AuthInitializer />
        <ReturnToRoomButton />
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
