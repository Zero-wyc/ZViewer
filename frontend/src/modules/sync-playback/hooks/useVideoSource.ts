import { useCallback, useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useRoomStore } from '@/store/roomStore'
import { message } from '@/components/ui/message'
import { usePlayerSource } from '@/modules/player'
import type { PlayerSource } from '@/modules/player'
import type { WatchTogetherState } from '../types'
import { safePlay } from '../safePlay'
import { needsMseReloadForSeek, isMseStream, reloadMseAtTime } from '../services'

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
    state: WatchTogetherState,
    startTime?: number
  ) => Promise<void>
  cleanupMedia: () => void
  restoredRef: MutableRefObject<boolean>
  /** 已应用 sourceUrl 的 ref，供观众端 seek 逻辑使用 */
  appliedSourceUrlRef: MutableRefObject<string | null>
}

/**
 * 视频源管理 Hook：负责将 WatchTogetherState 中的视频源应用到 <video> 元素，
 * 包括 MSE DASH 合并、音频同步、以及组件挂载时的源恢复。
 *
 * 底层使用 player 模块的 usePlayerSource 进行引擎选择与 attach。
 * 本 Hook 在其之上扩展：
 * 1. WatchTogetherState → PlayerSource 字段映射
 * 2. 组件挂载时的源恢复（依赖 roomStore，仅观众端或无待加载影片时执行）
 * 3. seek 到未缓冲区域时的 MSE 流重新加载
 *
 * 观众端不再独立解析 B站 视频，所有源类型统一使用房主广播的
 * sourceUrl/audioUrl 进行 MSE attach，避免凭证不一致与 CDN 限流。
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
  const { attachSource, cleanup, appliedSourceUrlRef } = usePlayerSource({
    videoRef,
  })
  const restoredRef = useRef(false)

  // WatchTogetherState → PlayerSource 字段映射
  // PlayerSource 是引擎 attach 所需的最小字段集，从 WatchTogetherState 中抽取
  const toPlayerSource = useCallback(
    (state: WatchTogetherState): PlayerSource => ({
      url: state.sourceUrl,
      audioUrl: state.audioUrl,
      format: state.format,
      videoCodec: state.videoCodec,
      audioCodec: state.audioCodec,
      headers: state.headers,
    }),
    []
  )

  const cleanupMedia = cleanup

  // 将指定状态中的视频源应用到 video 元素（含 MSE DASH 处理）。
  // 供房主加载、观众同步以及组件重新挂载时恢复使用。
  // 所有源类型（包括 bilibili）统一逻辑：
  //   - DASH / 含 audioUrl：使用 MSE 合并 videoUrl + audioUrl
  //   - 其他格式（如 mp4）：直接设置 video.src
  // 观众端不再独立调用 B站 解析接口，直接复用房主广播的地址。
  const applySourceToVideo = useCallback(
    async (video: HTMLVideoElement, state: WatchTogetherState, startTime?: number) => {
      if (!state.sourceUrl) return
      const source = toPlayerSource(state)
      if (startTime !== undefined && startTime > 0) {
        source.startTime = startTime
      }
      await attachSource(video, source)
    },
    [attachSource, toPlayerSource]
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

  // seek 到未缓冲区域时的处理：
  // 当用户回退到 SourceBuffer 中已被清理的位置时，视频会卡死（没有数据可播放）。
  // 此时需要重新创建 MSE 流（从头下载），加载到目标位置后 seek。
  // 仅对 MSE 流（DASH / 含 audioUrl）生效，普通 mp4 直链由浏览器原生处理。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let isReloading = false

    const handleSeeking = () => {
      if (suppressEventsRef.current) return
      if (isReloading) return

      const targetTime = video.currentTime
      // 仅 seek 到过去已清理区域才需要 reload；
      // seek 到未来未缓冲区域时 MSE 会继续下载，浏览器自然等待，无需 reload
      if (!needsMseReloadForSeek(video, targetTime)) return

      // seek 到已清理区域，需要重新加载
      const storeState = useRoomStore.getState()
      const state = storeState.watchTogether
      // 仅 MSE 流需要处理；普通 mp4 直链浏览器会自动处理 seek
      if (!isMseStream(state) || !state.sourceUrl) return

      isReloading = true
      // 写入 store：VideoControls 读取 reloadTargetTime 显示进度条位置（避免归零），
      // WatchTogetherPanel 读取 isReloading 展示加载动画
      storeState.setReloadingState(true, targetTime)

      void reloadMseAtTime({
        video,
        targetTime,
        state,
        applySourceToVideo,
        appliedSourceUrlRef,
        suppressEventsRef,
      })
        .then((result) => {
          if (!result.success && result.message) {
            message.warning(result.message)
          }
        })
        .finally(() => {
          isReloading = false
          useRoomStore.getState().setReloadingState(false, null)
        })
    }

    video.addEventListener('seeking', handleSeeking)
    return () => {
      video.removeEventListener('seeking', handleSeeking)
    }
  }, [videoRef, applySourceToVideo, suppressEventsRef, appliedSourceUrlRef])

  return {
    applySourceToVideo,
    cleanupMedia,
    restoredRef,
    appliedSourceUrlRef,
  }
}
