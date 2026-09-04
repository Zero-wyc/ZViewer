import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type UserRole = 'root' | 'admin' | 'user' | 'guest'

export interface User {
  id: string
  username: string
  role: UserRole
  status?: 'active' | 'pending'
  /** 头像 URL（相对路径，如 '/uploads/avatars/1-xxx.jpg'）。null 表示使用默认头像。 */
  avatar?: string | null
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
          // 注意：这里绝不能置为 'done'——调用方（AuthInitializer）随后会
          // 异步降级为 guest，此期间 RequireAuth 依赖 'idle' 持续等待；
          // 若提前置 'done'，RequireAuth 会立即把首访用户重定向到 /login，
          // 导致「带房间链接首次访问进不了房间，第二次才能进」。
          autoLoginStatus: 'idle',
          hasLoggedOut: false,
        }),
    }),
    {
      name: 'zcontrol-auth-storage',
      partialize: (state) => ({
        // 持久化 user / 认证状态 / 登出标记 / autoLoginStatus
        // autoLoginStatus 必须持久化：页面刷新后 useSocket 依赖它决定是否创建 socket，
        // 未持久化会导致刷新后 autoLoginStatus 重置为 'idle'，socket 不创建，应用无法使用
        // token 不再持久化（cookie 是真正的存储介质）
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        hasLoggedOut: state.hasLoggedOut,
        autoLoginStatus: state.autoLoginStatus,
      }),
    }
  )
)
