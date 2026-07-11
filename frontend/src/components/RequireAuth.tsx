import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'

interface RequireAuthProps {
  children: React.ReactNode
  adminOnly?: boolean
}

export function RequireAuth({ children, adminOnly = false }: RequireAuthProps) {
  const { isAuthenticated, user, autoLoginStatus } = useAuthStore()
  const location = useLocation()

  if (!isAuthenticated && autoLoginStatus !== 'done') {
    return null
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (adminOnly && user?.role !== 'admin') {
    return <Navigate to="/" state={{ from: location }} replace />
  }

  return <>{children}</>
}
