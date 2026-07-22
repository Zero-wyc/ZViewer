/**
 * URL 代理检测服务
 *
 * 从旧 msePlayer.ts 抽取的 B站 CDN 代理检测逻辑。
 * 浏览器无法设置 Referer/User-Agent 等 forbidden header，且 B站 CDN 不返回 CORS 头，
 * 因此所有 B站 CDN URL 必须走后端 /api/stream/proxy 代理。
 */
import { API_URL } from '@/lib/api'

/**
 * 判断 URL 是否为 B站 CDN 媒体地址（需要走后端代理）。
 *
 * 覆盖 B站 各类 CDN 域名：官方 bilivideo、P2P/mcdn、第三方边缘节点、akamaized 海外节点等。
 * 不在白名单内的 B站 CDN 也应走后端代理：
 *   1. 浏览器 fetch B站 CDN 不带 Access-Control-Allow-Origin，会被 CORS 拦截；
 *   2. 浏览器禁用 Referer/User-Agent 等头，无法绕过 B站防盗链。
 * 因此策略改为：非已知自有域名（本站 API、blob:、data:）一律走代理。
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
 * 将 B站 CDN URL 包装为后端代理 URL。
 * 后端代理会自动添加 Referer/User-Agent 头绕过防盗链，并透传 Range 请求支持断点续传。
 */
export function buildProxyUrl(url: string): string {
  return `${API_URL}/api/stream/proxy?url=${encodeURIComponent(url)}`
}
