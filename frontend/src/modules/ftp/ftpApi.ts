import { useAuthStore } from '@/store/authStore'
import type {
  FTPMount,
  FTPMountFormPayload,
  FTPConnectionParams,
  FTPDirectoryEntry,
  FTPResolvedSource,
} from './types'
import type { MediaFormat } from '@/lib/mediaFormat'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

export interface FTPTestResult {
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

export async function getFTPMounts(): Promise<FTPMount[]> {
  const res = await fetch(`${API_URL}/api/ftp/mounts`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    mounts?: FTPMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 FTP 挂载列表失败')
  }
  return data.mounts || []
}

export async function createFTPMount(
  payload: FTPMountFormPayload
): Promise<FTPMount> {
  const res = await fetch(`${API_URL}/api/ftp/mounts`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: FTPMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '创建 FTP 挂载失败')
  }
  return data.mount
}

export async function updateFTPMount(
  id: number,
  payload: FTPMountFormPayload
): Promise<FTPMount> {
  const res = await fetch(`${API_URL}/api/ftp/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: FTPMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '更新 FTP 挂载失败')
  }
  return data.mount
}

export async function deleteFTPMount(id: number): Promise<void> {
  const res = await fetch(`${API_URL}/api/ftp/mounts/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除 FTP 挂载失败')
  }
}

export async function testFTPMount(
  params: FTPConnectionParams
): Promise<FTPTestResult> {
  const res = await fetch(`${API_URL}/api/ftp/mounts/test`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(params),
  })
  const data = (await res.json()) as {
    success: boolean
    itemCount?: number
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '测试 FTP 连接失败')
  }
  return {
    success: true,
    itemCount: data.itemCount ?? 0,
  }
}

export async function browseFTPMount(
  id: number,
  path?: string
): Promise<FTPDirectoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`${API_URL}/api/ftp/mounts/${id}/browse${query}`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    entries?: FTPDirectoryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览 FTP 挂载失败')
  }
  return data.entries || []
}

export async function resolveFTP(
  mountId: number,
  path: string
): Promise<FTPResolvedSource> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await fetch(`${API_URL}/api/ftp/resolve?${query}`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    format?: MediaFormat
    duration?: number
    size?: number
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '解析 FTP 文件失败')
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
    size: data.size,
  }
}
