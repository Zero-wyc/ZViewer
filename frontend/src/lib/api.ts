/**
 * 统一 fetch 封装。
 *
 * 关键能力：
 * 1. 自动 `credentials: 'include'`：让浏览器携带 httpOnly cookie（access_token / refresh_token）
 * 2. 401 自动 refresh + 重试：access token 过期时调用 /api/auth/refresh（也走 cookie），成功后重试原请求一次
 * 3. refresh 失败时返回原 401 响应，由调用方决定降级策略（如 AuthInitializer 降级为 guest）
 *
 * 业务代码不再需要手动拼 Authorization header，也不需要从 authStore 取 accessToken。
 */

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
export const API_URL = rawApiUrl || window.location.origin

type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>
  /** 内部使用：本次请求是否已重试过一次，避免无限循环 */
  _retried?: boolean
}

/**
 * 并发安全的 refresh token。
 * 多个请求同时遇到 401 时，只发起一次 /api/auth/refresh，其他请求复用结果。
 */
let inflightRefresh: Promise<boolean> | null = null

async function refreshAccessToken(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh

  inflightRefresh = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })

      // refresh 成功 → 后端已 set 新的 access_token cookie，下一次请求会自动带上
      if (res.ok) {
        const data = (await res.json()) as { success?: boolean; user?: unknown }
        // refresh 接口成功但不返回 user（旧版兼容）→ 信任 cookie 已更新
        if (data.success) {
          return true
        }
      }

      // refresh 接口明确拒绝（401/403）→ refresh token 也过期
      // 不在这里调用 expireSession() —— 让调用方（validate / useSocket）统一处理降级
      // 避免提前设置 autoLoginStatus: 'done' 导致 UI 闪烁
      return false
    } catch {
      // 网络错误（服务器重启中）→ 不登出，让上层重试
      return false
    } finally {
      inflightRefresh = null
    }
  })()

  return inflightRefresh
}

/**
 * 统一 API fetch。返回值与原生 fetch 一致（Response）。
 * 业务调用方仍需自行 res.json() / res.ok 判断，但无需关心 token 与 refresh。
 */
export async function apiFetch(
  input: string | URL,
  options: RequestOptions = {}
): Promise<Response> {
  const { _retried, headers, ...rest } = options

  // 拼接完整 URL（如果 input 是相对路径如 /api/xxx）
  const url =
    typeof input === 'string' && input.startsWith('/')
      ? `${API_URL}${input}`
      : input

  const res = await fetch(url, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(headers || {}),
    },
  })

  // 401/403：access token 过期或无效 → 尝试 refresh，成功后重试一次
  if ((res.status === 401 || res.status === 403) && !_retried) {
    const ok = await refreshAccessToken()
    if (ok) {
      // 重试原请求，标记 _retried 避免再次进入 refresh 分支
      return apiFetch(input, { ...options, _retried: true })
    }
    // refresh 失败 → 直接返回原 401/403 响应，让业务层处理
  }

  return res
}

/**
 * 便捷方法：发起 GET 请求并解析 JSON。
 * 业务层典型用法：`const { data, ok } = await apiGet<MyType>('/api/xxx')`
 */
export async function apiGet<T = unknown>(
  url: string,
  options?: RequestOptions
): Promise<{
  data: T | null
  ok: boolean
  status: number
  response: Response
}> {
  const res = await apiFetch(url, { ...options, method: 'GET' })
  let data: T | null = null
  try {
    data = (await res.json()) as T
  } catch {
    // 非 JSON 响应（如 204 No Content）
  }
  return { data, ok: res.ok, status: res.status, response: res }
}

/**
 * 便捷方法：发起 POST 请求并解析 JSON。
 */
export async function apiPost<T = unknown>(
  url: string,
  body?: unknown,
  options?: RequestOptions
): Promise<{
  data: T | null
  ok: boolean
  status: number
  response: Response
}> {
  const res = await apiFetch(url, {
    ...options,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: T | null = null
  try {
    data = (await res.json()) as T
  } catch {
    // 非 JSON 响应
  }
  return { data, ok: res.ok, status: res.status, response: res }
}
