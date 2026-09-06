/**
 * Jellyfin API 层
 *
 * 路由前缀 /api/jellyfin。Jellyfin 是 Emby 开源分支，接口与 emby 一致。
 */
import { apiFetch } from '@/lib/api'
import { buildProxyUrl } from '@/modules/direct-link/directLinkApi'
import type { MediaFormat } from '@/lib/mediaFormat'
import type {
  JellyfinMount,
  JellyfinMountFormPayload,
  JellyfinTestResult,
  JellyfinDirectoryEntry,
  JellyfinResolvedSource,
} from './types'

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export async function getJellyfinMounts(): Promise<JellyfinMount[]> {
  const res = await apiFetch('/api/jellyfin/mounts')
  const data = (await res.json()) as {
    success: boolean
    mounts?: JellyfinMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 Jellyfin 挂载列表失败')
  }
  return data.mounts || []
}

export async function createJellyfinMount(
  payload: JellyfinMountFormPayload
): Promise<JellyfinMount & { warning?: string }> {
  const res = await apiFetch('/api/jellyfin/mounts', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: JellyfinMount
    message?: string
    warning?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '创建 Jellyfin 挂载失败')
  }
  return { ...data.mount, warning: data.warning }
}

export async function updateJellyfinMount(
  id: number,
  payload: JellyfinMountFormPayload
): Promise<JellyfinMount & { warning?: string }> {
  const res = await apiFetch(`/api/jellyfin/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: JellyfinMount
    message?: string
    warning?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '更新 Jellyfin 挂载失败')
  }
  return { ...data.mount, warning: data.warning }
}

export async function deleteJellyfinMount(id: number): Promise<void> {
  const res = await apiFetch(`/api/jellyfin/mounts/${id}`, {
    method: 'DELETE',
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除 Jellyfin 挂载失败')
  }
}

export async function testJellyfinMount(
  payload: JellyfinMountFormPayload
): Promise<JellyfinTestResult> {
  const res = await apiFetch('/api/jellyfin/mounts/test', {
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
    throw new Error(data.message || '测试 Jellyfin 连接失败')
  }
  return {
    success: true,
    userId: data.userId,
    userName: data.userName,
    serverId: data.serverId,
  }
}

export async function browseJellyfinMount(
  id: number,
  path?: string
): Promise<JellyfinDirectoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await apiFetch(`/api/jellyfin/mounts/${id}/browse${query}`)
  const data = (await res.json()) as {
    success: boolean
    entries?: JellyfinDirectoryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览 Jellyfin 挂载失败')
  }
  return data.entries || []
}

export async function resolveJellyfin(
  mountId: number,
  path: string
): Promise<JellyfinResolvedSource> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await apiFetch(`/api/jellyfin/resolve?${query}`)
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
    throw new Error(data.message || '解析 Jellyfin 条目失败')
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

export function buildJellyfinProxyUrl(mountId: number, path: string): string {
  return buildProxyUrl('jellyfin', { mountId, path })
}
