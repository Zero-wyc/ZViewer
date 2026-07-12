import { useEffect, useRef } from 'react'
import {
  Routes,
  Route,
  Navigate,
  useParams,
  useLocation,
} from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { ThemeProvider } from '@/components/ThemeProvider'
import { RequireAuth } from '@/components/RequireAuth'
import { useAuthStore, type User } from '@/store/authStore'
import HomePage from '@/pages/HomePage'
import LoginPage from '@/pages/LoginPage'
import RoomPage from '@/modules/room/RoomPage'
import AdminPage from '@/pages/AdminPage'
import ProfilePage from '@/pages/ProfilePage'
import RoomsListPage from '@/pages/RoomsListPage'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

function AuthInitializer() {
  const {
    accessToken,
    refreshToken,
    expireSession,
    setUser,
    login,
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
          login(data.accessToken, data.refreshToken || '', {
            id: data.user.id,
            username: data.user.username,
            role: data.user.role as User['role'],
            status: data.user.status,
          })
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
        if (!res.ok && isAuthFailure(res.status)) {
          expireSession()
          void fetchGuestToken()
          return
        }
      } catch (err) {
        console.warn('[AuthInitializer] validate network error:', err)
        if (attempts < MAX_RETRIES) {
          retryTimerRef.current = setTimeout(validate, 2000)
        }
        return
      }

      if (!refreshToken) {
        expireSession()
        void fetchGuestToken()
        return
      }

      try {
        const res = await fetch(`${API_URL}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
        const data = (await res.json()) as {
          success: boolean
          accessToken?: string
          user?: {
            id: string
            username: string
            role: string
            status?: 'active' | 'pending'
          }
        }
        if (res.ok && data.success && data.accessToken && data.user) {
          login(data.accessToken, refreshToken, {
            id: data.user.id,
            username: data.user.username,
            role: data.user.role as User['role'],
            status: data.user.status,
          })
        } else if (!res.ok && isAuthFailure(res.status)) {
          expireSession()
          void fetchGuestToken()
        } else if (data.success === false) {
          expireSession()
          void fetchGuestToken()
        }
      } catch (err) {
        console.warn('[AuthInitializer] refresh network error:', err)
        if (attempts < MAX_RETRIES) {
          retryTimerRef.current = setTimeout(validate, 2000)
        }
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
  }, [
    accessToken,
    refreshToken,
    login,
    expireSession,
    setUser,
    autoLoginStatus,
    setAutoLoginStatus,
  ])

  return null
}

function ShareRedirect() {
  const { roomId } = useParams<{ roomId?: string }>()
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  params.set('role', 'host')
  return <Navigate to={`/room/${roomId ?? ''}?${params.toString()}`} replace />
}

function WatchRedirect() {
  const { roomId } = useParams<{ roomId?: string }>()
  const { search } = useLocation()
  return <Navigate to={`/room/${roomId ?? ''}${search}`} replace />
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
        </Routes>
      </ThemeProvider>
    </Layout>
  )
}

export default App
