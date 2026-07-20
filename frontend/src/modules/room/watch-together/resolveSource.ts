import { useAuthStore } from '@/store/authStore'
import type { ResolvedSource } from '@/modules/bilibili/types'
import type { MediaFormat } from '@/lib/mediaFormat'

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

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
export const API_URL = rawApiUrl || window.location.origin

export function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

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
  const res = await fetch(`${API_URL}/api/stream/resolve-ftp?${query}`, {
    headers: getAuthHeaders(),
  })
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
  const res = await fetch(`${API_URL}/api/stream/anime/sources`, {
    headers: getAuthHeaders(),
  })
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
  const res = await fetch(
    `${API_URL}/api/stream/anime/search?source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(keyword)}`,
    { headers: getAuthHeaders() }
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
  const res = await fetch(
    `${API_URL}/api/stream/anime/episodes?source=${encodeURIComponent(source)}&identifier=${encodeURIComponent(identifier)}`,
    { headers: getAuthHeaders() }
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

export async function resolveAnimeEpisode(
  source: string,
  episode: AnimeEpisode
): Promise<{ url: string; headers?: Record<string, string> }> {
  const res = await fetch(`${API_URL}/api/stream/anime/resolve`, {
    method: 'POST',
    headers: {
      ...getAuthHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ source, episode }),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    url?: string
    headers?: Record<string, string>
  }
  if (!res.ok || !data.success || !data.url) {
    throw new Error(data.message || '解析番剧播放地址失败')
  }
  return { url: data.url, headers: data.headers }
}

export interface FollowingBangumi {
  seasonId: number
  title: string
  cover: string
  progress: string
  total: number
}

export async function getFollowingBangumi(): Promise<FollowingBangumi[]> {
  const res = await fetch(`${API_URL}/api/stream/bilibili/following-bangumi`, {
    headers: getAuthHeaders(),
  })
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
  const res = await fetch(
    `${API_URL}/api/stream/bilibili/bangumi-episodes?seasonId=${encodeURIComponent(seasonId)}`,
    { headers: getAuthHeaders() }
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
