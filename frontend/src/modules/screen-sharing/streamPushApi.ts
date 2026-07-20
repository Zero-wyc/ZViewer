/**
 * 推流模式（OBS RTMP + HTTP-FLV）API 层
 */

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

/**
 * 构建拉流地址。
 * 优先使用 VITE_FLV_BASE_URL 环境变量，否则使用 window.location.origin。
 * 最终地址格式为 `${base}/live/${roomId}.flv`
 */
export function buildFlvUrl(roomId: string): string {
  const base = import.meta.env.VITE_FLV_BASE_URL || window.location.origin
  return `${base}/live/${roomId}.flv`
}

/**
 * 构建推流地址（仅用于显示）。
 * 端口来自 VITE_RTMP_PORT 环境变量或默认 1935。
 * 主机名来自 window.location.hostname。
 */
export function getRtmpPushUrl(): string {
  const rtmpPort = import.meta.env.VITE_RTMP_PORT || '1935'
  const host = window.location.hostname
  return `rtmp://${host}:${rtmpPort}/live`
}

/**
 * 下载 OBS 场景集合配置文件。
 * 后端返回 JSON 文件，浏览器直接下载。
 */
export async function downloadObsConfig(roomId: string): Promise<void> {
  const token = localStorage.getItem('access_token')
  const url = `${API_URL}/api/stream-push/obs-config/${encodeURIComponent(roomId)}`
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`下载 OBS 配置失败: ${response.status} ${text}`)
  }
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = 'zcontrol-obs-config.json'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 释放 object URL
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}
