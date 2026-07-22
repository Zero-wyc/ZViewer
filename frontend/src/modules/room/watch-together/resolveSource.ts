import type { ResolvedSource } from '@/modules/bilibili/types'
import type { MediaFormat } from '@/lib/mediaFormat'
import { apiFetch, API_URL } from '@/lib/api'

// Bilibili 模块化后的 re-export：保持向后兼容
// 类型与解析偏好
export type {
  QualityOption,
  ResolvedSource,
  BilibiliQrData,
  BilibiliUserInfo,
  ResolveProgressLine,
  BilibiliCodec,
  BilibiliParseOptions,
} from '@/modules/bilibili/types'
export {
  getBilibiliParseOptions,
  setBilibiliParseOptions,
  codecToFnval,
  BILIBILI_CDN_OPTIONS,
  type BilibiliCdnOption,
} from '@/modules/bilibili/parseOptions'
// Bilibili API 函数
export {
  resolveBilibili,
  resolveBilibiliWithOptions,
  getBilibiliUserInfo,
  getBilibiliQrCode,
  pollBilibiliQrCode,
  getBilibiliLoginStatus,
  logoutBilibili,
} from '@/modules/bilibili/bilibiliApi'

export interface FTPParams {
  serverUrl: string
  path: string
  port?: number
  username?: string
  password?: string
}

export async function resolveFTP(params: FTPParams): Promise<ResolvedSource> {
  const query = new URLSearchParams({
    serverUrl: params.serverUrl,
    path: params.path,
    ...(params.username ? { username: params.username } : {}),
    ...(params.password ? { password: params.password } : {}),
    ...(params.port ? { port: String(params.port) } : {}),
  }).toString()
  const res = await apiFetch(`${API_URL}/api/stream/resolve-ftp?${query}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    format?: MediaFormat
    duration?: number
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '解析 FTP 文件失败')
  }
  return {
    title: data.title,
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    duration: data.duration,
  }
}

export interface AnimeSearchResult {
  id: string
  title: string
  cover?: string
  description?: string
  source: string
}

export interface AnimeEpisode {
  id: string
  title: string
  episodeNumber: number
  playbackParams: Record<string, unknown>
}

export interface AnimeSource {
  id: string
  name: string
}

export async function getAnimeSources(): Promise<AnimeSource[]> {
  const res = await apiFetch(`${API_URL}/api/stream/anime/sources`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    sources?: AnimeSource[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.sources)) {
    throw new Error(data.message || '获取番剧数据源失败')
  }
  return data.sources
}

export async function searchAnime(
  source: string,
  keyword: string
): Promise<AnimeSearchResult[]> {
  const res = await apiFetch(
    `${API_URL}/api/stream/anime/search?source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(keyword)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    results?: AnimeSearchResult[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.results)) {
    throw new Error(data.message || '搜索番剧失败')
  }
  return data.results
}

export async function getAnimeEpisodes(
  source: string,
  identifier: string
): Promise<AnimeEpisode[]> {
  const res = await apiFetch(
    `${API_URL}/api/stream/anime/episodes?source=${encodeURIComponent(source)}&identifier=${encodeURIComponent(identifier)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    episodes?: AnimeEpisode[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.episodes)) {
    throw new Error(data.message || '获取番剧集数失败')
  }
  return data.episodes
}

export interface ResolvedAnimeSource {
  url: string
  headers?: Record<string, string>
  format?: MediaFormat
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  duration?: number
}

export async function resolveAnimeEpisode(
  source: string,
  episode: AnimeEpisode
): Promise<ResolvedAnimeSource> {
  const res = await apiFetch(`${API_URL}/api/stream/anime/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ source, episode }),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    url?: string
    headers?: Record<string, string>
    format?: MediaFormat
    audioUrl?: string
    videoCodec?: string
    audioCodec?: string
    duration?: number
  }
  if (!res.ok || !data.success || !data.url) {
    throw new Error(data.message || '解析番剧播放地址失败')
  }
  return {
    url: data.url,
    headers: data.headers,
    format: data.format,
    audioUrl: data.audioUrl,
    videoCodec: data.videoCodec,
    audioCodec: data.audioCodec,
    duration: data.duration,
  }
}

/**
 * 构建番剧源代理 URL，将防盗链 headers 编码到查询参数中。
 * 浏览器无法直接设置 video.src 的 Referer/UA，需走后端代理。
 */
export function buildAnimeProxyUrl(
  url: string,
  headers?: Record<string, string>
): string {
  if (!headers || Object.keys(headers).length === 0) return url
  const params = new URLSearchParams({ url })
  if (headers.Referer) params.set('referer', headers.Referer)
  if (headers['User-Agent']) params.set('userAgent', headers['User-Agent'])
  if (headers.Origin) params.set('origin', headers.Origin)
  if (headers.Cookie) params.set('cookie', headers.Cookie)
  return `${API_URL}/api/stream/anime/proxy?${params.toString()}`
}

/**
 * 判断 URL 是否需要走代理：
 * - 携带防盗链 headers（Referer/UA 等）：浏览器无法直接设置，必须代理
 * - 跨域：浏览器 video 元素虽允许跨域播放，但部分 CDN 会拒绝无 CORS 头的请求，
 *   走代理可避免控制台噪音与潜在失败
 */
export function needsProxy(
  url: string,
  headers?: Record<string, string>
): boolean {
  if (headers && Object.keys(headers).length > 0) return true
  try {
    const target = new URL(url, API_URL)
    return target.origin !== API_URL
  } catch {
    return false
  }
}

export interface FollowingBangumi {
  seasonId: number
  title: string
  cover: string
  progress: string
  total: number
}

export async function getFollowingBangumi(): Promise<FollowingBangumi[]> {
  const res = await apiFetch(`${API_URL}/api/stream/bilibili/following-bangumi`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    list?: FollowingBangumi[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.list)) {
    throw new Error(data.message || '获取关注番剧列表失败')
  }
  return data.list
}

export interface BangumiEpisode {
  bvid: string
  cid: number
  title: string
  index: number
}

export async function getBangumiEpisodes(
  seasonId: number
): Promise<BangumiEpisode[]> {
  const res = await apiFetch(
    `${API_URL}/api/stream/bilibili/bangumi-episodes?seasonId=${encodeURIComponent(seasonId)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    episodes?: BangumiEpisode[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.episodes)) {
    throw new Error(data.message || '获取番剧集数失败')
  }
  return data.episodes
}

export function isBilibiliUrl(url: string): boolean {
  return /bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}/i.test(url)
}

export function buildBilibiliVideoUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`
}

/**
 * 通过后端免认证代理加载 B站 CDN 图片，绕过浏览器 Referer/CORS 限制。
 */
export function buildBilibiliImageProxyUrl(originalUrl: string): string {
  if (!originalUrl) return ''
  return `${API_URL}/api/stream/proxy-image?url=${encodeURIComponent(originalUrl)}`
}

/**
 * 判断 URL 是否为 B站 CDN 图片地址（hdslb.com / bilivideo.com / biliimg.com 等）。
 * 用于决定是否需要走 proxy-image 代理绕过防盗链 / ORB 限制。
 */
export function isBilibiliImageUrl(url: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return [
      'hdslb.com',
      'bilivideo.com',
      'biliimg.com',
      'bilibili.com',
    ].some(
      (domain) =>
        parsed.hostname === domain ||
        parsed.hostname.endsWith(`.${domain}`)
    )
  } catch {
    return false
  }
}
