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
  const { isAuthenticated, user, authResolved } = useAuthStore()
  const location = useLocation()

  // 引导校验（AuthInitializer 首轮 /auth/me → 失败降级 guest）没有终态前，
  // 一律原地等待渲染 null，绝不重定向。
  // 注意：这里不能再用持久化的 autoLoginStatus 判断——它是「上一次页面
  // 生命周期」的状态（如登出后的残留 'done'），信任它会把未认证的首访
  // 立刻弹去 /login，导致「房间链接要输两次地址才能进」（1679ea4 同根因）。
  if (!isAuthenticated && !authResolved) {
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
