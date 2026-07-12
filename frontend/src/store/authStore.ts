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
  accessToken: string
  refreshToken: string
  user: User | null
  isAuthenticated: boolean
  autoLoginStatus: AutoLoginStatus
  hasLoggedOut: boolean
  setTokens: (accessToken: string, refreshToken?: string) => void
  setUser: (user: User | null) => void
  login: (accessToken: string, refreshToken: string, user: User) => void
  logout: () => void
  refreshAccessToken: (token: string) => void
  setAutoLoginStatus: (status: AutoLoginStatus) => void
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
      setTokens: (accessToken, refreshToken = '') =>
        set({ accessToken, refreshToken }),
      setUser: (user) => set({ user, isAuthenticated: !!user }),
      login: (accessToken, refreshToken, user) =>
        set({
          accessToken,
          refreshToken,
          user,
          isAuthenticated: true,
          autoLoginStatus: 'done',
          hasLoggedOut: false,
        }),
      logout: () =>
        set({
          accessToken: '',
          refreshToken: '',
          user: null,
          isAuthenticated: false,
          autoLoginStatus: 'done',
          hasLoggedOut: true,
        }),
      refreshAccessToken: (token) => set({ accessToken: token }),
      setAutoLoginStatus: (status) => set({ autoLoginStatus: status }),
      expireSession: () =>
        set({
          accessToken: '',
          refreshToken: '',
          user: null,
          isAuthenticated: false,
          autoLoginStatus: 'done',
          hasLoggedOut: false,
        }),
    }),
    {
      name: 'zcontrol-auth-storage',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        hasLoggedOut: state.hasLoggedOut,
      }),
    }
  )
)
