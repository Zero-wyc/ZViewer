/**
 * 音频同步服务
 *
 * 当 MSE 因 CORS 等原因不可用时，使用独立的 <audio> 元素播放音频轨道，
 * 并通过事件与 video 元素保持同步（播放/暂停/进度/倍速）。
 *
 * 从旧 msePlayer.ts 抽取，逻辑无变化。
 */

/**
 * 创建音频同步器：用独立 Audio 元素播放音频轨道，与 video 元素事件同步。
 *
 * @param video 主视频元素（仅含视频轨）
 * @param audioUrl 音频轨 URL
 * @returns cleanup 函数，卸载时调用以释放 Audio 元素与事件监听
 */
export function createAudioSync(
  video: HTMLVideoElement,
  audioUrl: string
): () => void {
  const audio = new Audio(audioUrl)
  audio.crossOrigin = 'anonymous'

  const syncThreshold = 0.3

  const onPlay = () => {
    audio.play().catch(() => {
      // 浏览器自动播放策略可能阻止音频播放
    })
  }
  const onPause = () => audio.pause()
  const onSeeked = () => {
    audio.currentTime = video.currentTime
  }
  const onRateChange = () => {
    audio.playbackRate = video.playbackRate
  }
  const onTimeUpdate = () => {
    if (Math.abs(audio.currentTime - video.currentTime) > syncThreshold) {
      audio.currentTime = video.currentTime
    }
  }

  video.addEventListener('play', onPlay)
  video.addEventListener('pause', onPause)
  video.addEventListener('seeked', onSeeked)
  video.addEventListener('ratechange', onRateChange)
  video.addEventListener('timeupdate', onTimeUpdate)

  return () => {
    video.removeEventListener('play', onPlay)
    video.removeEventListener('pause', onPause)
    video.removeEventListener('seeked', onSeeked)
    video.removeEventListener('ratechange', onRateChange)
    video.removeEventListener('timeupdate', onTimeUpdate)
    audio.pause()
    audio.src = ''
  }
}
