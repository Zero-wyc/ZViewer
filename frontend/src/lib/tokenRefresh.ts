import { useAuthStore } from '@/store/authStore'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

interface RefreshResponse {
  success: boolean
  accessToken?: string
  user?: {
    id: string
    username: string
    role: string
    status?: 'active' | 'pending'
  }
}

/**
 * 并发安全的 refresh token 工具。
 *
 * 多个调用方（App.tsx AuthInitializer / useSocket connect_error / API 拦截器）
 * 可能同时检测到 access token 过期并发起 refresh。
 * 用单例 Promise 保证同一时刻只有一个 /api/auth/refresh 请求在飞，
 * 所有调用方共享同一次结果。
 */
let inflightRefresh: Promise<string | null> | null = null

export async function refreshAccessToken(): Promise<string | null> {
  // 同一时刻只发起一次 refresh，其他调用方复用结果
  if (inflightRefresh) {
    return inflightRefresh
  }

  inflightRefresh = (async () => {
    const { refreshToken, login, expireSession } = useAuthStore.getState()

    if (!refreshToken) {
      return null
    }

    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })

      const data = (await res.json()) as RefreshResponse

      if (res.ok && data.success && data.accessToken && data.user) {
        // 用新 accessToken + 原 refreshToken 更新 store
        login(data.accessToken, refreshToken, {
          id: data.user.id,
          username: data.user.username,
          role: data.user.role as 'root' | 'admin' | 'user' | 'guest',
          status: data.user.status,
        })
        return data.accessToken
      }

      // refresh 接口明确失败（refresh token 过期/无效）→ 清空会话
      if (!res.ok && (res.status === 401 || res.status === 403)) {
        expireSession()
      }
      return null
    } catch {
      // 网络错误（服务器重启中）→ 不清空会话，让调用方决定重试
      return null
    } finally {
      inflightRefresh = null
    }
  })()

  return inflightRefresh
}

/**
 * 判断错误消息是否为认证类错误（access token 过期/无效）。
 * 此时应尝试 refresh；refresh 失败才真正登出。
 */
export function isAuthErrorMessage(message: string): boolean {
  return (
    message.includes('未提供认证令牌') ||
    message.includes('认证令牌无效') ||
    message.includes('认证令牌已过期') ||
    message.includes('authentication') ||
    message.includes('token') ||
    message.includes('unauthorized') ||
    message.includes('not authenticated')
  )
}
