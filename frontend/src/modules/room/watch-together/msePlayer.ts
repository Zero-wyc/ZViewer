import { useAuthStore } from '@/store/authStore'
import Hls from 'hls.js'
import flvjs from 'flv.js'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function isBilibiliMediaUrl(url: string): boolean {
  // 覆盖 B站 各类 CDN 域名：官方 bilivideo、P2P/mcdn、第三方边缘节点、akamaized 海外节点等。
  // 同时覆盖 bilibili.com 子域（部分海外节点直接用此域）。
  // 不在白名单内的 B站 CDN 也应走后端代理：
  //   1. 浏览器 fetch B站 CDN 不带 Access-Control-Allow-Origin，会被 CORS 拦截；
  //   2. 浏览器禁用 Referer/User-Agent 等头，无法绕过 B站防盗链。
  // 因此策略改为：非已知自有域名（本站 API、blob:、data:）一律走代理。
  try {
    const u = new URL(url, window.location.origin)
    const host = u.hostname.toLowerCase()
    // 本站自身 API 与本地协议直接放行
    if (
      host === window.location.hostname ||
      u.protocol === 'blob:' ||
      u.protocol === 'data:'
    ) {
      return false
    }
    // 已知 B站 CDN/页面域名
    return /(?:bilibili|bilivideo|hdslb|mountaintoys|mcdn|upos|bstatic|akamaized|pili-video|boss-pgc)/i.test(
      host
    )
  } catch {
    return false
  }
}

/** 流式下载分块大小（字节）。2MB 在内存占用与 append 开销间取得平衡。 */
const STREAM_CHUNK_SIZE = 2 * 1024 * 1024
/** 单次 appendBuffer 超时（毫秒），防止 SourceBuffer 卡在 updating 状态。 */
const APPEND_TIMEOUT_MS = 30000
/** fetch 断点续传最大重试次数。 */
const MAX_FETCH_RETRIES = 3

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
 * 等待 SourceBuffer 脱离 updating 状态。
 * appendBuffer 是串行的，必须等上一次 updateend 后才能下一次 append。
 */
function waitForSourceBufferReady(sb: SourceBuffer): Promise<void> {
  if (!sb.updating) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      resolve()
    }
    const onErr = (e: Event) => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      reject(e)
    }
    sb.addEventListener('updateend', onEnd)
    sb.addEventListener('error', onErr)
    setTimeout(
      () => reject(new Error('SourceBuffer 更新超时')),
      APPEND_TIMEOUT_MS
    )
  })
}

/**
 * 向 SourceBuffer 追加数据，自动等待上一次 append 完成。
 */
async function appendBuffer(
  sb: SourceBuffer,
  data: BufferSource
): Promise<void> {
  await waitForSourceBufferReady(sb)
  return new Promise((resolve, reject) => {
    const onEnd = () => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      resolve()
    }
    const onErr = (e: Event) => {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      reject(e)
    }
    sb.addEventListener('updateend', onEnd)
    sb.addEventListener('error', onErr)
    try {
      sb.appendBuffer(data)
    } catch (err) {
      sb.removeEventListener('updateend', onEnd)
      sb.removeEventListener('error', onErr)
      reject(err)
    }
  })
}

/**
 * 清理 SourceBuffer 中已播放过的数据，保持 buffer 窗口在 BUFFER_WINDOW_SECONDS 内。
 * 防止长时间播放后 SourceBuffer 内存溢出导致 QuotaExceededError。
 */
async function pruneSourceBuffer(
  sb: SourceBuffer,
  currentTime: number
): Promise<void> {
  if (sb.updating) return
  if (!sb.buffered.length) return
  const start = sb.buffered.start(0)
  const safeStart = currentTime - 10
  if (safeStart > start + 5) {
    try {
      await new Promise<void>((resolve) => {
        const onEnd = () => {
          sb.removeEventListener('updateend', onEnd)
          resolve()
        }
        sb.addEventListener('updateend', onEnd)
        sb.remove(start, Math.min(safeStart, sb.buffered.end(0)))
      })
    } catch {
      // 清理失败不中断播放
    }
  }
}

interface StreamContext {
  sb: SourceBuffer
  url: string
  video: HTMLVideoElement
  signal: AbortSignal
  /** 已下载字节数，用于断点续传。 */
  downloadedBytes: number
  /** 第一次 append 完成后的回调，用于让播放器尽早启动。 */
  onInitialAppend?: () => void
}

/**
 * 流式下载媒体并分块 append 到 SourceBuffer。
 * - 使用 ReadableStream 边下边播，不再一次性加载整个文件到内存。
 * - 首次 append 后通过 onInitialAppend 通知调用方，无需等待全部下载即可开始播放。
 * - 支持 fetch 中断后通过 Range 请求断点续传。
 * - 定期清理已播放 buffer，保持内存稳定。
 */
async function streamToSourceBuffer(ctx: StreamContext): Promise<void> {
  const { sb, url, video, signal, onInitialAppend } = ctx
  let retryCount = 0
  let initialNotified = false

  while (true) {
    if (signal.aborted) return

    try {
      const proxied = isBilibiliMediaUrl(url)
      const targetUrl = proxied
        ? `${API_URL}/api/stream/proxy?url=${encodeURIComponent(url)}`
        : url

      // 浏览器禁用 Referer/User-Agent 等 forbidden header，设置无效；
      // B站 防盗链由后端 /api/stream/proxy 添加头处理。
      // 走代理时携带本站认证 token；非代理直链（如 WebDAV 已转代理）无需额外头。
      const headers: Record<string, string> = proxied ? getAuthHeaders() : {}

      // 断点续传：从已下载位置继续
      if (ctx.downloadedBytes > 0) {
        headers.Range = `bytes=${ctx.downloadedBytes}-`
      }

      const response = await fetch(targetUrl, { headers, signal })
      if (!response.ok && response.status !== 206) {
        throw new Error(
          `获取媒体失败: ${response.status} ${response.statusText}`
        )
      }

      if (!response.body) {
        throw new Error('响应体为空')
      }

      const reader = response.body.getReader()
      let bufferAccumulator = new Uint8Array(STREAM_CHUNK_SIZE)
      let accumulatorOffset = 0

      while (true) {
        if (signal.aborted) {
          reader.cancel()
          return
        }

        const { done, value } = await reader.read()
        if (done) break

        if (value) {
          if (
            accumulatorOffset + value.byteLength >
            bufferAccumulator.byteLength
          ) {
            const newSize = Math.max(
              bufferAccumulator.byteLength * 2,
              accumulatorOffset + value.byteLength
            )
            const expanded = new Uint8Array(newSize)
            expanded.set(bufferAccumulator.subarray(0, accumulatorOffset))
            bufferAccumulator = expanded
          }
          bufferAccumulator.set(value, accumulatorOffset)
          accumulatorOffset += value.byteLength

          // 达到分块大小时 flush 到 SourceBuffer
          if (accumulatorOffset >= STREAM_CHUNK_SIZE) {
            const chunk = bufferAccumulator
              .subarray(0, accumulatorOffset)
              .slice()
            await appendBuffer(sb, chunk)
            ctx.downloadedBytes += chunk.byteLength

            // 首次 append 成功后通知调用方，让播放器尽早启动
            if (!initialNotified) {
              initialNotified = true
              onInitialAppend?.()
            }

            await pruneSourceBuffer(sb, video.currentTime)
            bufferAccumulator = new Uint8Array(STREAM_CHUNK_SIZE)
            accumulatorOffset = 0
          }
        }
      }

      // flush 剩余数据
      if (accumulatorOffset > 0) {
        const chunk = bufferAccumulator.subarray(0, accumulatorOffset).slice()
        await appendBuffer(sb, chunk)
        ctx.downloadedBytes += chunk.byteLength
        if (!initialNotified) {
          initialNotified = true
          onInitialAppend?.()
        }
      }

      return
    } catch (err) {
      if (signal.aborted) return
      retryCount += 1
      if (retryCount > MAX_FETCH_RETRIES) {
        throw new Error(
          `媒体流下载失败（已重试 ${MAX_FETCH_RETRIES} 次）: ${(err as Error).message}`,
          { cause: err }
        )
      }
      console.warn(
        `[mse] 流式下载中断，${retryCount}/${MAX_FETCH_RETRIES} 次重试，已下载 ${ctx.downloadedBytes} 字节`,
        err
      )
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/**
 * 通过 MediaSource Extensions 将 B站 DASH 格式的视频与音频流式合并到传入的 <video> 元素。
 *
 * 与旧实现的核心差异：
 * - 流式分块下载 + 增量 appendBuffer，边下边播，不再一次性加载整个文件到内存。
 * - 定期清理已播放 buffer，长时间播放不会因 SourceBuffer 溢出卡死。
 * - 支持 fetch 中断后断点续传。
 *
 * 返回生成的 blob URL 及取消控制器。
 */
export async function createMseMediaUrl(
  video: HTMLVideoElement,
  videoUrl: string,
  audioUrl: string,
  videoCodec?: string,
  audioCodec?: string
): Promise<string> {
  resetVideoElement(video)

  const mediaSource = new MediaSource()
  const objectUrl = URL.createObjectURL(mediaSource)
  const abortController = new AbortController()

  // 将 controller 挂到 video 元素上，便于切换时中止
  ;(
    video as unknown as { _mseAbortController?: AbortController }
  )._mseAbortController = abortController

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

        // 初始数据就绪标志：视频和音频都完成首次 append 后让播放器开始播放
        let videoInitialDone = false
        let audioInitialDone = false
        let settled = false

        const tryResolve = () => {
          if (!settled && videoInitialDone && audioInitialDone) {
            settled = true
            resolve()
          }
        }

        // 视频和音频流并行下载，各自独立分块 append。
        // 首次 append 后即 resolve，让播放器尽早启动；后续数据在后台继续加载。
        const videoPromise = streamToSourceBuffer({
          sb: videoSb,
          url: videoUrl,
          video,
          signal: abortController.signal,
          downloadedBytes: 0,
          onInitialAppend: () => {
            videoInitialDone = true
            tryResolve()
          },
        })

        const audioPromise = streamToSourceBuffer({
          sb: audioSb,
          url: audioUrl,
          video,
          signal: abortController.signal,
          downloadedBytes: 0,
          onInitialAppend: () => {
            audioInitialDone = true
            tryResolve()
          },
        })

        // 后台等待全部下载完成，完成后结束流。
        // 不阻塞 resolve —— 播放器已在初始数据就绪后开始播放。
        Promise.all([videoPromise, audioPromise])
          .then(() => {
            if (
              !abortController.signal.aborted &&
              mediaSource.readyState === 'open'
            ) {
              mediaSource.endOfStream()
            }
          })
          .catch((err) => {
            // 初始阶段失败才 reject；后台阶段失败仅记录，播放器仍可播放已下载部分
            if (!settled) {
              settled = true
              try {
                resetVideoElement(video)
                URL.revokeObjectURL(objectUrl)
              } catch {
                // ignore
              }
              reject(err)
            } else {
              console.error(
                '[mse] 后台流式下载失败，播放器将播放已加载部分:',
                err
              )
            }
          })
      } catch (err) {
        try {
          resetVideoElement(video)
          URL.revokeObjectURL(objectUrl)
        } catch {
          // ignore cleanup errors
        }
        reject(err)
      }
    }

    const signal = abortController.signal

    mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true })
    mediaSource.addEventListener('error', (e) => reject(e), { once: true })

    setTimeout(() => {
      if (!signal.aborted) {
        abortController.abort()
        reject(new Error('MediaSource 打开超时'))
      }
    }, 30000)
  })

  return objectUrl
}

/**
 * 等待 video 元素 metadata 加载完成（readyState >= 1）。
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
 * 会先中止旧的流式下载，避免后台继续下载浪费带宽。
 */
export async function reattachMseStream(
  video: HTMLVideoElement,
  options: ReattachMseStreamOptions
): Promise<string> {
  // 中止旧的流式下载
  const oldController = (
    video as unknown as { _mseAbortController?: AbortController }
  )._mseAbortController
  if (oldController) {
    oldController.abort()
  }

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
      // 某些浏览器在 MSE endOfStream 后 seek 可能抛错
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

/**
 * 使用 hls.js 将 m3u8 流挂载到 <video> 元素。
 * Safari 原生支持 HLS（直接设置 src），其他浏览器通过 hls.js 附加。
 * 返回的 cleanup 函数用于卸载 hls 实例并清理资源。
 */
export function attachHlsStream(
  video: HTMLVideoElement,
  url: string
): () => void {
  resetVideoElement(video)

  // Safari 原生支持 HLS
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
    video.load()
    return () => {
      try {
        video.pause()
      } catch {
        // ignore
      }
      video.removeAttribute('src')
      video.load()
    }
  }

  if (!Hls.isSupported()) {
    throw new Error('当前浏览器不支持 HLS 播放且 hls.js 不可用')
  }

  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
  })
  hls.attachMedia(video)
  hls.on(Hls.Events.MEDIA_ATTACHED, () => {
    hls.loadSource(url)
  })

  return () => {
    try {
      hls.destroy()
    } catch {
      // ignore
    }
  }
}

/**
 * 使用 flv.js 将 FLV 流挂载到 <video> 元素。
 * 返回的 cleanup 函数用于卸载 flv 实例并清理资源。
 */
export function attachFlvStream(
  video: HTMLVideoElement,
  url: string
): () => void {
  if (!flvjs.isSupported()) {
    throw new Error('当前浏览器不支持 FLV 播放且 flv.js 不可用')
  }

  resetVideoElement(video)

  const player = flvjs.createPlayer(
    {
      type: 'flv',
      url,
      isLive: false,
      cors: true,
    },
    {
      enableWorker: false,
      lazyLoad: false,
    }
  )
  player.attachMediaElement(video)
  player.load()

  return () => {
    try {
      player.pause()
      player.unload()
      player.detachMediaElement()
      player.destroy()
    } catch {
      // ignore
    }
  }
}
