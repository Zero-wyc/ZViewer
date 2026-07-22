import { apiFetch, API_URL } from '@/lib/api'
import type {
  DanmakuSource,
  DanmakuItem,
  DanmakuSearchResult,
  DanmakuEpisode,
} from './types'

/**
 * 弹幕 API 客户端。
 * 统一封装所有弹幕源的网络请求，与 UI 组件和渲染引擎解耦。
 */

/** 获取可用弹幕源列表 */
export async function listDanmakuSources(): Promise<
  Array<{ id: string; name: string }>
> {
  const res = await apiFetch(`${API_URL}/api/stream/danmaku/sources`)
  const data = (await res.json()) as {
    success: boolean
    sources?: Array<{ id: string; name: string }>
    message?: string
  }
  if (!res.ok || !data.success || !Array.isArray(data.sources)) {
    throw new Error(data.message || '获取弹幕源列表失败')
  }
  return data.sources
}

/** 搜索弹幕 */
export async function searchDanmaku(
  source: DanmakuSource,
  keyword: string
): Promise<DanmakuSearchResult[]> {
  const res = await apiFetch(
    `${API_URL}/api/stream/danmaku/search?source=${encodeURIComponent(
      source
    )}&keyword=${encodeURIComponent(keyword)}`
  )
  const data = (await res.json()) as {
    success: boolean
    results?: Array<{
      id: string
      title: string
      cover?: string
      description?: string
      source: string
      stats?: {
        play?: number
        danmaku?: number
        favorites?: number
        like?: number
        coin?: number
        reply?: number
      }
      extra?: Record<string, unknown>
    }>
    message?: string
  }
  if (!res.ok || !data.success || !Array.isArray(data.results)) {
    throw new Error(data.message || '搜索弹幕失败')
  }
  // 转换为前端统一格式：identifier 用 result.id
  return data.results.map((r) => ({
    identifier: r.id,
    title: r.title,
    cover: r.cover,
    description: r.description,
    stats: r.stats,
    extra: r.extra,
  }))
}

/** 获取集数列表 */
export async function getDanmakuEpisodes(
  source: DanmakuSource,
  identifier: string
): Promise<DanmakuEpisode[]> {
  const res = await apiFetch(
    `${API_URL}/api/stream/danmaku/episodes?source=${encodeURIComponent(
      source
    )}&identifier=${encodeURIComponent(identifier)}`
  )
  const data = (await res.json()) as {
    success: boolean
    episodes?: Array<{
      id: string
      title: string
      episodeNumber: number
      playbackParams?: Record<string, unknown>
    }>
    message?: string
  }
  if (!res.ok || !data.success || !Array.isArray(data.episodes)) {
    throw new Error(data.message || '获取集数失败')
  }
  // 保留 playbackParams：fetchDanmaku 时需原样回传给后端 provider，
  // 否则后端拿不到 episodeId 等关键参数，导致 "缺少有效的弹弹play episodeId" 错误。
  return data.episodes.map((ep) => ({
    id: ep.id,
    title: ep.title,
    episodeNumber: ep.episodeNumber,
    playbackParams: ep.playbackParams ?? {},
  }))
}

/** 获取弹幕内容 */
export async function fetchDanmaku(
  source: DanmakuSource,
  episode: DanmakuEpisode
): Promise<DanmakuItem[]> {
  const res = await apiFetch(`${API_URL}/api/stream/danmaku/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, episode }),
  })
  const data = (await res.json()) as {
    success: boolean
    danmaku?: Array<{
      id: string
      content: string
      time: number
      mode: number
      color: number
      size?: number
    }>
    message?: string
  }
  if (!res.ok || !data.success || !Array.isArray(data.danmaku)) {
    throw new Error(data.message || '获取弹幕失败')
  }
  return data.danmaku.map((item, index) => ({
    id: item.id || `${source}:${episode.id}:${index}`,
    content: item.content,
    time: item.time,
    mode: item.mode,
    color: item.color,
    size: item.size ?? 25,
  }))
}

/**
 * 通过 cid 直接获取 B站 视频弹幕。
 * 用于当前播放的 B站 视频自动加载默认弹幕轨道，
 * 无需经过 search → episodes → fetch 流程。
 */
export async function fetchBilibiliDanmakuByCid(
  cid: number
): Promise<DanmakuItem[]> {
  const res = await apiFetch(
    `${API_URL}/api/stream/bilibili/danmaku?cid=${encodeURIComponent(String(cid))}`
  )
  const data = (await res.json()) as {
    success: boolean
    danmaku?: Array<{
      id: string
      content: string
      time: number
      mode: number
      color: number
      size?: number
    }>
    message?: string
  }
  if (!res.ok || !data.success || !Array.isArray(data.danmaku)) {
    throw new Error(data.message || '获取 B站 弹幕失败')
  }
  return data.danmaku.map((item, index) => ({
    id: item.id || `bilibili:${cid}:${index}`,
    content: item.content,
    time: item.time,
    mode: item.mode,
    color: item.color,
    size: item.size ?? 25,
  }))
}
