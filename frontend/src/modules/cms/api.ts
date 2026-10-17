/**
 * CMS 采集源前端模块 — API 客户端
 *
 * 对接后端 /api/stream/cms/* 路由。
 */

import { buildAntileechProxyUrl } from '@/lib/antileech-proxy-url'
import { apiFetch, getApiUrl } from '@/lib/api'
import type {
  CmsSource,
  CmsSearchResult,
  CmsAggregateSearchResult,
  CmsPlaybackParams,
  CmsVodDetail,
  CmsResolvedSource,
} from './types'

const getBaseUrl = () => `${getApiUrl()}/api/stream/cms`

/** 列出可用采集站点（来自管理员配置的 TVBox 接口） */
export async function getCmsSources(): Promise<CmsSource[]> {
  const res = await apiFetch(`${getBaseUrl()}/sources`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    sources?: CmsSource[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.sources)) {
    throw new Error(data.message || '获取采集源失败')
  }
  return data.sources
}

/** 站点内搜索影片 */
export async function searchCms(
  source: string,
  keyword: string
): Promise<CmsSearchResult[]> {
  const res = await apiFetch(
    `${getBaseUrl()}/search?source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(keyword)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    results?: CmsSearchResult[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.results)) {
    throw new Error(data.message || '搜索失败')
  }
  return data.results
}

/**
 * 聚合搜索全部站点（标题归一化去重）。
 * 结果 id 为复合 id `${source}::${vodId}`，source 为真实站点 key。
 */
export async function searchAllCms(
  keyword: string
): Promise<CmsAggregateSearchResult[]> {
  const res = await apiFetch(
    `${getBaseUrl()}/search-all?keyword=${encodeURIComponent(keyword)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    results?: CmsAggregateSearchResult[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.results)) {
    throw new Error(data.message || '聚合搜索失败')
  }
  return data.results
}

/** 获取影片详情与剧集列表 */
export async function getCmsDetail(
  source: string,
  vodId: string
): Promise<CmsVodDetail> {
  const res = await apiFetch(
    `${getBaseUrl()}/detail?source=${encodeURIComponent(source)}&vodId=${encodeURIComponent(vodId)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    detail?: CmsVodDetail
  }
  if (!res.ok || !data.success || !data.detail) {
    throw new Error(data.message || '获取影片详情失败')
  }
  return data.detail
}

/** 解析播放直链（实时，6min 服务端缓存） */
export async function resolveCmsEpisode(
  source: string,
  params: CmsPlaybackParams
): Promise<CmsResolvedSource> {
  const res = await apiFetch(`${getBaseUrl()}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, params }),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    url?: string
    headers?: Record<string, string>
    format?: CmsResolvedSource['format']
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
 *
 * @param force 服务器中转模式：无 headers 也强制包装为代理 URL
 */
export function buildCmsProxyUrl(
  url: string,
  headers?: Record<string, string>,
  force = false
): string {
  return buildAntileechProxyUrl('cms', url, headers, { force })
}
