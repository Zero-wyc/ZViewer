import { useAuthStore } from '@/store/authStore'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

export type MountType = 'webdav' | 'ftp' | 'openlist'

export interface UserMount {
  id: number
  type: MountType
  name: string
  serverUrl: string | null
  port: number | null
  path: string | null
  username: string | null
  password?: string
  indexUrl: string | null
  directLink: boolean
  createdAt: string
  updatedAt: string
}

export interface MountFormPayload {
  type: MountType
  name: string
  serverUrl: string | null
  port: number | null
  path: string | null
  username: string | null
  password: string | null
  indexUrl: string | null
  directLink: boolean
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

export async function getUserMounts(): Promise<UserMount[]> {
  const res = await fetch(`${API_URL}/api/users/mounts`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    mounts?: UserMount[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取挂载列表失败')
  }
  return data.mounts || []
}

export const fetchMounts = getUserMounts

export async function createUserMount(
  payload: MountFormPayload
): Promise<UserMount> {
  const res = await fetch(`${API_URL}/api/users/mounts`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: UserMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '创建挂载失败')
  }
  return data.mount
}

export async function updateUserMount(
  id: number,
  payload: MountFormPayload
): Promise<UserMount> {
  const res = await fetch(`${API_URL}/api/users/mounts/${id}`, {
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  })
  const data = (await res.json()) as {
    success: boolean
    mount?: UserMount
    message?: string
  }
  if (!res.ok || !data.success || !data.mount) {
    throw new Error(data.message || '更新挂载失败')
  }
  return data.mount
}

export async function deleteUserMount(id: number): Promise<void> {
  const res = await fetch(`${API_URL}/api/users/mounts/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as { success: boolean; message?: string }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '删除挂载失败')
  }
}

export interface MountBrowseEntry {
  name: string
  type: 'file' | 'directory'
  path: string
  size?: number
  url?: string
}

export async function testUserMount(
  payload: MountFormPayload,
  existingId?: number
): Promise<void> {
  // 后端没有独立的 /test 路由，保存时会做连通性校验。
  // 编辑模式下直接调用 update；创建模式下先 create 再 delete 临时记录。
  if (existingId) {
    await updateUserMount(existingId, payload)
    return
  }
  const created = await createUserMount(payload)
  await deleteUserMount(created.id)
}

export async function browseUserMount(
  id: number,
  path?: string
): Promise<MountBrowseEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const res = await fetch(`${API_URL}/api/users/mounts/${id}/browse${query}`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    entries?: MountBrowseEntry[]
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '浏览挂载失败')
  }
  return data.entries || []
}
