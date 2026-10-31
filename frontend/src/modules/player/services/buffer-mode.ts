/**
 * B站 缓冲模式服务：协调 IndexedDB 缓存与 m4s 下载。
 *
 * 房主端和观众端共用此模块，避免代码重复：
 * - 房主端：解析视频后调用此服务缓存 m4s，缓存完成后 attach
 * - 观众端：收到 bufferMode=true 的 state 后调用此服务缓存，缓存完成后 attach
 *
 * 缓存键策略：
 * - 房主端：使用 movie.url（含 BV 号）+ cid + qn
 * - 观众端：无 movie 对象时使用空串 + cid + qn
 * - 同一 cid+qn 对应同一视频流，跨用户缓存键一致（但 IndexedDB 是各自独立存储）
 */
import type { WatchTogetherState } from '@/modules/sync-playback/types'
import {
  buildCacheKey,
  getCacheEntry,
  setCacheEntry,
  deleteCacheEntry,
  type BufferCacheEntry,
} from './buffer-cache'
import {
  downloadBilibiliDashStreams,
  DownloadError,
  UrlExpiredError,
  DownloadAbortedError,
} from './bilibili-downloader'
import { t } from '@/i18n'

export interface BufferProgress {
  /** 已下载字节数 */
  downloaded: number
  /** 总字节数（未知时等于 downloaded） */
  total: number
  /** 视频标题（用于 UI 显示） */
  title: string
}

export interface FetchBlobsOptions {
  /** 房主广播的播放状态（含 sourceUrl/audioUrl/cid/currentQn 等） */
  state: WatchTogetherState
  /** B站 BV 号或影片 URL（房主端可传，观众端可不传） */
  bvid?: string
  /** 视频标题（用于 UI 显示，未提供时使用 "当前视频"） */
  title?: string
  /** 下载进度回调 */
  onProgress?: (progress: BufferProgress) => void
  /** 取消信号 */
  signal?: AbortSignal
}

export interface FetchBlobsResult {
  videoBlob: Blob
  audioBlob: Blob
  /** 缓存键（用于后续清理或追踪） */
  cacheKey: string
  /** 是否命中缓存（true=直接复用，false=刚下载） */
  fromCache: boolean
}

/**
 * 缓冲模式单视频（视频+音频流合计）大小上限：超出则中止下载。
 * 缓冲模式将整片数据驻留内存并写入 IndexedDB，过大的文件会导致
 * 内存峰值过高（OOM/页面崩溃）与超长下载等待。
 */
const MAX_BUFFER_TOTAL_BYTES = 800 * 1024 * 1024 // 800MB

/**
 * 缓冲模式：从 B站 CDN 下载完整 m4s 流到 IndexedDB，缓存命中时直接复用。
 *
 * 流程：
 * 1. 检查 IndexedDB 缓存，命中则直接返回 Blob（fromCache=true）
 * 2. 未命中则下载 video + audio m4s 并存入 IndexedDB
 * 3. 进度通过 onProgress 反馈到 UI（每下载 1MB 触发一次）
 * 4. 总大小超过 MAX_BUFFER_TOTAL_BYTES 时中止下载（外部取消信号转发至内部）
 * 5. 仅当"写入缓存的尝试失败"时清理；下载阶段的失败没有写入任何条目，
 *    不删除（避免误删并发任务刚写入的完整缓存）
 *
 * 错误处理：调用方负责捕获 DownloadError / UrlExpiredError / DownloadAbortedError
 * 并向用户展示对应提示。
 */
export async function fetchBlobsForBufferMode(
  options: FetchBlobsOptions
): Promise<FetchBlobsResult> {
  const { state, bvid = '', title, onProgress, signal } = options

  if (!state.audioUrl || !state.cid) {
    throw new Error(t('缓冲模式需要 DASH 源的 audioUrl 和 cid'))
  }

  const cacheKey = buildCacheKey(bvid, state.cid, state.currentQn)
  const displayTitle = title || t('当前视频')

  // 命中缓存：直接返回 Blob
  const cached = await getCacheEntry(cacheKey)
  if (cached) {
    console.log(
      `[buffer-mode] 缓冲模式命中缓存: ${cacheKey}, ` +
        `video=${(cached.videoBlob.size / 1024 / 1024).toFixed(1)}MB, ` +
        `audio=${(cached.audioBlob.size / 1024 / 1024).toFixed(1)}MB`
    )
    return {
      videoBlob: cached.videoBlob,
      audioBlob: cached.audioBlob,
      cacheKey,
      fromCache: true,
    }
  }

  // 未命中：下载 m4s 流
  console.log(`[buffer-mode] 缓冲模式开始下载: ${cacheKey}`)

  // 内部取消器：组合"外部取消（切源/卸载）"与"超大小上限主动中止"
  const externalSignal = signal
  const internalController = new AbortController()
  const forwardAbort = () => internalController.abort()
  externalSignal?.addEventListener('abort', forwardAbort)
  let overLimit = false
  /** 是否已尝试写入缓存（用于失败时精确清理） */
  let writeAttempted = false

  try {
    onProgress?.({ downloaded: 0, total: 1, title: displayTitle })

    const { videoBlob, audioBlob, totalBytes } =
      await downloadBilibiliDashStreams(
        state.sourceUrl,
        state.audioUrl,
        (downloaded, total) => {
          // 首次得知总大小即检查上限，超限立即中止（不继续拉满带宽）
          if (total > MAX_BUFFER_TOTAL_BYTES && !overLimit) {
            overLimit = true
            internalController.abort()
            return
          }
          onProgress?.({
            downloaded,
            total: total || downloaded,
            title: displayTitle,
          })
        },
        internalController.signal
      )

    // 写入 IndexedDB
    const entry: BufferCacheEntry = {
      key: cacheKey,
      bvid,
      cid: state.cid,
      qn: state.currentQn ?? 0,
      videoBlob,
      audioBlob,
      videoCodec: state.videoCodec,
      audioCodec: state.audioCodec,
      duration: state.duration,
      title,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    }
    writeAttempted = true
    await setCacheEntry(entry)

    console.log(
      `[buffer-mode] 缓冲模式下载完成: ${(totalBytes / 1024 / 1024).toFixed(1)}MB`
    )
    return { videoBlob, audioBlob, cacheKey, fromCache: false }
  } catch (err) {
    // 超大小上限被中止 → 转为明确提示（调用方按 DownloadError 展示）
    if (overLimit && err instanceof DownloadAbortedError) {
      throw new DownloadError(
        t(
          '视频过大（超过 {{value}}MB），已取消缓冲下载；请关闭缓冲模式或切换更低清晰度',
          { value: Math.round(MAX_BUFFER_TOTAL_BYTES / 1024 / 1024) }
        )
      )
    }
    // 仅当写入缓存的尝试失败时才清理（IndexedDB 单条 put 失败通常原子回滚，
    // 此处兜底）；下载阶段的失败没有写入任何条目，不删除——
    // 否则会误删并发任务（如另一端同 key 下载）刚写入的完整缓存。
    if (writeAttempted) {
      await deleteCacheEntry(cacheKey).catch(() => {
        /* 清理失败不影响错误上抛 */
      })
    }
    throw err
  } finally {
    externalSignal?.removeEventListener('abort', forwardAbort)
  }
}

export { DownloadError, UrlExpiredError, DownloadAbortedError }
