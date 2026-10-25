/**
 * 推流模式（OBS RTMP + HTTP-FLV）API 层
 */

import { apiFetch, getFlvBaseUrl, getRtmpHost, getRtmpPort } from '@/lib/api'

/**
 * 构建拉流地址。
 * 使用 FLV_BASE_URL（支持用户自定义或环境变量 VITE_FLV_BASE_URL），
 * 默认按当前页面协议推断：
 * - HTTPS 页面默认使用相对路径 `/live`，假设生产环境通过 Nginx/Caddy 等反向代理
 *   由后端把 `/live` 反代到媒体服务的 HTTP-FLV 端口（默认进程内 3335）。
 * - HTTP 页面默认直连 `http://host:3335`，用于本地开发。
 *
 * 最终地址格式为 `${base}/live/${streamKey}.flv`
 *
 * 注意：HTTP-FLV 拉流使用独立的 streamKey（与 roomId 分离），
 * 观众端需从 roomStore 或后端广播中获取 streamKey。
 */
export function buildFlvUrl(streamKey: string): string {
  return `${getFlvBaseUrl()}/live/${streamKey}.flv`
}

/**
 * 构建推流地址（仅用于显示）。
 * 主机名从自定义后端地址提取（getRtmpHost），未自定义时回退到当前页面 hostname。
 * 端口来自 RTMP_PORT（支持用户自定义或环境变量 VITE_RTMP_PORT，默认 3334）。
 */
export function getRtmpPushUrl(): string {
  return `rtmp://${getRtmpHost()}:${getRtmpPort()}/live`
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
