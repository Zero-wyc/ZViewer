/**
 * 视频源管理 Hook（v2 重写）：负责将 WatchTogetherState 中的视频源应用到
 * <video> 元素，包括 MSE DASH 合并、音频同步、以及组件挂载时的源恢复。
 *
 * 底层使用 player 模块的 usePlayerSource 进行引擎选择与 attach。
 * 本 Hook 在其之上扩展：
 * 1. WatchTogetherState → PlayerSource 字段映射
 * 2. 组件挂载时的源恢复（依赖 roomStore，仅观众端或无待加载影片时执行）
 * 3. seek 到未缓冲区域时的 MSE seek / 失败重载
 *
 * 观众端不再独立解析 B站 视频，所有源类型统一使用房主广播的
 * sourceUrl/audioUrl 进行 MSE attach，避免凭证不一致与 CDN 限流。
 * restoredRef 保证每个挂载周期只恢复一次源，避免与 handleLoad / handleState 重复加载。
 *
 * 房主端在挂载时若 roomStore 中存在 currentMovieId，跳过恢复 effect，
 * 交由 useWatchTogether.loadMovie 重新解析 B站 并加载最新地址，
 * 避免两个 effect 并发调用 applySourceToVideo 导致 MSE 互相 abort。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useRoomStore } from '@/store/roomStore'
import { message } from '@/components/ui/message'
import { usePlayerSource } from '@/modules/player'
import type { PlayerSource } from '@/modules/player'
import { waitForMetadata } from '@/modules/player/utils'
import { wasUserPaused } from '@/modules/player/services/pause-intent'
import { getBilibiliParseOptions } from '@/modules/bilibili/parseOptions'
import { buildCliProxyUrl } from '@/modules/bilibili/cliApi'
import {
  getActiveCliProxyUrl,
  resolveBilibiliOnline,
  getEffectivePreferMp4,
} from '@/modules/room/watch-together/movie-source-resolver'
import { isCliProxyUrl } from '@/modules/player/services/url-proxy'
import type { WatchTogetherState } from '../types'
import type { ResolvedSource } from '@/modules/bilibili/types'
import { safePlay } from '../safePlay'
import { executeSeek } from '../services'
import type { SeekToResult } from '../services'

interface ViewerLocalOverride {
  movieId: number
  resolved: ResolvedSource
}

/**
 * 确保观众端按本地解析偏好获得独立的 B站 源。
 *
 * 当房主广播的源格式/地址与观众本地偏好不一致时（例如房主使用 CLI DASH，
 * 而观众默认 MP4），观众端按自己的偏好重新解析，避免被迫使用房主的 CLI 代理
 * 或被切换到自己不期望的格式。
 *
 * 房主启用 CLI 时广播 hostCliEnabled=true。CLI 是各客户端独立的本地代理，
 * 观众无法使用房主的 CLI，因此收到此标记时强制走 MP4（即使观众本地偏好 DASH），
 * 避免观众被迫走服务器 DASH 消耗带宽。
 *
 * 若本地偏好与房主一致且房主源不是本地 CLI 代理地址，则返回 null，直接使用房主源。
 * 本地已启用 CLI 时同样会按 DASH 偏好解析并覆盖。
 */
async function ensureViewerLocalOverride(
  state: WatchTogetherState
): Promise<ViewerLocalOverride | null> {
  const storeState = useRoomStore.getState()
  const movieId = storeState.currentMovieId
  if (movieId == null || state.sourceType !== 'bilibili' || !state.sourceUrl) {
    return null
  }
  const movie = storeState.movies.find((m) => m.id === movieId)
  if (!movie?.url || !movie.cid) {
    return null
  }

  const effectivePreferMp4 = getEffectivePreferMp4(movieId)
  const hostIsMp4 = state.format === 'mp4'
  const existing = storeState.viewerCliResolvedSource
  const existingIsMp4 = existing?.resolved.format === 'mp4'

  // 房主启用了 CLI（hostCliEnabled=true）但观众本地未开启 CLI 时，
  // 强制观众走 MP4：CLI 仅为房主本地高画质代理，观众无法使用。
  const viewerCliEnabled = getBilibiliParseOptions(movieId).cliEnabled
  const forceViewerMp4 = !!state.hostCliEnabled && !viewerCliEnabled
  const adjustedPreferMp4 = forceViewerMp4 || effectivePreferMp4

  // 本地偏好与房主一致且房主源不是 CLI 代理地址：直接使用房主广播源
  if (adjustedPreferMp4 === hostIsMp4 && !isCliProxyUrl(state.sourceUrl)) {
    if (existing?.movieId === movieId) {
      storeState.setViewerCliResolvedSource(null)
    }
    return null
  }

  // 已有匹配的本地覆盖时直接复用，避免重复解析
  if (existing?.movieId === movieId && existingIsMp4 === adjustedPreferMp4) {
    return existing
  }

  // 按本地偏好独立解析
  try {
    const resolved = await resolveBilibiliOnline(movie, undefined, {
      preferMp4: adjustedPreferMp4,
    })
    const resolvedSource: ResolvedSource = {
      videoUrl: resolved.sourceUrl,
      audioUrl: resolved.audioUrl,
      videoCodec: resolved.videoCodec,
      audioCodec: resolved.audioCodec,
      duration: resolved.duration,
      format: resolved.format ?? 'mp4',
      cid: resolved.cid,
      currentQn: resolved.currentQn,
      acceptQuality: resolved.acceptQuality,
      title: movie.title,
    }
    const override: ViewerLocalOverride = {
      movieId: movie.id,
      resolved: resolvedSource,
    }
    storeState.setViewerCliResolvedSource(override)
    return override
  } catch (err) {
    console.error('[useVideoSource] 观众本地解析失败:', err)
    // 失败后清除旧覆盖，回退到房主源（可能无法播放，由上层提示）
    if (existing?.movieId === movieId) {
      storeState.setViewerCliResolvedSource(null)
    }
    return null
  }
}

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
    startTime?: number,
    blobs?: { videoBlob: Blob; audioBlob: Blob }
  ) => Promise<void>
  cleanupMedia: () => void
  restoredRef: MutableRefObject<boolean>
  /** seek 到目标时间（MSE 流不重建 MediaSource，普通流返回 success=false） */
  seekTo: (video: HTMLVideoElement, targetTime: number) => Promise<SeekToResult>
  /** 重载视频源（重载按钮用）：从当前播放位置附近重新 attach */
  reloadVideo: (video: HTMLVideoElement) => Promise<void>
}

/**
 * WatchTogetherState → PlayerSource 字段映射。
 * PlayerSource 是引擎 attach 所需的最小字段集，从 WatchTogetherState 中抽取。
 *
 * 可选传入 blobs（缓冲模式）：从 IndexedDB 读取的本地 Blob 数据，
 * dash.js 会用 blob URL 加载，跳过服务器代理。
 *
 * P2P 标志从本地 parseOptions 读取（各客户端独立启用，不经房主广播）：
 * - 仅 DASH 流模式启用 P2P（bufferMode=true 时忽略，因视频已完整缓存到本地）
 * - 仅 B站 DASH 源有意义（其他源走 direct/hls/flv 引擎，无 P2P 集成）
 */
function toPlayerSource(
  state: WatchTogetherState,
  startTime?: number,
  blobs?: { videoBlob: Blob; audioBlob: Blob }
): PlayerSource {
  const source: PlayerSource = {
    url: state.sourceUrl,
    audioUrl: state.audioUrl,
    format: state.format,
    videoCodec: state.videoCodec,
    audioCodec: state.audioCodec,
    headers: state.headers,
    // 传入后端权威时长：B站 fMP4 流的 mvhd.duration 为 0，
    // MSE 引擎需用此值显式设置 mediaSource.duration
    duration: state.duration,
  }
  if (startTime !== undefined && startTime > 0) {
    source.startTime = startTime
  }
  if (blobs) {
    source.videoBlob = blobs.videoBlob
    source.audioBlob = blobs.audioBlob
  }

  const movieId = useRoomStore.getState().currentMovieId
  // CLI 本地高画质代理：各客户端独立启用，不经房主广播。
  // 房主广播原始 B站 CDN URL；观众/房主各自在 attach 前决定是否走自己的 CLI 代理。
  let cliProxyActive = false
  if (state.sourceType === 'bilibili' && movieId != null) {
    const { cliEnabled } = getBilibiliParseOptions(movieId)
    const proxyUrl = cliEnabled ? getActiveCliProxyUrl() : null
    if (proxyUrl) {
      cliProxyActive = true
      source.url = buildCliProxyUrl(proxyUrl, state.sourceUrl)
      if (source.audioUrl) {
        source.audioUrl = buildCliProxyUrl(proxyUrl, source.audioUrl)
      }
    }
  }

  // P2P 仅在 DASH 流模式启用（缓冲模式下视频已本地缓存，P2P 无意义）
  // 各客户端独立从本地 parseOptions 读取，不经房主广播
  // P2P 配置按影片 ID 独立存储，从 roomStore 读取当前播放影片 ID
  // 注意：CLI 代理与 P2P 互斥。CLI 代理使用各客户端独立的 localhost URL 作为 channelId，
  // 会导致 P2P peer 无法匹配，因此当 CLI 代理生效时强制关闭 P2P。
  if (state.format === 'dash' && !state.bufferMode && !cliProxyActive) {
    const { p2pEnabled } = getBilibiliParseOptions(movieId ?? 0)
    if (p2pEnabled) {
      source.p2pEnabled = true
    }
  }
  return source
}

/** 播放状态快照：reloadVideo 前保存，attach 完成后恢复 */
interface PlaybackSnapshot {
  currentTime: number
  playbackRate: number
  volume: number
  muted: boolean
  paused: boolean
}

function takeSnapshot(video: HTMLVideoElement): PlaybackSnapshot {
  return {
    currentTime: video.currentTime,
    playbackRate: video.playbackRate,
    volume: video.volume,
    muted: video.muted,
    paused: video.paused,
  }
}

/** attach 完成后恢复播放状态（倍速 / 音量 / 静音 / 进度 / 播放暂停） */
async function restoreSnapshot(
  video: HTMLVideoElement,
  snapshot: PlaybackSnapshot
): Promise<void> {
  // 等待 metadata 加载完成后再恢复 currentTime，否则 seek 会被浏览器丢弃
  await waitForMetadata(video)

  if (video.playbackRate !== snapshot.playbackRate) {
    video.playbackRate = snapshot.playbackRate
  }
  if (video.volume !== snapshot.volume) {
    video.volume = snapshot.volume
  }
  if (video.muted !== snapshot.muted) {
    video.muted = snapshot.muted
  }
  if (snapshot.currentTime > 0) {
    try {
      video.currentTime = snapshot.currentTime
    } catch {
      /* ignore */
    }
  }
  if (!snapshot.paused) {
    void safePlay(video)
  } else if (!video.paused) {
    video.pause()
  }
}

export function useVideoSource({
  videoRef,
  suppressEventsRef,
  watchTogether,
  isHostRef,
}: UseVideoSourceOptions): UseVideoSourceReturn {
  const { attachSource, cleanup, seekTo, forceReload } = usePlayerSource({
    videoRef,
  })
  const restoredRef = useRef(false)

  const cleanupMedia = cleanup

  // 将指定状态中的视频源应用到 video 元素（含 MSE DASH 处理）。
  // 供房主加载、观众同步以及组件重新挂载时恢复使用。
  // 所有源类型（包括 bilibili）统一逻辑：
  //   - DASH / 含 audioUrl：使用 MSE 合并 videoUrl + audioUrl
  //   - 其他格式（如 mp4）：直接设置 video.src
  // 观众端：当本地解析偏好与房主广播源不一致时，按本地偏好独立解析，
  // 避免被迫使用房主的 CLI 代理或被切换为不期望的格式。
  const applySourceToVideo = useCallback(
    async (
      video: HTMLVideoElement,
      state: WatchTogetherState,
      startTime?: number,
      blobs?: { videoBlob: Blob; audioBlob: Blob }
    ) => {
      if (!state.sourceUrl) {
        return
      }

      let effectiveState = state
      if (!isHostRef.current) {
        const storeState = useRoomStore.getState()
        const currentMovieId = storeState.currentMovieId
        // 优先使用已有的本地覆盖（CLI 清晰度覆盖或本地偏好解析结果）
        const existingOverride = storeState.viewerCliResolvedSource
        if (existingOverride && existingOverride.movieId === currentMovieId) {
          effectiveState = {
            ...state,
            sourceUrl: existingOverride.resolved.videoUrl,
            audioUrl: existingOverride.resolved.audioUrl,
            format: existingOverride.resolved.format,
            videoCodec: existingOverride.resolved.videoCodec,
            audioCodec: existingOverride.resolved.audioCodec,
            duration: existingOverride.resolved.duration ?? state.duration,
            currentQn: existingOverride.resolved.currentQn,
          }
        } else {
          // 没有覆盖且本地偏好与房主不一致时，尝试独立解析
          const localOverride = await ensureViewerLocalOverride(state)
          if (localOverride && localOverride.movieId === currentMovieId) {
            effectiveState = {
              ...state,
              sourceUrl: localOverride.resolved.videoUrl,
              audioUrl: localOverride.resolved.audioUrl,
              format: localOverride.resolved.format,
              videoCodec: localOverride.resolved.videoCodec,
              audioCodec: localOverride.resolved.audioCodec,
              duration: localOverride.resolved.duration ?? state.duration,
              currentQn: localOverride.resolved.currentQn,
            }
          }
        }
      }

      await attachSource(
        video,
        toPlayerSource(effectiveState, startTime, blobs)
      )
    },
    [attachSource, isHostRef]
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
    // 传入 state.currentTime 作为 startTime：页面刷新后恢复播放进度时，
    // DashPlayer 从该时间对应的字节偏移开始下载，而非从文件头顺序下载。
    // 否则恢复后需要从头加载到 currentTime 才能播放。
    const startTime = state.currentTime > 0 ? state.currentTime : undefined
    void applySourceToVideo(video, state, startTime)
      .then(() => {
        if (state.currentTime > 0) {
          video.currentTime = state.currentTime
        }
        if (video.playbackRate !== state.playbackRate) {
          video.playbackRate = state.playbackRate
        }
        // 组件挂载恢复源时同样需要处理自动播放策略；
        // 用户在 attach 期间（MKV 管线可达数秒）按了暂停时不强制起播
        if (state.isPlaying && video.paused && !wasUserPaused(video)) {
          void safePlay(video)
        }
        suppressEventsRef.current = false
      })
      .catch((err: unknown) => {
        // MSE attach 失败时必须释放 suppressEventsRef，否则房主端
        // play/pause/seek/timeupdate 事件全部被吞，无法广播 state 给观众，
        // 导致观众端永久黑屏。
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

  // 重载视频源：重载按钮调用 + MSE seek 失败时的恢复手段。
  // 从当前播放位置附近重新 attach（MSE 引擎通过 startTime 计算 Range 下载起点），
  // 完成后恢复到原播放位置。用于视频卡死、花屏、缓冲异常等场景的手动恢复。
  // 也用于 MSE seek 失败（video.error）时：创建全新 DashPlayer 实例，
  // 用最新 state URL 重新加载，避免旧实例的 video.error / URL 过期问题。
  const reloadVideo = useCallback(
    async (video: HTMLVideoElement) => {
      // 在重载前快照当前播放状态（避免 attach 异步期间状态变化）
      const snapshot = takeSnapshot(video)

      // 获取最新 state，确保使用最新 URL（避免 URL 过期）
      const state = useRoomStore.getState().watchTogether
      if (!state.sourceUrl) return

      suppressEventsRef.current = true
      useRoomStore.getState().setReloadingState(true, snapshot.currentTime)
      try {
        await forceReload(video, toPlayerSource(state, snapshot.currentTime))
        await restoreSnapshot(video, snapshot)
      } catch (err) {
        console.error('[useVideoSource] 重载视频源失败:', err)
        message.error(err instanceof Error ? err.message : '视频重载失败')
      } finally {
        suppressEventsRef.current = false
        useRoomStore.getState().setReloadingState(false, null)
      }
    },
    [forceReload, suppressEventsRef]
  )

  // seek 到未缓冲区域时的处理：
  // 当用户回退到 SourceBuffer 中已被清理的位置时，视频会卡死（没有数据可播放）。
  // 调用 executeSeek → 引擎 seekTo（不重建 MediaSource，清空 SourceBuffer + Range 下载）。
  // 仅对 MSE 流（DASH / 含 audioUrl）生效，普通 mp4 直链由浏览器原生处理。
  // MSE seek 失败时（如 video.error），executeSeek 会调用 onSeekFailed → reloadVideo
  // 创建全新 DashPlayer 实例（用最新 state URL）重新加载。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const isReloadingRef = { current: false }

    const handleSeeking = () => {
      if (suppressEventsRef.current) {
        return
      }

      // 注意：不在此处检查 isReloadingRef——锁占用期间到达的 seek 目标
      // 由 executeSeek 记录为待处理目标，锁释放后接续处理（连续拖拽不丢目标）
      const targetTime = video.currentTime
      const state = useRoomStore.getState().watchTogether

      void executeSeek({
        video,
        targetTime,
        state,
        seekTo,
        suppressEventsRef,
        isReloadingRef,
        onSeekFailed: reloadVideo,
      })
    }

    video.addEventListener('seeking', handleSeeking)
    return () => {
      video.removeEventListener('seeking', handleSeeking)
    }
  }, [videoRef, seekTo, suppressEventsRef, reloadVideo])

  return {
    applySourceToVideo,
    cleanupMedia,
    restoredRef,
    seekTo,
    reloadVideo,
  }
}
