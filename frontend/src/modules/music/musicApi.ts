import { create } from 'zustand'
import * as api from '@/lib/api'
export * from '@/lib/api'

export const NCM_UNAVAILABLE_MESSAGE = '服务器的网易云音乐服务不可用，请联系管理员或稍后重试'
export const useMusicService = create<{ error: string | null; revision: number }>(() => ({ error: null, revision: 0 }))
export class MusicServiceError extends Error {
  readonly status: number
  readonly code?: string | number
  constructor(message: string, status: number, code?: string | number) { super(message); this.name = 'MusicServiceError'; this.status = status; this.code = code }
}
async function inspect(url: string | URL, response: Response, data?: unknown) {
  if (!String(url).includes('/api/music/')) return
  if (response.ok && !response.headers.get('content-type')?.includes('json')) return
  const body = (data === undefined ? await response.clone().json().catch(() => null) : data) as { code?: string | number; message?: string } | null
  if (body?.code === 'NCM_UNAVAILABLE' || response.status === 503) {
    useMusicService.setState({ error: NCM_UNAVAILABLE_MESSAGE })
    throw new MusicServiceError(NCM_UNAVAILABLE_MESSAGE, response.status, body?.code)
  }
  if (!response.ok) throw new MusicServiceError(body?.message || '网易云请求失败，请重试', response.status, body?.code)
  // A successful independent request must not hide another section's error.
}
export async function apiGet<T = unknown>(url: string, options?: Parameters<typeof api.apiGet>[1]) {
  const result = await api.apiGet<T>(url, requestOptions(url, options))
  await inspect(url, result.response, result.data)
  return result
}
export async function apiPost<T = unknown>(url: string, body?: unknown, options?: Parameters<typeof api.apiPost>[2]) {
  const result = await api.apiPost<T>(url, body, requestOptions(url, options))
  await inspect(url, result.response, result.data)
  return result
}
export const apiFetch: typeof api.apiFetch = async (url, options) => {
  const result = await api.apiFetch(url, requestOptions(url, options))
  await inspect(url, result)
  return result
}

function requestOptions(url: string | URL, options?: Parameters<typeof api.apiFetch>[1]) {
  // These optional-auth endpoints can return the upstream account's 401/403.
  // Such an error must never refresh or clear the ZViewer session.
  const upstream = /\/api\/music\/(ncm\/|stream[?]|song-quality[?])/.test(String(url))
  return upstream ? { ...options, _retried: true } : options
}
