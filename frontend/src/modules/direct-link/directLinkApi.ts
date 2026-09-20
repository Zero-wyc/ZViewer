import type { ProxyModule } from './types'
import { apiFetch } from '@/lib/api'

/**
 * 直链 / 服务器中转 统一决策层
 *
 * 分离式架构：
 * - 服务器中转（proxy）：所有挂载源共用一个 `buildProxyUrl`（相对路径 /api/{module}/proxy）
 * - 直链（direct）：各挂载源模块自行实现 `fetchXxxDirectUrl`（OpenList/AList 签名直链、WebDAV 拼接、
 *   Emby/Jellyfin 带 api_key 直链），本模块不感知具体实现
 * - 决策（resolvePlaybackUrl）：播放/添加时的唯一入口，按 movie.directLink 选择路径
 */

/**
 * 构建代理播放 URL（相对路径）
 *
 * 使用相对路径而非完整 URL，确保：
 * 1. video 标签的请求通过反向代理转发到后端（同域请求携带 cookie）
 * 2. 避免开发环境 getApiUrl() 返回的 localhost:5174 等地址出现在数据库中
 * 3. 代理模式下 movie.service.ts 会进一步将 URL 重写为 /api/{source}/stream?movieId={id}
 *
 * @param module 模块类型（webdav / openlist / emby / jellyfin）
 * @param params 查询参数（如 { mountId: 1, path: '/video.mp4' }）
 */
export function buildProxyUrl(
  module: ProxyModule,
  params: Record<string, string | number>
): string {
  const query = new URLSearchParams(
    Object.entries(params).reduce(
      (acc, [k, v]) => {
        acc[k] = String(v)
        return acc
      },
      {} as Record<string, string>
    )
  ).toString()
  return `/api/${module}/proxy?${query}`
}

/** 可播放影片的最小字段（直链决策所需） */
export interface PlayableMovieLike {
  url: string
  directLink?: boolean
  source?: string | null
}

/**
 * 判断影片是否使用直链模式。
 * @param source 来源类型（bilibili 等内部源视为非直链）
 * @param directLink 直链标记
 */
export function isDirectLink(
  source: string | null | undefined,
  directLink?: boolean
): boolean {
  if (directLink !== true) return false
  // 内部源（bilibili/mp4 直链输入等）不参与挂载直链判定
  return (
    source === 'webdav' ||
    source === 'openlist' ||
    source === 'emby' ||
    source === 'jellyfin'
  )
}

/**
 * 解析影片的最终播放 URL（直链 / 服务器中转统一决策）。
 *
 * - 直链模式：movie.url 已是真实可播放 URL（OpenList 签名直链 / WebDAV 拼接 / Emby 带 api_key 直链）
 * - 代理模式：movie.url 由后端 movie.service.ts 在创建时重写为 /api/{source}/stream?movieId={id}，
 *   这里直接返回即可（保证所有成员包括观众可播）
 * - 兜底：代理模式下若 url 仍是旧的 /api/{module}/proxy?mountId=... 形态（历史数据），
 *   通过 fallbackModule + fallbackParams 重新构建
 *
 * @param movie 影片对象
 * @param fallback 代理兜底参数（历史影片无 stream URL 时使用）
 */
export function resolvePlaybackUrl(
  movie: PlayableMovieLike,
  fallback?: { module: ProxyModule; params: Record<string, string | number> }
): string {
  if (isDirectLink(movie.source, movie.directLink)) {
    return movie.url
  }
  // 已是 /api/{source}/stream?movieId= 或普通绝对/相对 URL → 直接用
  if (movie.url.includes('/stream?') || !fallback) {
    return movie.url
  }
  return buildProxyUrl(fallback.module, fallback.params)
}

/**
 * 按影片记录向后端实时解析新鲜直链（openlist/webdav 直链影片）。
 *
 * movie.url 是添加影片那一刻的快照：AList 签名直链会过期、源站地址/协议
 * 可能变化。后端按影片记录反查挂载并实时获取直链（5 分钟 TTL 缓存 +
 * 单飞去重），前端每次播放解析时调用本接口而非复用固化 URL。
 *
 * @throws 后端返回失败（影片不存在/挂载缺失/源站不可达等）时抛错，
 *         调用方应回退固化 movie.url 保持旧行为
 */
export async function resolveMovieDirectUrl(movieId: number): Promise<string> {
  const query = new URLSearchParams({ movieId: String(movieId) }).toString()
  const res = await apiFetch(`/api/direct-resolve/movie?${query}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    directUrl?: string
  }
  if (!res.ok || !data.success || !data.directUrl) {
    throw new Error(data.message || '实时解析直链失败')
  }
  return data.directUrl
}
