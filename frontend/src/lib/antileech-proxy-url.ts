import { getApiUrl } from './api'

export interface AntileechProxyUrlOptions {
  /** true 时即使无 headers 也强制包装（语义：明确走服务器中转） */
  force?: boolean
  /** true 时生成相对路径（dev 由 vite proxy 转发，避免绝对地址入库） */
  relative?: boolean
}

/**
 * 防盗链媒体代理 URL 统一构造（/api/stream/{module}/proxy 端点族）。
 *
 * 此前 kazumi/cms/anisubs/room-anime 四处各有一份逐字相同的实现：
 * 无 headers 且非 force 时原样返回；否则将 Referer/UA/Origin/Cookie
 * 编码进 query 交给后端代理转发。
 */
export function buildAntileechProxyUrl(
  module: string,
  url: string,
  headers?: Record<string, string>,
  opts: AntileechProxyUrlOptions = {}
): string {
  const { force = false, relative = false } = opts
  if (!force && (!headers || Object.keys(headers).length === 0)) return url
  const params = new URLSearchParams({ url })
  if (headers?.Referer) params.set('referer', headers.Referer)
  if (headers?.['User-Agent']) params.set('userAgent', headers['User-Agent'])
  if (headers?.Origin) params.set('origin', headers.Origin)
  if (headers?.Cookie) params.set('cookie', headers.Cookie)
  const base = relative ? '' : getApiUrl()
  return `${base}/api/stream/${module}/proxy?${params.toString()}`
}
