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
 * 默认使用相对路径 ''（即 /live），由后端反向代理到媒体服务（默认进程内，HTTP_FLV_PORT）。
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
 * sessionExpired 标志：refresh 明确返回 401/403 后置位，阻止无效会话反复续签。
 * 临时服务错误和限流保持可重试，由调用方控制重试次数。
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

      // 只有认证被明确拒绝才停止续签；502/503/429 等临时失败允许上层重试。
      if (res.status === 401 || res.status === 403) sessionExpired = true
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

/** 游客身份信息（与后端 /api/auth/guest 的 user 字段一致） */
export interface GuestIdentity {
  id: string
  username: string
  role: string
  status?: 'active' | 'pending'
  avatar?: string | null
}

export interface GuestSession {
  accessToken?: string
  refreshToken?: string
  user: GuestIdentity
}

/**
 * 申请游客身份失败后的冷却时间。
 *
 * 这不是「防抖」而是「防风暴」：`useSocket` 的 connect_error 每个连接实例都会
 * 触发一次降级，多个 socket（主连接 + 语音连接）叠加时，一次握手失败就能在
 * 几百毫秒内打出十几次 /api/auth/guest。真出问题时（后端不可达 / 令牌始终被拒）
 * 这个循环会一直持续，既刷日志也白白签发成千上万个游客账号。
 *
 * 冷却期内直接返回 null，由调用方的退避（socket.io 自身的重连间隔）接管。
 */
const GUEST_RETRY_COOLDOWN_MS = 10_000

let inflightGuestSession: Promise<GuestSession | null> | null = null
let guestCooldownUntil = 0

/**
 * 申请游客身份（并发安全 + 失败冷却）。
 *
 * 1. 并发去重：同一时刻只发一次请求，其余调用复用同一个 Promise。
 * 2. 成功时**同时保存 refresh token**——只存 access token 会让游客 1 小时后
 *    无法续签（/api/auth/refresh 必然 403），只能再申请一个新游客。
 * 3. 失败后冷却 `GUEST_RETRY_COOLDOWN_MS`，force=true 可跳过冷却（首屏引导用）。
 */
export async function ensureGuestSession(
  force = false
): Promise<GuestSession | null> {
  if (inflightGuestSession) return inflightGuestSession
  if (!force && Date.now() < guestCooldownUntil) return null

  inflightGuestSession = (async () => {
    try {
      const res = await apiFetch('/api/auth/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        guestCooldownUntil = Date.now() + GUEST_RETRY_COOLDOWN_MS
        return null
      }
      const data = (await res.json()) as {
        success?: boolean
        user?: GuestIdentity
        accessToken?: string
        refreshToken?: string
      }
      if (!data.success || !data.user) {
        guestCooldownUntil = Date.now() + GUEST_RETRY_COOLDOWN_MS
        return null
      }
      if (data.accessToken) {
        saveAuthTokens(data.accessToken, data.refreshToken)
      }
      // 新凭据到手 → 允许下次 401 再走一遍 refresh
      resetSessionExpired()
      guestCooldownUntil = 0
      return {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        user: data.user,
      }
    } catch {
      guestCooldownUntil = Date.now() + GUEST_RETRY_COOLDOWN_MS
      return null
    } finally {
      inflightGuestSession = null
    }
  })()

  return inflightGuestSession
}

/**
 * 统一 API fetch。返回值与原生 fetch 一致（Response）。
 * 业务调用方仍需自行 res.json() / res.ok 判断，但无需关心 token 与 refresh。
 */ export async function apiFetch(
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
    // 反向代理（如 LuCI 的 _rp_login 反代）会给同源响应强行加
    // Cache-Control: private, max-age=3600 之类的缓存头，覆盖后端下发的 no-store，
    // 导致浏览器把 API 结果缓存一小时；API 响应永不复用，默认绕过 HTTP 缓存
    // （调用方仍可通过 options.cache 覆盖）。
    cache: 'no-store',
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
