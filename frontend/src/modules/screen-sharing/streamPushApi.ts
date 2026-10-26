/**
 * 推流模式（OBS RTMP + HTTP-FLV）API 层
 */

import { useEffect, useState } from 'react'
import { apiFetch, getApiUrl, getRtmpHost, getRtmpPort } from '@/lib/api'

/** A room admission grants viewing only. Publishing secrets never build FLV URLs. */
export async function getWatchPlaybackUrl(roomId: string, signal?: AbortSignal): Promise<string> {
 const res = await apiFetch(`/api/stream-push/watch/${encodeURIComponent(roomId)}`, { signal })
 const data = await res.json() as { success?: boolean; url?: string; message?: string }
 if (!res.ok || !data.success || !data.url) throw new Error(data.message || '无法获取观看权限')
 if (!data.url.startsWith('/live/') || !data.url.includes('ticket=')) throw new Error('服务器返回了无效的观看地址')
 return `${getApiUrl().replace(/\/$/, '')}${data.url}`
}

export function useWatchPlayback(roomId: string, enabled = true): { url: string; error: string } {
 const [state, setState] = useState({ room: roomId, url: '', error: '' })
 useEffect(() => {
  const controller = new AbortController()
  setState({ room: roomId, url: '', error: '' })
  if (!enabled || !roomId) return () => controller.abort()
  void getWatchPlaybackUrl(roomId, controller.signal).then(url => {
   if (!controller.signal.aborted) setState({ room: roomId, url, error: '' })
  }).catch(error => { if (!controller.signal.aborted) setState({ room: roomId, url: '', error: error instanceof Error ? error.message : '获取观看权限失败' }) })
  return () => controller.abort()
 }, [roomId, enabled])
 return state.room === roomId && enabled ? state : { url: '', error: '' }
}

/**
 * 构建推流地址（仅用于显示）。
 * 主机名从自定义后端地址提取（getRtmpHost），未自定义时回退到当前页面 hostname。
 * 端口来自 RTMP_PORT（支持用户自定义或环境变量 VITE_RTMP_PORT，默认 3334）。
 */
export function getRtmpPushUrl(): string {
  return `rtmp://${getRtmpHost()}:${getRtmpPort()}/live`
}

export async function getPublishConfiguration(roomId: string, signal?: AbortSignal): Promise<{ server: string; key: string }> {
  const response = await apiFetch(`/api/stream-push/obs-config/${encodeURIComponent(roomId)}`, { signal })
  const data = await response.json() as { message?: string; service?: { settings?: { server?: string; key?: string } } }
  const settings = data.service?.settings
  if (!response.ok || !settings?.server || !settings.key) throw new Error(data.message || '获取发布配置失败')
  return { server: settings.server, key: settings.key }
}

/**
 * 下载 OBS 场景集合配置文件。
 * 后端返回 JSON 文件，浏览器直接下载。
 */
export async function downloadObsConfig(roomId: string): Promise<void> {
  const url = `/api/stream-push/obs-config/${encodeURIComponent(roomId)}`
  const response = await apiFetch(url)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`下载 OBS 配置失败: ${response.status} ${text}`)
  }
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = 'zviewer-obs-config.json'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 释放 object URL
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}
