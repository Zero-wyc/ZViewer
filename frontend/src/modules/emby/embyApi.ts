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
