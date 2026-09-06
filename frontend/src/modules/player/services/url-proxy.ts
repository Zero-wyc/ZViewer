/**
 * URL 代理策略中心（分离式架构）。
 *
 * 将「是否走服务端代理」的决策从各播放引擎中分离出来，统一集中到本模块。
 * 引擎只调用 `resolveProxyUrl(url, headers, format)` 这一个入口，
 * 由本模块根据 URL 特征决定最终地址。
 *
 * 当前策略：
 * - B站 DASH m4s 流：走服务器代理（m4s 有防盗链 + 无 CORS，浏览器无法绕过）
 * - 带防盗链 headers 的源：走服务器代理（浏览器无法设置 forbidden header）
 * - 其他源（B站 MP4 直链 / webdav / ftp / 用户直链 / 服务器本地文件 / blob / data）：直连
 *   → 服务器零流量，仅承载信令与元数据
 *
 * 设计动机：
 * 旧版本中 `isBilibiliMediaUrl + buildProxyUrl` 逻辑分散在 direct-engine / dash-player，
 * 且只有 B站 一种代理场景。集中到本模块后，引擎只需调用 `resolveProxyUrl(url, headers, format)`，
 * 策略变更只改本文件。
 */

/**
 * 判断 URL 是否为 B站 CDN 媒体地址。
 *
 * 覆盖 B站 各类 CDN 域名：官方 bilivideo、P2P/mcdn、第三方边缘节点、akamaized 海外节点等。
 *
 * 注意：B站 URL 是否需要代理取决于请求方式：
 * - DASH m4s 流：有防盗链 + 无 CORS，必须走服务器代理
 * - MP4 直链（platform=html5 接口）：无防盗链，可直接播放
 * 调用方需结合 source.format 判断，本函数仅判断域名。
 */
export function isBilibiliMediaUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin)
    const host = u.hostname.toLowerCase()
    // 本站自身 API 与本地协议直接放行
    if (
      host === window.location.hostname ||
      u.protocol === 'blob:' ||
      u.protocol === 'data:'
    ) {
      return false
    }
    // 已知 B站 CDN/页面域名
    return /(?:bilibili|bilivideo|hdslb|mountaintoys|mcdn|upos|bstatic|akamaized|pili-video|boss-pgc)/i.test(
      host
    )
  } catch {
    return false
  }
}

/**
 * 判断 URL 是否为本站自身地址（API、blob、data 协议等），
 * 这些地址无需代理，直接由浏览器请求。
 */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin)
    if (u.protocol === 'blob:' || u.protocol === 'data:') return true
    return u.hostname.toLowerCase() === window.location.hostname.toLowerCase()
  } catch {
    return false
  }
}

/**
 * 判断 URL 是否为相对路径（如 /api/webdav/...），
 * 相对路径自动走本站后端，无需包装为代理 URL。
 */
export function isRelativeUrl(url: string): boolean {
  if (!url) return false
  return url.startsWith('/') && !url.startsWith('//')
}

/**
 * 判断 URL 是否为本地 CLI 代理地址（如 http://127.0.0.1:9333/proxy?url=...）。
 *
 * CLI 代理是跨域地址，不需要 credentials（Cookie），
 * 且 dash.js 的 setXHRWithCredentials 会导致 CORS 拒绝。
 */
export function isCliProxyUrl(url: string): boolean {
  if (!url) return false
  return url.startsWith('http://127.0.0.1:') && url.includes('/proxy?url=')
}

/** 从 localStorage 读取当前 access token（SSR / 非浏览器环境返回空串）。 */
function getStoredToken(): string {
  try {
    return localStorage.getItem('zviewer-access-token') || ''
  } catch {
    return ''
  }
}

/**
 * 为本站 /api/ 路径 URL（相对或绝对）附加 access token 查询参数。
 *
 * HTTP 环境下后端不写 auth cookie（浏览器禁止非 Secure cookie 场景），
 * 而 <video> / MSE / hls.js 等媒体请求无法设置 Authorization header，
 * 因此必须将 token 附加到 URL，后端 extractAccessToken 会优先从查询参数读取。
 * HTTPS 环境下 cookie 自动携带，附加 token 仅作冗余（两者任一生效即可）。
 *
 * 非 /api/ 路径、已带 token 参数或无 token 时原样返回。
 */
export function appendAuthToken(url: string): string {
  let hasQuery: boolean
  try {
    const u = new URL(url, window.location.origin)
    if (!u.pathname.startsWith('/api/')) return url
    if (u.searchParams.has('token')) return url
    hasQuery = !!u.search
  } catch {
    // 非法 URL，原样返回
    return url
  }
  const token = getStoredToken()
  if (!token) return url
  return `${url}${hasQuery ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * 将 URL 包装为后端代理 URL（相对路径）。
 * 后端代理会自动添加 Referer/User-Agent 头绕过防盗链，并透传 Range 请求支持断点续传。
 *
 * 使用相对路径确保 video 标签的请求通过 Nginx 代理转发到后端（同域请求携带 cookie）。
 *
 * 认证：hls.js 等场景无法设置 Authorization header，因此将 access token
 * 附加到查询参数中，后端 extractAccessToken 会优先从查询参数读取。
 */
export function buildProxyUrl(url: string): string {
  const token = getStoredToken()
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : ''
  return `/api/stream/proxy?url=${encodeURIComponent(url)}${tokenParam}`
}

/**
 * 统一代理策略：根据 URL 特征与源格式决定最终请求地址。
 *
 * 决策矩阵：
 * | URL 类型                | format=mp4            | format=dash / m4s    |
 * |------------------------|----------------------|---------------------|
 * | 本站 API / blob / data | 直连                  | 直连                |
 * | 相对路径（/api/...）     | 直连                  | 直连                |
 * | 带防盗链 headers        | 服务器代理             | 服务器代理           |
 * | B站 CDN URL            | 直连（HTML5 接口无防盗链）| 服务器代理（m4s 有防盗链）|
 * | 其他跨域 URL            | 直连                  | 直连                |
 *
 * 注意：format 已知时直接按 format 判断，不使用 URL 特征 fallback。
 * 避免 MP4 URL 中碰巧包含 /dash/ 或 .m4s 时被误判为 DASH 流走服务器代理。
 *
 * @param url 原始视频流 URL
 * @param headers 可选的防盗链 headers（由后端 resolve 返回）
 * @param format 源格式（'mp4' / 'dash' / 'm4s' / 'm3u8' / 'flv' 等），影响 B站 URL 代理决策
 * @returns 实际请求的 URL（原 URL 或代理 URL）
 */
export function resolveProxyUrl(
  url: string,
  headers?: Record<string, string>,
  format?: string
): string {
  if (!url) return url

  // 本站 URL / blob / data 协议：永不代理。
  // /api/ 路径需附加 token：HTTP 环境下无 auth cookie，
  // 媒体标签无法设置 Authorization header，必须通过查询参数认证。
  if (isLocalUrl(url)) return appendAuthToken(url)

  // 相对路径（/api/webdav/...）：自动走本站后端，同样附加 token
  if (isRelativeUrl(url)) return appendAuthToken(url)

  const hasHeaders = !!(headers && Object.keys(headers).length > 0)
  const isBili = isBilibiliMediaUrl(url)

  // 带防盗链 headers：浏览器无法设置 forbidden header，必须走服务器代理
  if (hasHeaders) {
    console.warn('[url-proxy] 走服务器代理(headers):', {
      url: url.slice(0, 80),
      format,
      hasHeaders,
    })
    return buildProxyUrl(url)
  }

  // B站 DASH m4s 流：有防盗链 + 无 CORS，必须走服务器代理
  if (isBili) {
    // format 已知时直接按 format 判断，不使用 URL 特征 fallback，
    // 避免 MP4 URL 中碰巧包含 /dash/ 或 .m4s 时被误判为 DASH 流走服务器代理。
    // 仅在 format 未知时 fallback 到 URL 特征判断。
    const isDashStream =
      format === 'dash' ||
      format === 'm4s' ||
      (!format &&
        (url.toLowerCase().includes('.m4s') ||
          url.toLowerCase().includes('/dash/')))

    if (isDashStream) {
      return buildProxyUrl(url)
    }
    // B站 MP4 直链（platform=html5 接口）：无防盗链，可直接播放
    // 服务器零流量
    return url
  }

  // 混合内容防护：https 页面下，浏览器会把 http 跨域资源强制升级为 https
  // 请求；对不支持 TLS 的源（如 NAS 的 http 端口）必然握手失败
  // （ERR_CONNECTION_CLOSED），白等一次直连超时只会拖慢起播。
  // 此时直接走服务器代理（后端转发，无协议限制）。
  if (window.location.protocol === 'https:') {
    try {
      if (new URL(url).protocol === 'http:') {
        console.warn(
          '[url-proxy] https 页面下的 http 跨域源会被浏览器强制升级而失败，走服务器代理:',
          url.slice(0, 80)
        )
        return buildProxyUrl(url)
      }
    } catch {
      /* 非法 URL，按原策略继续 */
    }
  }

  // 其他跨域 URL：直连源站，服务器零流量
  return url
}
