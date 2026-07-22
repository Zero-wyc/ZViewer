/**
 * Kazumi 前端模块 — API 客户端
 *
 * 对接后端 /api/stream/kazumi/* 路由。
 * 完全独立于 resolveSource.ts 中的 Anime* API 函数。
 */

import { apiFetch, API_URL } from '@/lib/api'
import type {
  KazumiSource,
  KazumiSearchResult,
  KazumiEpisode,
  KazumiResolvedSource,
} from './types'

const BASE_URL = `${API_URL}/api/stream/kazumi`

/** 列出可用数据源 */
export async function getKazumiSources(): Promise<KazumiSource[]> {
  const res = await apiFetch(`${BASE_URL}/sources`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    sources?: KazumiSource[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.sources)) {
    throw new Error(data.message || '获取数据源失败')
  }
  return data.sources
}

/** 搜索番剧 */
export async function searchKazumi(
  source: string,
  keyword: string
): Promise<KazumiSearchResult[]> {
  const res = await apiFetch(
    `${BASE_URL}/search?source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(keyword)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    results?: KazumiSearchResult[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.results)) {
    throw new Error(data.message || '搜索失败')
  }
  return data.results
}

/** 获取集数列表 */
export async function getKazumiEpisodes(
  source: string,
  identifier: string
): Promise<KazumiEpisode[]> {
  const res = await apiFetch(
    `${BASE_URL}/episodes?source=${encodeURIComponent(source)}&identifier=${encodeURIComponent(identifier)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    episodes?: KazumiEpisode[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.episodes)) {
    throw new Error(data.message || '获取集数失败')
  }
  return data.episodes
}

/** 解析播放地址 */
export async function resolveKazumiEpisode(
  source: string,
  episode: KazumiEpisode
): Promise<KazumiResolvedSource> {
  const res = await apiFetch(`${BASE_URL}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, episode }),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    url?: string
    headers?: Record<string, string>
    format?: KazumiResolvedSource['format']
  }
  if (!res.ok || !data.success || !data.url) {
    throw new Error(data.message || '解析播放地址失败')
  }
  return {
    url: data.url,
    headers: data.headers,
    format: data.format,
  }
}

/**
 * 构建代理 URL，将防盗链 headers 编码到查询参数中。
 * 浏览器无法直接设置 video.src 的 Referer/UA，需走后端代理。
 */
export function buildKazumiProxyUrl(
  url: string,
  headers?: Record<string, string>
): string {
  if (!headers || Object.keys(headers).length === 0) return url
  const params = new URLSearchParams({ url })
  if (headers.Referer) params.set('referer', headers.Referer)
  if (headers['User-Agent']) params.set('userAgent', headers['User-Agent'])
  if (headers.Origin) params.set('origin', headers.Origin)
  if (headers.Cookie) params.set('cookie', headers.Cookie)
  return `${BASE_URL}/proxy?${params.toString()}`
}

/**
 * 判断 URL 是否需要走代理：
 * - 携带防盗链 headers：浏览器无法直接设置，必须代理
 * - 跨域：部分 CDN 会拒绝无 CORS 头的请求
 */
export function needsKazumiProxy(
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
