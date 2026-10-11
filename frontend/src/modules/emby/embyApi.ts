/**
 * Emby API 层
 *
 * 与 webdav/openlist/ftp 挂载 API 结构对齐，路由前缀 /api/emby。
 */
import { apiFetch } from '@/lib/api'
import { buildProxyUrl } from '@/modules/direct-link/directLinkApi'
import type { MediaFormat } from '@/lib/mediaFormat'
import type {
  EmbyMount,
  EmbyMountFormPayload,
  EmbyTestResult,
  EmbyDirectoryEntry,
  EmbyResolvedSource,
  EmbyVersionInfo,
} from './types'

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export async function getEmbyMounts(): Promise<EmbyMount[]> {
  const res = await apiFetch('/api/emby/mounts')
  const data = (await res.json()) as {
    success: boolean
    mounts?: EmbyMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 Emby 挂载列表失败')
  }
  return data.mounts || []
}

export async function createEmbyMount(
  payload: EmbyMountFormPayload
): Promise<EmbyMount & { warning?: string }> {
  const res = await apiFetch('/api/emby/mounts', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: EmbyMount
    message?: string
    warning?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '创建 Emby 挂载失败')
  }
  return { ...data.mount, warning: data.warning }
}

export async function updateEmbyMount(
  id: number,
  payload: EmbyMountFormPayload
): Promise<EmbyMount & { warning?: string }> {
  const res = await apiFetch(`/api/emby/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: EmbyMount
    message?: string
    warning?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '更新 Emby 挂载失败')
  }
  return { ...data.mount, warning: data.warning }
}

export async function deleteEmbyMount(id: number): Promise<void> {
  const res = await apiFetch(`/api/emby/mounts/${id}`, {
    method: 'DELETE',
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除 Emby 挂载失败')
  }
}

export async function testEmbyMount(
  payload: EmbyMountFormPayload
): Promise<EmbyTestResult> {
  const res = await apiFetch('/api/emby/mounts/test', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    userId?: string
    userName?: string
    serverId?: string
    message?: string
    code?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '测试 Emby 连接失败')
  }
  return {
    success: true,
    userId: data.userId,
    userName: data.userName,
    serverId: data.serverId,
  }
}

export async function browseEmbyMount(
  id: number,
  path?: string
): Promise<EmbyDirectoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await apiFetch(`/api/emby/mounts/${id}/browse${query}`)
  const data = (await res.json()) as {
    success: boolean
    entries?: EmbyDirectoryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览 Emby 挂载失败')
  }
  return data.entries || []
}

/** 全库搜索（官方 API SearchTerm 递归检索，返回条目结构与 browse 一致） */
export async function searchEmbyMount(
  id: number,
  term: string
): Promise<EmbyDirectoryEntry[]> {
  const res = await apiFetch(
    `/api/emby/mounts/${id}/search?term=${encodeURIComponent(term)}`
  )
  const data = (await res.json()) as {
    success: boolean
    entries?: EmbyDirectoryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '搜索 Emby 失败')
  }
  return data.entries || []
}

export async function resolveEmby(
  mountId: number,
  path: string
): Promise<EmbyResolvedSource> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await apiFetch(`/api/emby/resolve?${query}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    directUrl?: string
    format?: MediaFormat
    duration?: number
    audioCodec?: string | null
    needsAudioTranscode?: boolean
    audioTranscodeDisabled?: boolean
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '解析 Emby 条目失败')
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    directUrl: data.directUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
    audioCodec: data.audioCodec ?? null,
    needsAudioTranscode: data.needsAudioTranscode === true,
    audioTranscodeDisabled: data.audioTranscodeDisabled === true,
  }
}

export function buildEmbyProxyUrl(mountId: number, path: string): string {
  return buildProxyUrl('emby', { mountId, path })
}

export interface EmbyMovieSourceResult {
  title: string
  videoUrl: string
  /** 按 movieId 的播放 URL（/api/{api}/stream?movieId=N&ms=X），观众可访问 */
  streamUrl?: string
  directUrl?: string
  format: MediaFormat
  duration: number
  audioCodec?: string | null
  needsAudioTranscode?: boolean
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
  mediaSourceId?: string
): Promise<EmbyMovieSourceResult> {
  const query = new URLSearchParams({ movieId: String(movieId) })
  if (mediaSourceId) query.set('ms', mediaSourceId)
  const res = await apiFetch(`/api/${api}/movie-source?${query.toString()}`)
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    streamUrl?: string
    directUrl?: string
    format?: MediaFormat
    duration?: number
    audioCodec?: string | null
    needsAudioTranscode?: boolean
    versions?: EmbyVersionInfo[]
    mediaSourceId?: string
    multiVersion?: boolean
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '获取影片版本信息失败')
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    streamUrl: data.streamUrl,
    directUrl: data.directUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
    audioCodec: data.audioCodec ?? null,
    needsAudioTranscode: data.needsAudioTranscode === true,
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
