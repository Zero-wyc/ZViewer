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
export function getBilibiliUrlDeadline(url: string): number | null {
  // Both the server proxy and the local CLI wrap CDN URLs in a `url` query.
  try {
    for (let depth = 0; url && depth < 4; depth++) {
      const parsed = new URL(url, 'http://zviewer.invalid')
      const deadline = parsed.searchParams.get('deadline')
      if (deadline && /^\d+$/.test(deadline)) {
        const milliseconds = Number(deadline) * 1000
        if (Number.isSafeInteger(milliseconds) && milliseconds > 0) {
          return milliseconds
        }
      }
      url = parsed.searchParams.get('url') ?? ''
    }
  } catch {
    // Invalid URLs have no usable expiry information.
  }
  return null
}

/** Refresh before expiry; unlike the viewer warning this has no grace delay. */
export function isBilibiliUrlExpiring(url: string): boolean {
  const deadline = getBilibiliUrlDeadline(url)
  return deadline != null && Date.now() >= deadline - 60_000
}

export function isBilibiliUrlExpired(url: string): boolean {
  const deadline = getBilibiliUrlDeadline(url)
  return deadline != null && Date.now() >= deadline + 60_000
}

/**
 * 检测 video 元素错误是否为 URL 过期导致。
 *
 * B站 URL 过期后，video 元素会触发 error 事件，code 通常是 4 (MEDIA_ERR_SRC_NOT_SUPPORTED)
 * 或网络层 403。
 *
 * 为避免切换视频源、加载 transient error 等场景误报，仅在以下情况判定：
 * - error.code === 4 (MEDIA_ERR_SRC_NOT_SUPPORTED)
 * - video 已处于 NETWORK_NO_SOURCE 状态，说明当前 src 完全无法加载
 *
 * @param error MediaError 对象
 * @param video video 元素
 * @returns true 表示可能是 URL 过期
 */
export function isVideoErrorFromExpiry(
  error: HTMLMediaElement['error'],
  video?: HTMLVideoElement | null
): boolean {
  if (!error) return false
  if (error.code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return false
  if (video && video.networkState !== HTMLMediaElement.NETWORK_NO_SOURCE) {
    return false
  }
  return true
}

/**
 * 综合判断视频源是否已过期。
 *
 * 优先检查 URL deadline，其次检查 video error。
 *
 * @param url 视频 URL
 * @param videoError video 元素的 error 对象
 * @param video video 元素
 * @returns true 表示已过期
 */
export function isVideoSourceExpired(
  url: string,
  videoError?: HTMLMediaElement['error'] | null,
  video?: HTMLVideoElement | null
): boolean {
  // 优先检查 URL deadline
  if (isBilibiliUrlExpired(url)) return true

  // 兜底：video error + URL 包含 bilivideo.com + 视频已无法加载
  if (videoError && isVideoErrorFromExpiry(videoError, video)) {
    try {
      const urlObj = new URL(url)
      return urlObj.hostname.includes('bilivideo.com')
    } catch {
      return false
    }
  }

  return false
}
