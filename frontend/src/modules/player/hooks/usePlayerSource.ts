/**
 * usePlayerSource Hook
 *
 * 负责将 PlayerSource 应用到 <video> 元素，使用 selectEngine 选择合适的引擎并调用 attach。
 *
 * 核心职责：
 * 1. 引擎选择与 attach（MSE / HLS / FLV / Direct）
 * 2. 资源清理（blobUrl / audioSync / engine cleanup）
 * 3. appliedSourceUrl 跟踪：避免同一源被重复加载
 * 4. 旧 MSE controller 显式 abort：防止并发 attach 互相破坏
 *
 * 该 Hook 是引擎无关的：不关心是房主还是观众，也不依赖 WatchTogetherState。
 * 调用方（如 sync-playback/useVideoSource）负责传入 PlayerSource 与处理副作用。
 */
import { useCallback, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { selectEngine, resetVideoElement } from '@/modules/player'
import type { PlayerSource } from '@/modules/player'
import {
  isBrowserPlayableFormat,
  getUnsupportedFormatMessage,
} from '@/lib/mediaFormat'

export interface UsePlayerSourceOptions {
  videoRef: RefObject<HTMLVideoElement | null>
}

export interface UsePlayerSourceReturn {
  /**
   * 将媒体源应用到 video 元素。
   *
   * - 同一 sourceUrl 不重复加载（通过 appliedSourceUrlRef 跟踪）
   * - 格式预检：浏览器不支持的格式直接抛错
   * - 切换前先 abort 旧 MSE controller + resetVideoElement + cleanup
   * - 失败时回滚 appliedSourceUrlRef，允许下次重试
   *
   * @returns Promise 在 metadata 就绪后 resolve（readyState >= 1）
   */
  attachSource: (video: HTMLVideoElement, source: PlayerSource) => Promise<void>
  /** 清理所有引擎资源（blobUrl / audioSync / engine cleanup） */
  cleanup: () => void
  /** 当前已应用的 sourceUrl（用于去重与 seek-to-unbuffered 逻辑） */
  appliedSourceUrlRef: MutableRefObject<string | null>
}

export function usePlayerSource(
  _options: UsePlayerSourceOptions
): UsePlayerSourceReturn {
  const blobUrlRef = useRef<string | null>(null)
  const engineCleanupRef = useRef<(() => void) | null>(null)
  const appliedSourceUrlRef = useRef<string | null>(null)

  const cleanup = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
    if (engineCleanupRef.current) {
      engineCleanupRef.current()
      engineCleanupRef.current = null
    }
  }, [])

  const attachSource = useCallback(
    async (video: HTMLVideoElement, source: PlayerSource) => {
      if (!source.url) return

      // 同一 sourceUrl 不重复加载
      if (appliedSourceUrlRef.current === source.url) {
        return
      }

      // 格式预检：浏览器 <video> 仅原生支持 mp4/webm/mov，DASH 通过 MSE 支持。
      // mkv/avi/flv/wmv/ts 等容器直接赋值会抛 NotSupportedError。
      // 预检放在更新 appliedSourceUrlRef 之前，失败时不污染"已应用"标记。
      if (source.format && !isBrowserPlayableFormat(source.format)) {
        throw new Error(getUnsupportedFormatMessage(source.format))
      }

      const previousUrl = appliedSourceUrlRef.current
      appliedSourceUrlRef.current = source.url

      // 先 abort 旧的 MSE controller，确保正在进行中的 fetch 被正确中止。
      // 否则旧的 fetch 完成后 appendBuffer 失败会触发 catch 块，
      // 可能调用 resetVideoElement(video) 破坏新的 MediaSource（连锁反应）。
      const oldController = (
        video as unknown as { _mseAbortController?: AbortController }
      )._mseAbortController
      if (oldController) {
        try {
          oldController.abort()
        } catch {
          // ignore
        }
      }

      // 先 detach 旧的 MediaSource，再清理 blob URL，
      // 避免 revoke 正在 attached 的 URL 导致 Format error
      resetVideoElement(video)
      cleanup()

      try {
        const engine = selectEngine(source)
        const result = await engine.attach(video, source)
        if (result.blobUrl) {
          blobUrlRef.current = result.blobUrl
        }
        engineCleanupRef.current = result.cleanup
      } catch (err) {
        // 加载失败时回滚 appliedSourceUrlRef，允许下次重试
        appliedSourceUrlRef.current = previousUrl
        throw err
      }
    },
    [cleanup]
  )

  return {
    attachSource,
    cleanup,
    appliedSourceUrlRef,
  }
}
