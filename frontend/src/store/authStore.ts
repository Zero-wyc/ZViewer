import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type UserRole = 'root' | 'admin' | 'user' | 'guest'

export interface User {
  id: string
  username: string
  role: UserRole
  status?: 'active' | 'pending'
}

export type AutoLoginStatus = 'idle' | 'pending' | 'done'

interface AuthState {
  /**
   * accessToken / refreshToken 字段已废弃 —— token 改由 httpOnly cookie 管理，
   * 前端无法读取也不再需要读取。保留这两个字段仅为兼容旧代码引用，永远是空字符串。
   * 后续清理可移除所有引用。
   */
  accessToken: string
  refreshToken: string
  user: User | null
  isAuthenticated: boolean
  autoLoginStatus: AutoLoginStatus
  /** 标记用户主动登出（用于 AuthInitializer 跳过 guest 自动登录等场景） */
  hasLoggedOut: boolean
  setUser: (user: User | null) => void
  /**
   * 登录成功后调用：写入 user 信息并标记为已认证。
   * 不再需要 token 参数（cookie 由后端 set，前端无感知）。
   */
  login: (user: User) => void
  /** 主动登出：清空 user 状态（cookie 由调用方调 /api/auth/logout 清除） */
  logout: () => void
  setAutoLoginStatus: (status: AutoLoginStatus) => void
  /** 会话过期（refresh 失败）：清空 user 状态 */
  expireSession: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: '',
      refreshToken: '',
      user: null,
      isAuthenticated: false,
      autoLoginStatus: 'idle',
      hasLoggedOut: false,
      setUser: (user) => set({ user, isAuthenticated: !!user }),
      login: (user) =>
        set({
          user,
          isAuthenticated: true,
          autoLoginStatus: 'done',
          hasLoggedOut: false,
        }),
      logout: () =>
        set({
          user: null,
          isAuthenticated: false,
          autoLoginStatus: 'done',
          hasLoggedOut: true,
        }),
      setAutoLoginStatus: (status) => set({ autoLoginStatus: status }),
      expireSession: () =>
        set({
          user: null,
          isAuthenticated: false,
          autoLoginStatus: 'done',
          hasLoggedOut: false,
        }),
    }),
    {
      name: 'zcontrol-auth-storage',
      partialize: (state) => ({
        // 只持久化 user / 认证状态 / 登出标记
        // token 不再持久化（cookie 是真正的存储介质）
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        hasLoggedOut: state.hasLoggedOut,
      }),
    }
  )
)
