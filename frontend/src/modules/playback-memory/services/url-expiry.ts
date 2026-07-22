/**
 * B站 URL 过期检测服务。
 *
 * 房主断开后，观众端继续使用缓存的 B站 URL 播放。
 * B站 CDN URL 包含 deadline 参数，过期后无法播放（403 Forbidden）。
 *
 * 检测策略：
 * 1. 优先解析 URL 中的 deadline 参数（B站特有）
 * 2. 兜底监听 video 元素 error 事件（MEDIA_ELEMENT_ERROR / 403）
 *
 * 过期后观众端暂停播放并提示"视频源已过期，等待房主重连"。
 */

/**
 * 检测 B站 URL 是否已过期。
 *
 * B站 CDN URL 格式：
 *   https://*.bilivideo.com/upgcxcode/...?deadline=1234567890&...
 *
 * deadline 为 Unix 时间戳（秒），过期后 URL 返回 403。
 *
 * @param url 视频 URL
 * @returns true 表示已过期
 */
export function isBilibiliUrlExpired(url: string): boolean {
  if (!url) return false

  try {
    const urlObj = new URL(url)
    const deadline = urlObj.searchParams.get('deadline')
    if (!deadline) return false

    // deadline 是 Unix 秒时间戳
    const deadlineSec = parseInt(deadline, 10)
    if (Number.isNaN(deadlineSec)) return false

    // 当前时间（秒）
    const nowSec = Math.floor(Date.now() / 1000)
    return nowSec >= deadlineSec
  } catch {
    // URL 解析失败，无法判断
    return false
  }
}

/**
 * 检测 video 元素错误是否为 URL 过期导致。
 *
 * B站 URL 过期后，video 元素会触发 error 事件，code 通常是 4 (MEDIA_ERR_SRC_NOT_SUPPORTED)
 * 或网络层 403。
 *
 * @param error MediaError 对象
 * @returns true 表示可能是 URL 过期
 */
export function isVideoErrorFromExpiry(
  error: HTMLMediaElement['error']
): boolean {
  if (!error) return false
  // code 4: MEDIA_ERR_SRC_NOT_SUPPORTED（B站 URL 过期后常见）
  // 但也可能是真正的格式问题，需要结合 URL 检测
  return error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
}

/**
 * 综合判断视频源是否已过期。
 *
 * 优先检查 URL deadline，其次检查 video error。
 *
 * @param url 视频 URL
 * @param videoError video 元素的 error 对象
 * @returns true 表示已过期
 */
export function isVideoSourceExpired(
  url: string,
  videoError?: HTMLMediaElement['error'] | null
): boolean {
  // 优先检查 URL deadline
  if (isBilibiliUrlExpired(url)) return true

  // 兜底：video error + URL 包含 bilivideo.com
  if (videoError && isVideoErrorFromExpiry(videoError)) {
    try {
      const urlObj = new URL(url)
      return urlObj.hostname.includes('bilivideo.com')
    } catch {
      return false
    }
  }

  return false
}
