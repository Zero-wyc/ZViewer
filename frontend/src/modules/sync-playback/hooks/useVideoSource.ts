import { useCallback, useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useRoomStore } from '@/store/roomStore'
import { message } from '@/components/ui/message'
import {
  createMseMediaUrl,
  createAudioSync,
  resetVideoElement,
  waitForMetadata,
} from '@/modules/room/watch-together/msePlayer'
import type { WatchTogetherState } from '../types'
import { safePlay } from '../safePlay'
import {
  isBrowserPlayableFormat,
  getUnsupportedFormatMessage,
} from '@/lib/mediaFormat'

export interface UseVideoSourceOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  watchTogether: WatchTogetherState
  /** 房主标识 ref。用于在挂载恢复 effect 中跳过房主，由 loadMovie 全权处理加载，
   *  避免恢复 effect 与 loadMovie 并发调用 applySourceToVideo 导致 MSE attach 互相 abort。 */
  isHostRef: MutableRefObject<boolean>
}

export interface UseVideoSourceReturn {
  applySourceToVideo: (
    video: HTMLVideoElement,
    state: WatchTogetherState
  ) => Promise<void>
  cleanupMedia: () => void
  restoredRef: MutableRefObject<boolean>
}

/**
 * 视频源管理 Hook：负责将 WatchTogetherState 中的视频源应用到 <video> 元素，
 * 包括 MSE DASH 合并、音频同步、以及组件挂载时的源恢复。
 *
 * 观众端不再独立解析 B站 视频，所有源类型统一使用房主广播的
 * sourceUrl/audioUrl 进行 MSE attach，避免凭证不一致与 CDN 限流。
 * 内部维护 mseBlobUrlRef / audioSyncRef 用于资源清理，
 * restoredRef 保证每个挂载周期只恢复一次源，避免与 handleLoad / handleState 重复加载。
 *
 * 房主端在挂载时若 roomStore 中存在 currentMovieId，跳过恢复 effect，
 * 交由 useWatchTogether.loadMovie 重新解析 B站 并加载最新地址，
 * 避免两个 effect 并发调用 applySourceToVideo 导致 MSE 互相 abort。
 */
export function useVideoSource({
  videoRef,
  suppressEventsRef,
  watchTogether,
  isHostRef,
}: UseVideoSourceOptions): UseVideoSourceReturn {
  const mseBlobUrlRef = useRef<string | null>(null)
  const audioSyncRef = useRef<(() => void) | null>(null)
  const restoredRef = useRef(false)
  // 跟踪当前已应用到 video 元素的原始 sourceUrl（非 blob URL）。
  // 房主每 500ms 广播一次 state，观众端若每次都 resetVideoElement + load，
  // 会导致视频不断重置黑屏。此处通过对比 sourceUrl 避免重复加载。
  const appliedSourceUrlRef = useRef<string | null>(null)

  const cleanupMedia = useCallback(() => {
    if (mseBlobUrlRef.current) {
      URL.revokeObjectURL(mseBlobUrlRef.current)
      mseBlobUrlRef.current = null
    }
    if (audioSyncRef.current) {
      audioSyncRef.current()
      audioSyncRef.current = null
    }
  }, [])

  // 将指定状态中的视频源应用到 video 元素（含 MSE DASH 处理）。
  // 供房主加载、观众同步以及组件重新挂载时恢复使用。
  // 所有源类型（包括 bilibili）统一逻辑：
  //   - DASH / 含 audioUrl：使用 MSE 合并 videoUrl + audioUrl
  //   - 其他格式（如 mp4）：直接设置 video.src
  // 观众端不再独立调用 B站 解析接口，直接复用房主广播的地址。
  const applySourceToVideo = useCallback(
    async (video: HTMLVideoElement, state: WatchTogetherState) => {
      if (!state.sourceUrl) return

      // 同一 sourceUrl 不重复加载：观众端每 500ms 收到一次 state，
      // 若每次都 resetVideoElement + load 会不断重置视频导致黑屏。
      if (appliedSourceUrlRef.current === state.sourceUrl) {
        return
      }

      // 格式预检：浏览器 <video> 仅原生支持 mp4/webm/mov，DASH 通过 MSE 支持。
      // mkv/avi/flv/wmv/ts 等容器直接赋值给 video.src 会抛 NotSupportedError，
      // 部分浏览器还会将 video.src 置空导致黑屏无反馈。这里提前抛错，
      // 由调用方（loadMovie/恢复 effect）展示 message.error 提示用户。
      // 预检放在更新 appliedSourceUrlRef 之前，失败时不污染"已应用"标记，
      // 后续若用户切换到支持的格式仍可正常加载。
      if (state.format && !isBrowserPlayableFormat(state.format)) {
        throw new Error(getUnsupportedFormatMessage(state.format))
      }

      const previousUrl = appliedSourceUrlRef.current
      appliedSourceUrlRef.current = state.sourceUrl

      // 先 detach 旧的 MediaSource，再清理 blob URL，避免 revoke 正在 attached 的 URL 导致 Format error
      resetVideoElement(video)
      cleanupMedia()

      try {
        if (state.format === 'dash' || state.audioUrl) {
          const audioUrl = state.audioUrl || ''
          if (!audioUrl) {
            video.src = state.sourceUrl
            video.load()
            // Bug #7 修复：等待 metadata 加载完成，
            // 否则调用方 .then() 中设置 currentTime 会被浏览器丢弃（readyState < 1）
            await waitForMetadata(video)
            return
          }

          try {
            const blobUrl = await createMseMediaUrl(
              video,
              state.sourceUrl,
              audioUrl,
              state.videoCodec,
              state.audioCodec
            )
            mseBlobUrlRef.current = blobUrl
          } catch (err) {
            // DASH 源的 sourceUrl 是 m4s 片段，不能直接作为 video.src 播放，
            // 直接赋值会导致 MEDIA_ELEMENT_ERROR: Format error。
            if (state.format === 'dash') {
              throw new Error('MSE 合并失败，DASH 源无法直接播放', {
                cause: err,
              })
            }
            console.warn('[useVideoSource] MSE 合并失败，降级为音频同步:', err)
            video.src = state.sourceUrl
            video.load()
            await waitForMetadata(video)
            audioSyncRef.current = createAudioSync(video, audioUrl)
          }
        } else {
          video.src = state.sourceUrl
          video.load()
          // Bug #7 修复：非 MSE 直链同样需要等待 metadata，
          // 观众端 handleState 在 .then() 中设置的 currentTime 才会生效
          await waitForMetadata(video)
        }
      } catch (err) {
        // 加载失败时回滚 appliedSourceUrlRef，允许下次重试
        appliedSourceUrlRef.current = previousUrl
        throw err
      }
    },
    [cleanupMedia]
  )

  // 组件重新挂载（或 videoRef 首次可用）时，从 roomStore 恢复视频源。
  // 通过 restoredRef 保证每个挂载周期只恢复一次，避免与 handleLoad / handleState 重复加载。
  //
  // 房主端：若 roomStore 中存在 currentMovieId，跳过恢复 effect，交由
  // useWatchTogether.loadMovie 重新解析 B站 并加载最新地址。
  // 否则恢复 effect 与 loadMovie 会并发调用 applySourceToVideo，
  // 后者的 resetVideoElement 会 abort 前者的 MSE attach，导致黑屏。
  useEffect(() => {
    const video = videoRef.current
    const storeState = useRoomStore.getState()
    const state = storeState.watchTogether
    if (!video || !state.sourceUrl || restoredRef.current) return

    // 房主有待加载的影片时，让 loadMovie effect 全权处理
    if (isHostRef.current && storeState.currentMovieId) {
      restoredRef.current = true
      return
    }

    restoredRef.current = true
    suppressEventsRef.current = true
    void applySourceToVideo(video, state)
      .then(() => {
        if (state.currentTime > 0) {
          video.currentTime = state.currentTime
        }
        if (video.playbackRate !== state.playbackRate) {
          video.playbackRate = state.playbackRate
        }
        if (state.isPlaying && video.paused) {
          // 组件挂载恢复源时同样需要处理自动播放策略
          void safePlay(video)
        }
        suppressEventsRef.current = false
      })
      .catch((err: unknown) => {
        // MSE attach 失败时必须释放 suppressEventsRef，否则房主端
        // play/pause/seek/timeupdate 事件全部被吞，无法广播 state 给观众，
        // 观众端 appliedSourceUrlRef 永远不更新，导致永久黑屏。
        console.error('[useVideoSource] 恢复视频源失败:', err)
        suppressEventsRef.current = false
        // 向用户展示错误（如不支持的视频格式），避免黑屏无反馈
        message.error(err instanceof Error ? err.message : '视频源加载失败')
      })
  }, [
    watchTogether.sourceUrl,
    applySourceToVideo,
    videoRef,
    suppressEventsRef,
    isHostRef,
  ])

  return {
    applySourceToVideo,
    cleanupMedia,
    restoredRef,
  }
}
