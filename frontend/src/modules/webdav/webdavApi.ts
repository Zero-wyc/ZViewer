import { useAuthStore } from '@/store/authStore'
import { buildProxyUrl } from '@/modules/direct-link/directLinkApi'
import type {
  WebDAVMount,
  WebDAVMountFormPayload,
  WebDAVConnectionParams,
  WebDAVDirectoryEntry,
  WebDAVResolvedSource,
} from './types'
import type { MediaFormat } from '@/lib/mediaFormat'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

export interface WebDAVTestResult {
  success: boolean
  itemCount: number
}

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function jsonHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...getAuthHeaders(),
  }
}

export async function getWebDAVMounts(): Promise<WebDAVMount[]> {
  const res = await fetch(`${API_URL}/api/webdav/mounts`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    mounts?: WebDAVMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 WebDAV 挂载列表失败')
  }
  return data.mounts || []
}

export async function createWebDAVMount(
  payload: WebDAVMountFormPayload
): Promise<WebDAVMount> {
  const res = await fetch(`${API_URL}/api/webdav/mounts`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: WebDAVMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '创建 WebDAV 挂载失败')
  }
  return data.mount
}

export async function updateWebDAVMount(
  id: number,
  payload: WebDAVMountFormPayload
): Promise<WebDAVMount> {
  const res = await fetch(`${API_URL}/api/webdav/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: WebDAVMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '更新 WebDAV 挂载失败')
  }
  return data.mount
}

export async function deleteWebDAVMount(id: number): Promise<void> {
  const res = await fetch(`${API_URL}/api/webdav/mounts/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除 WebDAV 挂载失败')
  }
}

export async function testWebDAVMount(
  params: WebDAVConnectionParams
): Promise<WebDAVTestResult> {
  const res = await fetch(`${API_URL}/api/webdav/mounts/test`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(params),
  })
  const data = (await res.json()) as {
    success: boolean
    itemCount?: number
    message?: string
    code?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '测试 WebDAV 连接失败')
  }
  return {
    success: true,
    itemCount: data.itemCount ?? 0,
  }
}

export async function browseWebDAVMount(
  id: number,
  path?: string
): Promise<WebDAVDirectoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`${API_URL}/api/webdav/mounts/${id}/browse${query}`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    entries?: WebDAVDirectoryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览 WebDAV 挂载失败')
  }
  return data.entries || []
}

export async function resolveWebDAV(
  mountId: number,
  path: string
): Promise<WebDAVResolvedSource> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await fetch(`${API_URL}/api/webdav/resolve?${query}`, {
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
    throw new Error(data.message || '解析 WebDAV 文件失败')
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
  }
}

export function buildWebDAVProxyUrl(mountId: number, path: string): string {
  return buildProxyUrl('webdav', { mountId, path })
}
