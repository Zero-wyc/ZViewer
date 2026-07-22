/**
 * 播放器工具函数
 *
 * 从旧 msePlayer.ts 抽取的、与具体引擎无关的视频元素操作工具。
 */

/**
 * 在切换 MediaSource / blob URL 前彻底重置 video 元素，
 * 避免旧的 MediaSource 仍在 attached 状态导致 Format error。
 */
export function resetVideoElement(video: HTMLVideoElement): void {
  try {
    video.pause()
  } catch {
    // ignore
  }
  video.removeAttribute('src')
  video.src = ''
  video.load()
}

/**
 * 等待 video 元素 metadata 加载完成（readyState >= 1）。
 *
 * 调用方在 attach 后设置 currentTime 前必须等待 metadata，
 * 否则浏览器会丢弃 currentTime 赋值（readyState < 1 时 seek 无效）。
 */
export function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve()
  return new Promise((resolve) => {
    const onLoaded = () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      resolve()
    }
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
  })
}
