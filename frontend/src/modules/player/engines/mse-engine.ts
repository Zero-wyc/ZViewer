/**
 * MSE 引擎：通过 MediaSource Extensions 将 DASH 格式的视频与音频流式合并。
 *
 * 核心特性：
 * - 流式分块下载 + 增量 appendBuffer，边下边播（不一次性加载整个文件到内存）
 * - 缓冲前瞻量调控：当前方已缓冲超过 60 秒时暂停下载，避免 SourceBuffer 溢出
 * - QuotaExceededError 恢复：强制清理已播放数据后重试
 * - fetch 断点续传：中断后从已下载位置继续
 * - 降级策略：MSE 失败时（非 DASH 格式）降级为 direct + audio-sync
 *
 * 从旧 msePlayer.ts 抽取，逻辑无变化，仅重组为引擎接口。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'
import { isBilibiliMediaUrl, buildProxyUrl } from '../services/url-proxy'
import {
  appendBuffer,
  isQuotaExceededError,
  getBufferedAhead,
  forcePruneSourceBuffer,
  pruneSourceBuffer,
  clearSourceBuffer,
} from '../services/buffer-manager'
import {
  findInitSegmentSize,
  parseMvhdDuration,
  findFirstMoof,
} from '../services/mp4-parser'
import { createAudioSync } from '../services/audio-sync'
import { apiFetch } from '@/lib/api'

/** 流式下载分块大小（字节）。2MB 在内存占用与 append 开销间取得平衡。 */
const STREAM_CHUNK_SIZE = 2 * 1024 * 1024
/** fetch 断点续传最大重试次数。 */
const MAX_FETCH_RETRIES = 3
/** 前瞻缓冲上限（秒）。超过此值时暂停下载，避免 SourceBuffer 溢出。 */
const TARGET_BUFFER_AHEAD_SECONDS = 60
/** seek 模式下下载文件头部的大小（字节），用于解析 init segment + mvhd。 */
const SEEK_HEAD_SIZE = 512 * 1024
/** seek 模式下扫描 moof 的最大积累数据量（字节），超过则放弃 seek 退回从头下载。 */
const SEEK_MOOF_SCAN_LIMIT = STREAM_CHUNK_SIZE * 4

interface StreamContext {
  sb: SourceBuffer
  url: string
  video: HTMLVideoElement
  signal: AbortSignal
  /** 已下载字节数，用于断点续传。 */
  downloadedBytes: number
  /** 第一次 append 完成后的回调，用于让播放器尽早启动。 */
  onInitialAppend?: () => void
  /**
   * 从特定时间附近开始加载（秒）。
   *
   * 用于 seek 到 SourceBuffer 中已清理的位置时，通过 Range 请求从目标位置附近
   * 开始下载，避免从头下载。MSE 引擎会先下载 init segment（ftyp + moov），
   * 然后通过 mvhd 时长 + Content-Length 估算目标位置的字节偏移，
   * 从该偏移开始下载并扫描 moof 分片边界。
   */
  startTime?: number
}

/**
 * 流式下载媒体并分块 append 到 SourceBuffer。
 * - 使用 ReadableStream 边下边播，不再一次性加载整个文件到内存。
 * - 首次 append 后通过 onInitialAppend 通知调用方，无需等待全部下载即可开始播放。
 * - 支持 fetch 中断后通过 Range 请求断点续传。
 * - **seek 模式**：当 ctx.startTime 设置时，先下载 init segment（ftyp + moov），
 *   然后通过 mvhd 时长 + Content-Length 估算目标位置的字节偏移，从该偏移开始下载。
 *   主循环中扫描数据找到第一个完整的 moof 分片边界后才开始 append，确保数据完整。
 *   如果 seek 模式初始化失败（解析失败或找不到 moof），退回到从头下载。
 * - **缓冲前瞻量调控**：当 SourceBuffer 中已缓冲数据超过 currentTime 前方 60 秒时，
 *   暂停下载等待播放进度推进，避免一次性下载整个视频导致 SourceBuffer 溢出
 *   （QuotaExceededError，Chrome 上限约 150MB）。
 * - **QuotaExceededError 恢复**：若仍发生溢出，强制清理 currentTime 之前的数据并重试。
 * - **reader 取消**：发生错误时主动 cancel reader，避免旧 fetch 残留导致 ERR_ABORTED。
 */
async function streamToSourceBuffer(ctx: StreamContext): Promise<void> {
  const { sb, url, video, signal, onInitialAppend, startTime } = ctx
  let retryCount = 0
  let initialNotified = false
  let initSegmentAppended = false
  /** seek 模式下从哪个字节偏移开始下载媒体数据；0 表示从头下载 */
  let seekOffset = 0

  // ─── Phase 1: seek 模式初始化 ───
  // 先下载文件头部，解析 init segment（ftyp + moov）并 append，
  // 然后通过 mvhd 时长 + Content-Length 估算目标位置的字节偏移。
  // 主循环（Phase 2）从该偏移开始下载，并扫描 moof 分片边界。
  if (startTime !== undefined && startTime > 0) {
    try {
      const proxied = isBilibiliMediaUrl(url)
      const targetUrl = proxied ? buildProxyUrl(url) : url

      // 1. Range 请求下载文件头部
      const headResponse = await apiFetch(targetUrl, {
        headers: { Range: `bytes=0-${SEEK_HEAD_SIZE - 1}` },
        signal,
      })
      if (!headResponse.ok && headResponse.status !== 206) {
        throw new Error(`获取文件头部失败: ${headResponse.status}`)
      }
      const headData = new Uint8Array(await headResponse.arrayBuffer())

      // 2. 解析 init segment 边界（ftyp + moov）
      const initSize = findInitSegmentSize(headData)
      if (initSize === null) throw new Error('未找到 init segment')

      // 3. append init segment 到 SourceBuffer
      const initData = headData.subarray(0, initSize).slice()
      await appendBuffer(sb, initData)
      initSegmentAppended = true

      // 4. 解析 mvhd 获取媒体时长
      const durationInfo = parseMvhdDuration(headData)

      // 5. 从 Content-Range 获取文件总大小
      let totalSize: number | null = null
      const contentRange = headResponse.headers.get('Content-Range')
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)/)
        if (match) totalSize = parseInt(match[1], 10)
      }

      // 6. 估算目标位置的字节偏移
      if (durationInfo && totalSize) {
        const ratio = Math.min(0.99, Math.max(0, startTime / durationInfo.duration))
        // 向前偏移约 5s 的数据量，确保覆盖目标位置（估算不精确时的容错）
        const margin = (5 / durationInfo.duration) * totalSize
        seekOffset = Math.max(initSize, Math.floor(ratio * totalSize - margin))
      } else {
        // 无法估算时长或文件大小，从 init segment 之后开始下载
        seekOffset = initSize
      }

      ctx.downloadedBytes = seekOffset
    } catch (err) {
      if (signal.aborted) return
      console.warn('[mse] seek 模式初始化失败，退回到从头下载:', err)
      seekOffset = 0
      ctx.downloadedBytes = 0
      // 清除已 append 的 init segment，让主循环从头重新加载
      if (initSegmentAppended) {
        try {
          await clearSourceBuffer(sb)
          initSegmentAppended = false
        } catch {
          // ignore
        }
      }
    }
  }

  // ─── Phase 2: 主下载循环 ───
  while (true) {
    if (signal.aborted) return

    // reader 声明在外层，便于 catch 中取消
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null

    try {
      const proxied = isBilibiliMediaUrl(url)
      const targetUrl = proxied ? buildProxyUrl(url) : url

      // 浏览器禁用 Referer/User-Agent 等 forbidden header，设置无效；
      // B站 防盗链由后端 /api/stream/proxy 添加头处理。
      // 认证通过 httpOnly cookie 自动携带（apiFetch 内部 credentials: 'include'）。
      const headers: Record<string, string> = {}

      // 断点续传 / seek 模式：从已下载位置继续
      if (ctx.downloadedBytes > 0) {
        headers.Range = `bytes=${ctx.downloadedBytes}-`
      }

      const response = await apiFetch(targetUrl, { headers, signal })
      if (!response.ok && response.status !== 206) {
        throw new Error(
          `获取媒体失败: ${response.status} ${response.statusText}`
        )
      }

      if (!response.body) {
        throw new Error('响应体为空')
      }

      reader = response.body.getReader()
      let bufferAccumulator = new Uint8Array(STREAM_CHUNK_SIZE)
      let accumulatorOffset = 0
      // seek 模式下从中间位置开始下载，数据开头可能不是完整的 box，
      // 需要扫描找到第一个完整的 moof 分片边界后才开始 append。
      // 从头下载或已找到 moof 后不需要此步骤。
      const needFindMoof = seekOffset > 0 && !initialNotified
      let foundMoof = !needFindMoof

      while (true) {
        if (signal.aborted) {
          reader.cancel()
          return
        }

        // 缓冲前瞻量调控：当前方已缓冲超过 TARGET_BUFFER_AHEAD_SECONDS 时，
        // 暂停读取，等待播放进度推进到 RESUME_BUFFER_AHEAD_SECONDS 以下再继续。
        // 这是防止 SourceBuffer 溢出的核心机制 —— 避免一次性把整个视频下载到内存。
        if (initialNotified) {
          const bufferedAhead = getBufferedAhead(sb, video.currentTime)
          if (bufferedAhead > TARGET_BUFFER_AHEAD_SECONDS) {
            // 等待 1 秒后重新检查，期间播放进度会推进
            await new Promise((r) => setTimeout(r, 1000))
            // 等待期间可能被 abort
            if (signal.aborted) {
              reader.cancel()
              return
            }
            // 顺便清理已播放数据
            await pruneSourceBuffer(sb, video.currentTime)
            continue
          }
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

          // seek 模式：扫描数据找到第一个完整的 moof 分片边界
          if (!foundMoof) {
            const data = bufferAccumulator.subarray(0, accumulatorOffset)
            const moofOffset = findFirstMoof(data)
            if (moofOffset !== null) {
              // 丢弃 moof 之前的不完整数据
              const remaining = data.subarray(moofOffset)
              bufferAccumulator = new Uint8Array(STREAM_CHUNK_SIZE)
              bufferAccumulator.set(remaining)
              accumulatorOffset = remaining.length
              foundMoof = true
            } else {
              // 继续读取更多数据
              if (accumulatorOffset > SEEK_MOOF_SCAN_LIMIT) {
                // 积累太多数据仍未找到 moof，放弃 seek 模式
                throw new Error('未找到 moof 分片边界，退回到从头下载')
              }
              continue
            }
          }

          // 达到分块大小时 flush 到 SourceBuffer
          if (accumulatorOffset >= STREAM_CHUNK_SIZE) {
            const chunk = bufferAccumulator
              .subarray(0, accumulatorOffset)
              .slice()

            // 处理 QuotaExceededError：强制清理后重试一次
            try {
              await appendBuffer(sb, chunk)
            } catch (appendErr) {
              if (isQuotaExceededError(appendErr) && !signal.aborted) {
                console.warn(
                  '[mse] SourceBuffer 配额溢出，强制清理已播放数据后重试'
                )
                await forcePruneSourceBuffer(sb, video.currentTime)
                // 重试一次，若仍失败则放弃此分块（不抛错，让播放器播放已加载部分）
                try {
                  await appendBuffer(sb, chunk)
                } catch (retryErr) {
                  console.error(
                    '[mse] 强制清理后仍无法 append，停止下载此流:',
                    retryErr
                  )
                  // 优雅退出，不抛错 —— 播放器将播放已加载部分
                  try {
                    reader.cancel()
                  } catch {
                    // ignore
                  }
                  return
                }
              } else {
                throw appendErr
              }
            }
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
      if (accumulatorOffset > 0 && foundMoof) {
        const chunk = bufferAccumulator.subarray(0, accumulatorOffset).slice()
        try {
          await appendBuffer(sb, chunk)
        } catch (appendErr) {
          if (isQuotaExceededError(appendErr) && !signal.aborted) {
            await forcePruneSourceBuffer(sb, video.currentTime)
            try {
              await appendBuffer(sb, chunk)
            } catch {
              // 忽略尾部分块失败
            }
          } else {
            throw appendErr
          }
        }
        ctx.downloadedBytes += chunk.byteLength
        if (!initialNotified) {
          initialNotified = true
          onInitialAppend?.()
        }
      }

      return
    } catch (err) {
      // 主动取消 reader，避免旧 fetch 残留导致浏览器报 ERR_ABORTED
      if (reader) {
        try {
          reader.cancel()
        } catch {
          // ignore
        }
      }
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
      // 如果是找 moof 失败，退回到从头下载
      if (
        err instanceof Error &&
        err.message.includes('未找到 moof') &&
        seekOffset > 0
      ) {
        console.warn('[mse] seek 模式找 moof 失败，退回到从头下载')
        seekOffset = 0
        ctx.downloadedBytes = 0
        if (initSegmentAppended) {
          try {
            await clearSourceBuffer(sb)
            initSegmentAppended = false
          } catch {
            // ignore
          }
        }
        retryCount = 0
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

/**
 * 通过 MediaSource Extensions 将 B站 DASH 格式的视频与音频流式合并到传入的 <video> 元素。
 *
 * 返回生成的 blob URL 及取消控制器。
 * Promise 在视频和音频都完成首次 append 后 resolve，让播放器尽早启动；后续数据在后台继续加载。
 */
export async function createMseMediaUrl(
  video: HTMLVideoElement,
  videoUrl: string,
  audioUrl: string,
  videoCodec?: string,
  audioCodec?: string,
  /** seek 模式：从该时间附近开始加载（秒），用于 seek 到已清理区域 */
  startTime?: number
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
    let settled = false

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
          startTime,
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
          startTime,
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
              // 不调用 resetVideoElement(video)！
              // 因为此时 video.src 可能已被新的 createMseMediaUrl 调用替换，
              // resetVideoElement 会破坏新的 MediaSource，导致连锁失败。
              // 仅 abort 当前 controller（中止本次的 fetch）+ revoke 本次 objectUrl。
              try {
                abortController.abort()
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
        if (!settled) {
          settled = true
          try {
            abortController.abort()
          } catch {
            // ignore
          }
        }
        reject(err)
      }
    }

    // 监听 sourceclose：当 video.src 被外部清空（如新的 applySourceToVideo 调用），
    // MediaSource 会被关闭。此时应 abort 本次的 fetch 并 reject，
    // 避免后续 appendBuffer 失败触发 catch 块中的 resetVideoElement(video)，
    // 进而破坏新的 MediaSource（连锁反应导致 ERR_ABORTED）。
    const onSourceClose = () => {
      if (settled) return
      settled = true
      try {
        abortController.abort()
      } catch {
        // ignore
      }
      reject(new Error('MediaSource 已被关闭'))
    }

    const signal = abortController.signal

    mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true })
    mediaSource.addEventListener('sourceclose', onSourceClose, { once: true })
    mediaSource.addEventListener(
      'error',
      (e) => {
        if (settled) return
        settled = true
        reject(e)
      },
      { once: true }
    )

    setTimeout(() => {
      if (!settled && !signal.aborted) {
        abortController.abort()
        settled = true
        reject(new Error('MediaSource 打开超时'))
      }
    }, 30000)
  })

  return objectUrl
}

/**
 * MSE 引擎实现。
 *
 * attach 流程：
 * 1. 尝试 MSE 合并（createMseMediaUrl）
 * 2. MSE 失败且非 DASH 格式时，降级为 direct + audio-sync
 * 3. 返回 cleanup（abort controller）与 blobUrl
 */
export const mseEngine: PlayerEngine = {
  type: 'mse',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    const audioUrl = source.audioUrl || ''

    // 无音频 URL 时无法 MSE 合并，直接走 direct
    if (!audioUrl) {
      video.src = source.url
      video.load()
      await waitForMetadata(video)
      return { cleanup: () => {} }
    }

    try {
      const blobUrl = await createMseMediaUrl(
        video,
        source.url,
        audioUrl,
        source.videoCodec,
        source.audioCodec,
        source.startTime
      )
      return {
        blobUrl,
        cleanup: () => {
          // MSE 的 abort 由 video 元素上的 _mseAbortController 管理
          // 调用方在切换前会通过 resetVideoElement 触发 sourceclose
          // 此处不需要额外操作
        },
      }
    } catch (err) {
      // DASH 源的 sourceUrl 是 m4s 片段，不能直接作为 video.src 播放
      if (source.format === 'dash') {
        throw new Error('MSE 合并失败，DASH 源无法直接播放', { cause: err })
      }
      // 非 DASH 格式（如 anime 带独立音频轨）降级为 direct + audio-sync
      console.warn('[mse-engine] MSE 合并失败，降级为音频同步:', err)
      video.src = source.url
      video.load()
      await waitForMetadata(video)
      const audioCleanup = createAudioSync(video, audioUrl)
      return { cleanup: audioCleanup }
    }
  },
}
