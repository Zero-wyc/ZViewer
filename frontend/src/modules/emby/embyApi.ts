/**
 * Emby API 层
 *
 * 与 webdav/openlist/ftp 挂载 API 结构对齐，路由前缀 /api/emby。
 * 挂载 CRUD/browse/search/resolve/proxy 由 embyLikeApi 工厂生成
 * （与 jellyfinApi 共用，对应后端 routes/emby-like-factory.ts）；
 * 本文件保留 Emby 专属的影片级函数与工具。
 */
import { apiFetch } from '@/lib/api'
import type { MediaFormat } from '@/lib/mediaFormat'
import type {
  EmbyMount,
  EmbyMountFormPayload,
  EmbyTestResult,
  EmbyDirectoryEntry,
  EmbyResolvedSource,
  EmbyVersionInfo,
} from './types'
import { createEmbyLikeApi } from './embyLikeApi'
import { t } from '@/i18n'

const embyApi = createEmbyLikeApi<
  EmbyMount,
  EmbyMountFormPayload,
  EmbyTestResult,
  EmbyDirectoryEntry,
  EmbyResolvedSource
>('emby', 'Emby')

export const getEmbyMounts = embyApi.getMounts
export const createEmbyMount = embyApi.createMount
export const updateEmbyMount = embyApi.updateMount
export const deleteEmbyMount = embyApi.deleteMount
export const testEmbyMount = embyApi.testMount
export const browseEmbyMount = embyApi.browseMount
export const searchEmbyMount = embyApi.searchMount
export const resolveEmby = embyApi.resolve
export const buildEmbyProxyUrl = embyApi.buildProxyUrl

export interface EmbyMovieSourceResult {
  title: string
  videoUrl: string
  /** 按 movieId 的播放 URL（/api/{api}/stream?movieId=N&ms=X），观众可访问 */
  streamUrl?: string
  directUrl?: string
  resolvedDirectUrl?: string
  format: MediaFormat
  duration: number
  audioCodec?: string | null
  needsAudioTranscode?: boolean
  audioTranscodeDisabled?: boolean
  versions: EmbyVersionInfo[]
  mediaSourceId: string
  multiVersion: boolean
}

/**
 * 按影片 ID 获取 Emby/Jellyfin 影片的版本列表与播放地址。
 * - 不带 mediaSourceId：返回版本列表 + 默认版本（服务器默认，通常最高码率）
 * - 带 mediaSourceId：返回指定版本的播放地址（房主切换清晰度用）
 * 同时覆盖 'emby' 与 'jellyfin'（后端路由结构一致，仅前缀不同）。
 */
export async function getEmbyApiMovieSource(
  api: 'emby' | 'jellyfin',
  movieId: number,
  mediaSourceId?: string,
  resolveDirectRedirects = false
): Promise<EmbyMovieSourceResult> {
  const query = new URLSearchParams({ movieId: String(movieId) })
  if (mediaSourceId) query.set('ms', mediaSourceId)
  if (resolveDirectRedirects) query.set('direct', '1')
  const res = await apiFetch(`/api/${api}/movie-source?${query.toString()}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    streamUrl?: string
    directUrl?: string
    resolvedDirectUrl?: string
    format?: MediaFormat
    duration?: number
    audioCodec?: string | null
    needsAudioTranscode?: boolean
    audioTranscodeDisabled?: boolean
    versions?: EmbyVersionInfo[]
    mediaSourceId?: string
    multiVersion?: boolean
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || t('获取影片版本信息失败'))
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    streamUrl: data.streamUrl,
    directUrl: data.directUrl,
    resolvedDirectUrl: data.resolvedDirectUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
    audioCodec: data.audioCodec ?? null,
    needsAudioTranscode: data.needsAudioTranscode === true,
    audioTranscodeDisabled: data.audioTranscodeDisabled === true,
    versions: data.versions || [],
    mediaSourceId: data.mediaSourceId || '',
    multiVersion: data.multiVersion === true,
  }
}

/**
 * 条目主海报 URL（经后端代理，凭证不暴露）。
 * @param api 'emby' | 'jellyfin'（后端路由前缀不同）
 * @param tag 条目 ImageTags.Primary（缓存校验）
 */
export function buildEmbyImageUrl(
  api: 'emby' | 'jellyfin',
  mountId: number,
  itemId: string,
  tag?: string,
  maxWidth = 300
): string {
  const query = new URLSearchParams({
    itemId,
    maxWidth: String(maxWidth),
  })
  if (tag) query.set('tag', tag)
  return `/api/${api}/mounts/${mountId}/image?${query.toString()}`
}

/**
 * 从分集文件路径解析集号（Emby/Jellyfin IndexNumber 缺失时的兜底）。
 *
 * 非刮削库的分集常为普通 Video 条目（无 IndexNumber），只能靠文件名：
 * - `S01E02` / `s1e2`（标准剧集命名）
 * - `第 03 话` / `第03集`（中日番剧命名）
 * - `[01]`（ Fansub 发布组习惯：组名/标题/集号/规格分段方括号）
 * - `EP12` / ` E12` / `.12.`（常见分隔符集号）
 * 返回 { season?, episode }；解析失败返回 null。
 */
export function parseEpisodeFromFilePath(
  filePath: string
): { season?: number; episode: number } | null {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  let m = base.match(/S(\d{1,2})\s*E(\d{1,3})/i)
  if (m) return { season: Number(m[1]), episode: Number(m[2]) }
  m = base.match(/第\s*(\d{1,4})\s*[话話集]/)
  if (m) return { episode: Number(m[1]) }
  // 合集范围命名 [01-28]：取起始集
  m = base.match(/\[(\d{1,4})\s*[-–]\s*\d{1,4}\]/)
  if (m) return { episode: Number(m[1]) }
  m = base.match(/\[(\d{1,4})\]/)
  if (m) return { episode: Number(m[1]) }
  m = base.match(/(?:^|[\s._\-[])(?:E|EP|ep)(\d{1,4})(?=$|[\s._\-\]])/)
  if (m) return { episode: Number(m[1]) }
  // 兜底：空白/点分隔的独立 2-3 位数字（不含 -，避免 [01-28] 的末尾误判）
  m = base.match(/(?:^|[\s._])(\d{2,3})(?=$|[\s._])/)
  if (m) return { episode: Number(m[1]) }
  return null
}
