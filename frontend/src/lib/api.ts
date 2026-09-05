/**
 * 统一 fetch 封装与后端地址配置中心。
 *
 * 关键能力：
 * 1. 自动 `credentials: 'include'`：让浏览器携带 httpOnly cookie（access_token / refresh_token）
 * 2. 401 自动 refresh + 重试：access token 过期时调用 /api/auth/refresh（也走 cookie），成功后重试原请求一次
 * 3. refresh 失败时返回原 401 响应，由调用方决定降级策略（如 AuthInitializer 降级为 guest）
 * 4. 支持用户自定义后端地址（覆盖环境变量），持久化在 localStorage
 *    - API_URL：REST API 基础地址
 *    - SOCKET_URL：WebRTC / 房间状态同步的 socket.io 信令地址
 *    - FLV_BASE_URL：HTTP-FLV 拉流基础地址
 *    - RTMP_PORT：OBS RTMP 推流端口
 *
 * 鉴权分离（见 lib/authTransport.ts）：
 * - HTTPS 场景 → httpOnly cookie（自动携带，本模块不读写 token）
 * - HTTP 场景 → Bearer token（token 存储与请求头装配在 authTransport 中实现）
 */
import {
  getRefreshToken,
  saveAuthTokens,
  buildAuthHeaders,
} from './authTransport'
export {
  isHttpsContext,
  getAccessToken,
  getRefreshToken,
  saveAuthTokens,
  clearAuthTokens,
  buildAuthHeaders,
} from './authTransport'

const CUSTOM_API_URL_KEY = 'zviewer-custom-api-url'
const CUSTOM_SOCKET_URL_KEY = 'zviewer-custom-socket-url'
const CUSTOM_FLV_BASE_URL_KEY = 'zviewer-custom-flv-base-url'
const CUSTOM_RTMP_PORT_KEY = 'zviewer-custom-rtmp-port'

function readStored(key: string): string | null {
  try {
    const v = localStorage.getItem(key)
    return v ? v.trim().replace(/\/$/, '') : null
  } catch {
    return null
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, '')
}

/**
 * 确保地址带有协议前缀（http:// 或 https://）。
 *
 * 用户在自定义后端地址输入框中可能只填写域名或域名:端口（如 example.com:3000），
 * 浏览器会把不含协议前缀的地址当作相对路径甚至非法 scheme 来解析：
 * - "example.com"        → 相对路径，请求实际发到当前 origin，自定义后端静默失效
 * - "example.com:3000"   → "example.com" 被当作 URL scheme，fetch 直接拒绝
 *
 * 此函数在保存/计算时自动补全 http:// 前缀，确保地址始终是合法的绝对 URL。
 * 以 "/" 开头的相对路径（如 FLV 的 /live）和空值不做处理。
 */
function ensureProtocol(url: string): string {
  if (!url) return url
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('/')) return url // 相对路径，不处理
  return `http://${url}`
}

const rawApiUrl = normalizeUrl(import.meta.env.VITE_API_URL || '')
const rawSocketUrl = normalizeUrl(import.meta.env.VITE_SOCKET_URL || '')
const rawFlvBaseUrl = normalizeUrl(import.meta.env.VITE_FLV_BASE_URL || '')
const rawRtmpPort = (import.meta.env.VITE_RTMP_PORT || '3334').toString()

/** 从 localStorage 实时读取自定义值，避免模块加载后取值陈旧 */
function getStored(key: string): string | null {
  return readStored(key)
}

function computeApiUrl(): string {
  return ensureProtocol(
    normalizeUrl(
      getStored(CUSTOM_API_URL_KEY) || rawApiUrl || window.location.origin
    )
  )
}

function computeSocketUrl(): string {
  return ensureProtocol(
    normalizeUrl(
      getStored(CUSTOM_SOCKET_URL_KEY) || rawSocketUrl || computeApiUrl()
    )
  )
}

function computeFlvBaseUrl(): string {
  // 统一端口后默认使用相对路径（即 /live），由后端反向代理到 NMS HTTP-FLV 端口，
  // 无需单独暴露 NMS 端口。仅当用户显式自定义或通过 VITE_FLV_BASE_URL 指定时才用绝对地址。
  return ensureProtocol(
    getStored(CUSTOM_FLV_BASE_URL_KEY) || rawFlvBaseUrl || ''
  )
}

function computeRtmpPort(): string {
  return getStored(CUSTOM_RTMP_PORT_KEY) || rawRtmpPort
}

/**
 * 当前生效的 REST API 地址（自定义 > 环境变量 > 当前页面 origin）。
 * 注意：此变量在模块加载时计算一次，后续通过 setCustomApiUrl 更新。
 * 如需确保获取最新值，请使用 getApiUrl() 函数。
 */
export let API_URL = computeApiUrl()

/**
 * 当前生效的 socket.io 信令地址。
 * 未单独设置时默认跟随 API_URL，保证大多数部署场景下无需额外配置。
 */
export let SOCKET_URL = computeSocketUrl()

/**
 * 当前生效的 HTTP-FLV 拉流基础地址。
 * 默认使用相对路径 ''（即 /live），由后端反向代理到 Node Media Server（HTTP_FLV_PORT）。
 * 统一端口后无需单独暴露 NMS 端口；如需独立子域名可显式设置。
 */
export let FLV_BASE_URL = computeFlvBaseUrl()

/** 当前生效的 RTMP 推流端口 */
export let RTMP_PORT = computeRtmpPort()

/** 实时获取当前生效的 REST API 地址（每次从 localStorage 读取，确保最新） */
export function getApiUrl(): string {
  return computeApiUrl()
}

/** 实时获取当前生效的 socket.io 地址（每次从 localStorage 读取，确保最新） */
export function getSocketUrl(): string {
  return computeSocketUrl()
}

/** 实时获取当前生效的 FLV 拉流基础地址 */
export function getFlvBaseUrl(): string {
  return computeFlvBaseUrl()
}

/** 实时获取当前生效的 RTMP 推流端口 */
export function getRtmpPort(): string {
  return computeRtmpPort()
}

/**
 * 实时获取 RTMP 推流主机名。
 * 优先从自定义 API 地址中提取主机名，未自定义时回退到当前页面 hostname。
 * 这样用户设置自定义后端地址后，OBS 推流地址会自动跟随变化。
 */
export function getRtmpHost(): string {
  const apiUrl = getApiUrl()
  try {
    const parsed = new URL(apiUrl)
    return parsed.hostname
  } catch {
    return window.location.hostname
  }
}

function setStored(key: string, value: string): void {
  try {
    if (value) {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // ignore
  }
}

/** 获取用户设置的自定义 API 地址（未设置返回空字符串） */
export function getCustomApiUrl(): string {
  return getStored(CUSTOM_API_URL_KEY) || ''
}

/** 设置自定义 API 地址；传入空字符串则清除自定义设置 */
export function setCustomApiUrl(url: string): void {
  const normalized = url ? ensureProtocol(normalizeUrl(url)) : ''
  setStored(CUSTOM_API_URL_KEY, normalized)
  API_URL = computeApiUrl()
  // 当 socket 未单独配置时，跟随 API 地址变化
  SOCKET_URL = computeSocketUrl()
}

/** 获取用户设置的自定义 socket.io 地址 */
export function getCustomSocketUrl(): string {
  return getStored(CUSTOM_SOCKET_URL_KEY) || ''
}

/** 设置自定义 socket.io 地址；传入空字符串则恢复默认（跟随 API_URL） */
export function setCustomSocketUrl(url: string): void {
  const normalized = url ? ensureProtocol(normalizeUrl(url)) : ''
  setStored(CUSTOM_SOCKET_URL_KEY, normalized)
  SOCKET_URL = computeSocketUrl()
}

/** 获取用户设置的自定义 FLV 拉流基础地址 */
export function getCustomFlvBaseUrl(): string {
  return getStored(CUSTOM_FLV_BASE_URL_KEY) || ''
}

/** 设置自定义 FLV 拉流基础地址；传入空字符串则恢复默认推断 */
export function setCustomFlvBaseUrl(url: string): void {
  const normalized = url ? ensureProtocol(normalizeUrl(url)) : ''
  setStored(CUSTOM_FLV_BASE_URL_KEY, normalized)
  FLV_BASE_URL = computeFlvBaseUrl()
}

/** 获取用户设置的自定义 RTMP 推流端口 */
export function getCustomRtmpPort(): string {
  return getStored(CUSTOM_RTMP_PORT_KEY) || ''
}

/** 设置自定义 RTMP 推流端口；传入空字符串则恢复默认 */
export function setCustomRtmpPort(port: string): void {
  const normalized = port ? port.toString().trim() : ''
  setStored(CUSTOM_RTMP_PORT_KEY, normalized)
  RTMP_PORT = computeRtmpPort()
}

type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>
  /** 内部使用：本次请求是否已重试过一次，避免无限循环 */
  _retried?: boolean
}

/**
 * 并发安全的 refresh token。
 * 多个请求同时遇到 401 时，只发起一次 /api/auth/refresh，其他请求复用结果。
 *
 * sessionExpired 标志：refresh 失败后置位，阻止后续请求反复尝试 refresh（级联失败）。
 * 重新登录或页面刷新后自动重置（模块重新加载）。
 *
 * 导出供播放器使用：媒体 URL（appendAuthToken）嵌入的 access token 过期导致
 * 引擎 attach 401/403 时，播放器可强制 refresh 后重试（媒体请求不走 apiFetch，
 * 无法享受其内置的自动 refresh 机制）。
 */
let inflightRefresh: Promise<boolean> | null = null
let sessionExpired = false

/** 重置 session 过期状态（登录成功后调用） */
export function resetSessionExpired(): void {
  sessionExpired = false
}

export async function refreshAccessToken(): Promise<boolean> {
  // session 已知过期 → 不再尝试 refresh，避免级联失败
  if (sessionExpired) return false
  if (inflightRefresh) return inflightRefresh

  inflightRefresh = (async () => {
    try {
      const refreshToken = getRefreshToken()
      const res = await fetch(`${getApiUrl()}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // 跨站 HTTP 场景 cookie 不可用，通过 body 携带 refresh token
        body: refreshToken ? JSON.stringify({ refreshToken }) : undefined,
      })

      // refresh 成功 → 后端已 set 新的 access_token cookie，下一次请求会自动带上
      if (res.ok) {
        const data = (await res.json()) as {
          success?: boolean
          accessToken?: string
          user?: unknown
        }
        if (data.success) {
          // 保存返回的 access token（跨站 HTTP fallback 用）
          if (data.accessToken) saveAuthTokens(data.accessToken)
          return true
        }
      }

      // refresh 接口明确拒绝（401/403）→ refresh token 也过期
      // 标记 session 已过期，阻止后续请求反复尝试 refresh
      sessionExpired = true
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
  // 每次实时从 localStorage 读取，确保自定义后端地址立即生效
  const currentApiUrl = getApiUrl()
  const url =
    typeof input === 'string' && input.startsWith('/')
      ? `${currentApiUrl}${input}`
      : input

  const res = await fetch(url, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(headers || {}),
      // 分离式鉴权：HTTPS 走 cookie（自动携带），HTTP 走 Bearer 头
      ...buildAuthHeaders(),
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
 * 安全解析 Response 的 JSON 体。
 * 当响应非 JSON（如 SPA 回退返回的 HTML、502 网关错误页等）时返回 fallback 而非抛异常。
 *
 * 典型用法：
 * ```ts
 * const data = await safeJson<{ success: boolean }>(res, { success: false })
 * if (data.success) { ... }
 * ```
 */
export async function safeJson<T>(res: Response, fallback: T): Promise<T> {
  try {
    return (await res.json()) as T
  } catch (err) {
    console.error('[safeJson] JSON parse failed:', err)
    return fallback
  }
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
