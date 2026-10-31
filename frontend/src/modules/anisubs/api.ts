/**
 * ani-subs 前端模块 — API 客户端
 *
 * 对接后端 /api/stream/anisubs/* 路由。
 * 完全独立于 resolveSource.ts 中的 Anime* API 函数。
 */

import { buildAntileechProxyUrl } from '@/lib/antileech-proxy-url'
import { apiFetch, getApiUrl } from '@/lib/api'
import type {
  AniSubsSource,
  AniSubsSearchResult,
  AniSubsEpisode,
  AniSubsResolvedSource,
} from './types'
import { t } from '@/i18n'

const getBaseUrl = () => `${getApiUrl()}/api/stream/anisubs`

/** 列出可用数据源 */
export async function getAniSubsSources(): Promise<AniSubsSource[]> {
  const res = await apiFetch(`${getBaseUrl()}/sources`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    sources?: AniSubsSource[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.sources)) {
    throw new Error(data.message || t('获取数据源失败'))
  }
  return data.sources
}

/** 搜索番剧 */
export async function searchAniSubs(
  source: string,
  keyword: string
): Promise<AniSubsSearchResult[]> {
  const res = await apiFetch(
    `${getBaseUrl()}/search?source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(keyword)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    results?: AniSubsSearchResult[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.results)) {
    throw new Error(data.message || t('搜索失败'))
  }
  return data.results
}

/** 获取集数列表 */
export async function getAniSubsEpisodes(
  source: string,
  identifier: string
): Promise<AniSubsEpisode[]> {
  const res = await apiFetch(
    `${getBaseUrl()}/episodes?source=${encodeURIComponent(source)}&identifier=${encodeURIComponent(identifier)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    episodes?: AniSubsEpisode[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.episodes)) {
    throw new Error(data.message || t('获取集数失败'))
  }
  return data.episodes
}

/** 解析播放地址 */
export async function resolveAniSubsEpisode(
  source: string,
  episode: AniSubsEpisode
): Promise<AniSubsResolvedSource> {
  const res = await apiFetch(`${getBaseUrl()}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, episode }),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    url?: string
    headers?: Record<string, string>
    format?: AniSubsResolvedSource['format']
  }
  if (!res.ok || !data.success || !data.url) {
    throw new Error(data.message || t('解析播放地址失败'))
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
 *
 * 使用相对路径：解析 URL 仅在运行时使用（每次播放重新解析，不入库），
 * 相对路径在所有客户端都指向各自同源后端，跨域部署下不会产生
 * 「指向他人 API 地址」的自代理环。
 *
 * @param force 服务器中转模式：无 headers 也强制包装为代理 URL
 */
export function buildAniSubsProxyUrl(
  url: string,
  headers?: Record<string, string>,
  force = false
): string {
  return buildAntileechProxyUrl('anisubs', url, headers, {
    force,
    relative: true,
  })
}
