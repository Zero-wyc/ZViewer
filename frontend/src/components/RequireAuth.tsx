import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore, type UserRole } from '@/store/authStore'

interface RequireAuthProps {
  children: React.ReactNode
  adminOnly?: boolean
  forbiddenRoles?: UserRole[]
}

export function RequireAuth({
  children,
  adminOnly = false,
  forbiddenRoles,
}: RequireAuthProps) {
  const { isAuthenticated, user, autoLoginStatus } = useAuthStore()
  const location = useLocation()

  if (!isAuthenticated && autoLoginStatus !== 'done') {
    return null
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (adminOnly && user?.role !== 'root' && user?.role !== 'admin') {
    return <Navigate to="/" state={{ from: location }} replace />
  }

  if (forbiddenRoles && user?.role && forbiddenRoles.includes(user.role)) {
    return <Navigate to="/" state={{ from: location }} replace />
  }

  return <>{children}</>
}
