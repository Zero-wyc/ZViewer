/**
 * OpenList API 层
 *
 * OpenList 通过 WebDAV 协议访问，API 结构与 webdavApi.ts 对齐。
 */
import { useAuthStore } from '@/store/authStore'
import { buildProxyUrl } from '@/modules/direct-link/directLinkApi'
import type {
  OpenListMount,
  OpenListMountFormPayload,
  OpenListConnectionParams,
  OpenListDirectoryEntry,
  OpenListResolvedSource,
} from './types'
import type { MediaFormat } from '@/lib/mediaFormat'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

export interface OpenListTestResult {
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

export async function getOpenListMounts(): Promise<OpenListMount[]> {
  const res = await fetch(`${API_URL}/api/openlist/mounts`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    mounts?: OpenListMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 OpenList 挂载列表失败')
  }
  return data.mounts || []
}

export async function createOpenListMount(
  payload: OpenListMountFormPayload
): Promise<OpenListMount> {
  const res = await fetch(`${API_URL}/api/openlist/mounts`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: OpenListMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '创建 OpenList 挂载失败')
  }
  return data.mount
}

export async function updateOpenListMount(
  id: number,
  payload: OpenListMountFormPayload
): Promise<OpenListMount> {
  const res = await fetch(`${API_URL}/api/openlist/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: OpenListMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '更新 OpenList 挂载失败')
  }
  return data.mount
}

export async function deleteOpenListMount(id: number): Promise<void> {
  const res = await fetch(`${API_URL}/api/openlist/mounts/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除 OpenList 挂载失败')
  }
}

export async function testOpenListMount(
  params: OpenListConnectionParams
): Promise<OpenListTestResult> {
  const res = await fetch(`${API_URL}/api/openlist/mounts/test`, {
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
    throw new Error(data.message || '测试 OpenList 连接失败')
  }
  return {
    success: true,
    itemCount: data.itemCount ?? 0,
  }
}

export async function browseOpenListMount(
  id: number,
  path?: string
): Promise<OpenListDirectoryEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(
    `${API_URL}/api/openlist/mounts/${id}/browse${query}`,
    {
      headers: getAuthHeaders(),
    }
  )
  const data = (await res.json()) as {
    success: boolean
    entries?: OpenListDirectoryEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览 OpenList 挂载失败')
  }
  return data.entries || []
}

export async function resolveOpenList(
  mountId: number,
  path: string
): Promise<OpenListResolvedSource> {
  const query = new URLSearchParams({
    mountId: String(mountId),
    path,
  }).toString()
  const res = await fetch(`${API_URL}/api/openlist/resolve?${query}`, {
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
    throw new Error(data.message || '解析 OpenList 文件失败')
  }
  return {
    title: data.title || '',
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    duration: data.duration ?? 0,
    size: data.size,
  }
}

export function buildOpenListProxyUrl(mountId: number, path: string): string {
  return buildProxyUrl('openlist', { mountId, path })
}
