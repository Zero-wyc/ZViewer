import { useAuthStore } from '@/store/authStore'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function isBilibiliMediaUrl(url: string): boolean {
  return /bilivideo/i.test(url)
}

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
  // 使用空字符串触发 video 元素 unload 旧 MediaSource
  video.src = ''
  video.load()
}

/**
 * 通过 MediaSource Extensions 将 B站 DASH 格式的视频与音频合并到传入的 <video> 元素。
 * 返回生成的 blob URL，调用方无需再设置 video.src。
 * 若浏览器因 CORS 限制无法直接下载 B站 CDN 资源，则返回 rejected，由调用方降级到音频同步方案。
 */
export async function createMseMediaUrl(
  video: HTMLVideoElement,
  videoUrl: string,
  audioUrl: string,
  videoCodec?: string,
  audioCodec?: string
): Promise<string> {
  // 先彻底 detach 旧的 MediaSource / blob URL，否则新 MediaSource 可能无法打开
  resetVideoElement(video)

  const mediaSource = new MediaSource()
  const objectUrl = URL.createObjectURL(mediaSource)

  // 先设置 src 再等待 sourceopen，避免 MediaSource 永远不会触发 sourceopen
  video.src = objectUrl
  video.load()

  await new Promise<void>((resolve, reject) => {
    const onSourceOpen = async () => {
      try {
        const videoMime = `video/mp4; codecs="${videoCodec || 'avc1.64001E'}"`
        const audioMime = `audio/mp4; codecs="${audioCodec || 'mp4a.40.2'}"`

        if (!MediaSource.isTypeSupported(videoMime)) {
          throw new Error(`不支持的视频编码: ${videoMime}`)
        }
        if (!MediaSource.isTypeSupported(audioMime)) {
          throw new Error(`不支持的音频编码: ${audioMime}`)
        }

        const videoSb = mediaSource.addSourceBuffer(videoMime)
        const audioSb = mediaSource.addSourceBuffer(audioMime)

        const fetchBuffer = async (url: string) => {
          const proxied = isBilibiliMediaUrl(url)
          const targetUrl = proxied
            ? `${API_URL}/api/stream/proxy?url=${encodeURIComponent(url)}`
            : url
          const res = await fetch(targetUrl, {
            headers: proxied
              ? getAuthHeaders()
              : {
                  Referer: 'https://www.bilibili.com',
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
          })
          if (!res.ok) {
            throw new Error(`获取媒体失败: ${res.status} ${res.statusText}`)
          }
          return res.arrayBuffer()
        }

        const [videoBuf, audioBuf] = await Promise.all([
          fetchBuffer(videoUrl),
          fetchBuffer(audioUrl),
        ])

        await appendBuffer(videoSb, videoBuf)
        await appendBuffer(audioSb, audioBuf)

        mediaSource.endOfStream()
        resolve()
      } catch (err) {
        // 构造 MSE 失败时清理 video.src，避免残留无效 blob URL 触发 Format error
        try {
          resetVideoElement(video)
          URL.revokeObjectURL(objectUrl)
        } catch {
          // ignore cleanup errors
        }
        reject(err)
      }
    }

    mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true })
    mediaSource.addEventListener('error', (e) => reject(e), { once: true })

    setTimeout(() => reject(new Error('MediaSource 打开超时')), 30000)
  })

  return objectUrl
}

function appendBuffer(sb: SourceBuffer, buffer: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onUpdateEnd = () => {
      sb.removeEventListener('updateend', onUpdateEnd)
      sb.removeEventListener('error', onError)
      resolve()
    }
    const onError = (e: Event) => {
      sb.removeEventListener('updateend', onUpdateEnd)
      sb.removeEventListener('error', onError)
      reject(e)
    }
    sb.addEventListener('updateend', onUpdateEnd)
    sb.addEventListener('error', onError)
    sb.appendBuffer(buffer)
  })
}

/**
 * 等待 video 元素 metadata 加载完成（readyState >= 1）。
 * 用于在重新 attach 流后 seek 回原进度。
 */
function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve()
  return new Promise((resolve) => {
    const onLoaded = () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      resolve()
    }
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
  })
}

export interface ReattachMseStreamOptions {
  videoUrl: string
  audioUrl: string
  videoCodec?: string
  audioCodec?: string
  /** 切换后需要恢复的播放进度（秒）。传入 0 或不传则不恢复。 */
  preserveTime?: number
  /** 切换前是否应处于播放态。 */
  shouldPlay?: boolean
}

/**
 * 切换清晰度时重新 attach MSE 流，并在新流就绪后恢复原进度与播放状态。
 * 调用方负责在调用前清理旧的 MSE blob URL（避免内存泄漏），本函数只产生新的 blob URL。
 */
export async function reattachMseStream(
  video: HTMLVideoElement,
  options: ReattachMseStreamOptions
): Promise<string> {
  const {
    videoUrl,
    audioUrl,
    videoCodec,
    audioCodec,
    preserveTime,
    shouldPlay,
  } = options

  const blobUrl = await createMseMediaUrl(
    video,
    videoUrl,
    audioUrl,
    videoCodec,
    audioCodec
  )

  const targetTime =
    typeof preserveTime === 'number' && Number.isFinite(preserveTime)
      ? preserveTime
      : null

  if (targetTime !== null && targetTime > 0) {
    await waitForMetadata(video)
    try {
      video.currentTime = targetTime
    } catch {
      // 某些浏览器在 MSE endOfStream 后 seek 可能抛错，忽略即可
    }
  }

  if (shouldPlay) {
    try {
      await video.play()
    } catch {
      // 浏览器自动播放策略可能阻止播放
    }
  }

  return blobUrl
}

/**
 * 当 MSE 因 CORS 等原因不可用时，使用独立的 <audio> 元素播放音频轨道，
 * 并通过事件与 video 元素保持同步（播放/暂停/进度/倍速）。
 * 返回一个清理函数，用于移除事件监听并释放音频资源。
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
      // 浏览器自动播放策略可能阻止音频播放，需用户交互后再次触发
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
