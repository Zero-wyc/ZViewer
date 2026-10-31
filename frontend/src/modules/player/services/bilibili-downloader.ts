/**
 * B站 m4s 流下载器（缓冲模式专用）。
 *
 * 设计目标：
 * - 通过服务器代理完整下载 B站 DASH video/audio m4s 流到 IndexedDB
 * - 服务器代理负责注入 Referer/User-Agent 绕过 B站 CDN 防盗链
 * - 流式下载（ReadableStream），支持大文件（数百 MB）且内存占用稳定
 * - 实时进度回调（已下载字节数 / 总字节数）
 * - 支持 AbortController 取消下载
 * - 缓存完成后播放期间零网络流量
 *
 * 工作流程：
 * 1. fetch 服务器代理 URL（带 credentials，用于登录态校验）
 * 2. 代理注入 Referer: https://www.bilibili.com 绕过 B站 CDN 防盗链
 * 3. 从 Content-Length 读取总大小
 * 4. 通过 ReadableStream 流式读取，累积到 Blob
 * 5. 每下载 1MB 触发一次进度回调
 * 6. 完成后写入 IndexedDB，后续播放从 blob URL 加载，零网络流量
 *
 * Cookie 策略：
 * - 全局使用房主解析出的 URL（房主解析时使用自己的 B站 cookie）
 * - m4s URL 自带签名参数，下载时通过服务器代理注入防盗链 headers
 * - 代理请求带 credentials: 'include' 复用 ZControl 登录态
 *
 * 错误处理：
 * - 网络中断：throw DownloadError，调用方清理 IndexedDB 中半成品
 * - B站源 URL 过期（403/404）：throw UrlExpiredError，调用方重新解析
 */

import { resolveProxyUrl } from './url-proxy'
import { t } from '@/i18n'

/** 下载进度回调签名 */
export type ProgressCallback = (
  downloadedBytes: number,
  totalBytes: number
) => void

export class DownloadError extends Error {
  statusCode?: number

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'DownloadError'
    this.statusCode = statusCode
  }
}

export class UrlExpiredError extends DownloadError {
  constructor(message: string) {
    super(message, 403)
    this.name = 'UrlExpiredError'
  }
}

export class DownloadAbortedError extends DownloadError {
  constructor() {
    super(t('下载已取消'))
    this.name = 'DownloadAbortedError'
  }
}

/** 进度回调节流间隔（避免每个 chunk 都触发回调导致 UI 卡顿） */
const PROGRESS_THROTTLE_BYTES = 1024 * 1024 // 每下载 1MB 触发一次

/**
 * 下载单个 m4s 流到 Blob（通过服务器代理绕过防盗链）。
 *
 * @param originalUrl B站 m4s 原始 URL（含 deadline 签名）
 * @param onProgress 进度回调（已下载字节数, 总字节数）
 * @param signal AbortSignal，用于取消下载
 * @returns Blob 数据
 */
export async function downloadM4sStream(
  originalUrl: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<Blob> {
  // 通过服务器代理下载：代理注入 Referer/Origin 绕过 B站 CDN 防盗链
  // 浏览器无法设置 Referer 头（forbidden header），必须走代理
  const proxyUrl = resolveProxyUrl(originalUrl, undefined, 'dash')

  const response = await fetch(proxyUrl, {
    credentials: 'include',
    signal,
  })

  if (!response.ok) {
    if (response.status === 403 || response.status === 410) {
      throw new UrlExpiredError(
        t('B站 URL 已过期或被拒绝（HTTP {{status}}），请重新解析', {
          status: response.status,
        })
      )
    }
    throw new DownloadError(
      t('下载失败: HTTP {{status}} {{statusText}}', {
        status: response.status,
        statusText: response.statusText,
      }),
      response.status
    )
  }

  // 从 Content-Length 读取总大小（B站 CDN 通常返回此头）
  const contentLength = response.headers.get('Content-Length')
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0

  if (!response.body) {
    // 无 stream API 兜底：直接 arrayBuffer（一次性加载到内存）
    const buf = await response.arrayBuffer()
    onProgress?.(buf.byteLength, buf.byteLength)
    return new Blob([buf], { type: 'video/mp4' })
  }

  // 流式读取
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let downloadedBytes = 0
  let lastProgressBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      chunks.push(value)
      downloadedBytes += value.byteLength

      // 节流进度回调
      if (
        onProgress &&
        downloadedBytes - lastProgressBytes >= PROGRESS_THROTTLE_BYTES
      ) {
        onProgress(downloadedBytes, totalBytes)
        lastProgressBytes = downloadedBytes
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      throw new DownloadAbortedError()
    }
    throw new DownloadError(
      t('流式下载失败: {{value}}', {
        value: err instanceof Error ? err.message : String(err),
      })
    )
  }

  // 最终进度回调
  onProgress?.(downloadedBytes, totalBytes || downloadedBytes)

  // 合并所有 chunks 到一个 Blob
  // 使用 Uint8Array[] 而非 Blob[] 直接合并，避免大 Blob 性能问题
  return new Blob(chunks as BlobPart[], { type: 'video/mp4' })
}

/**
 * 并行下载 B站 DASH video + audio 流。
 *
 * 同时下载两个流，独立进度回调，allSettled 等待全部完成。
 * 任一流失败则抛出对应错误，调用方决定是否清理已成功的另一流。
 *
 * @param videoUrl 视频 m4s URL
 * @param audioUrl 音频 m4s URL
 * @param onProgress 总进度回调（已下载字节数, 总字节数）
 * @param signal AbortSignal
 * @returns { videoBlob, audioBlob, totalBytes }
 */
export async function downloadBilibiliDashStreams(
  videoUrl: string,
  audioUrl: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal
): Promise<{
  videoBlob: Blob
  audioBlob: Blob
  totalBytes: number
}> {
  // 预查询两个流的总大小（HEAD 请求获取 Content-Length）
  const [videoSize, audioSize] = await Promise.all([
    queryContentSize(videoUrl, signal),
    queryContentSize(audioUrl, signal),
  ])
  const totalBytes = videoSize + audioSize

  console.log(
    `[bilibili-downloader] 总大小: video=${(videoSize / 1024 / 1024).toFixed(1)}MB, ` +
      `audio=${(audioSize / 1024 / 1024).toFixed(1)}MB, ` +
      `total=${(totalBytes / 1024 / 1024).toFixed(1)}MB`
  )

  // 已下载字节数（两个流共享）
  let videoDownloaded = 0
  let audioDownloaded = 0

  const reportProgress = () => {
    onProgress?.(videoDownloaded + audioDownloaded, totalBytes)
  }

  // 并行下载两个流
  const [videoResult, audioResult] = await Promise.all([
    downloadM4sStream(
      videoUrl,
      (d) => {
        videoDownloaded = d
        reportProgress()
      },
      signal
    ),
    downloadM4sStream(
      audioUrl,
      (d) => {
        audioDownloaded = d
        reportProgress()
      },
      signal
    ),
  ])

  return {
    videoBlob: videoResult,
    audioBlob: audioResult,
    totalBytes,
  }
}

/**
 * 查询文件大小（HEAD 请求获取 Content-Length）。
 *
 * 失败时返回 0，调用方按未知大小处理（仅显示已下载字节数）。
 */
async function queryContentSize(
  url: string,
  signal?: AbortSignal
): Promise<number> {
  try {
    const proxyUrl = resolveProxyUrl(url, undefined, 'dash')
    const response = await fetch(proxyUrl, {
      method: 'HEAD',
      credentials: 'include',
      signal,
    })
    const contentLength = response.headers.get('Content-Length')
    return contentLength ? parseInt(contentLength, 10) : 0
  } catch {
    return 0
  }
}
