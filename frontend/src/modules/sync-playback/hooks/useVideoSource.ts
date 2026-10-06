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

  // cliOnly（仅允许CLI模式）：观众必须本机 CLI 已连接——服务器零媒体流量
  // 语义，禁止回退广播源（房主 CLI 地址观众不可达）与服务器解析转发。
  // 设置引导标记后返回 null：applySourceToVideo 据此跳过挂载，由播放器
  // 覆盖层显示 CLI 安装引导；CLI 就绪后的重载（cliAgent 变化触发）会重新
  // 进入本函数并清除标记。
  if (movie.cliOnly === true && !getActiveCliProxyUrl()) {
    storeState.setViewerCliRequiredMovieId(movieId)
    return null
  }
  if (storeState.viewerCliRequiredMovieId === movieId) {
    storeState.setViewerCliRequiredMovieId(null)
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

  // 已有匹配的本地覆盖时直接复用，避免重复解析。
  // cid 需一致：房主切分 P 后广播 state.cid 变化，旧分 P 的覆盖必须失效。
  if (
    existing?.movieId === movieId &&
    existingIsMp4 === adjustedPreferMp4 &&
    existing.resolved.cid === state.cid
  ) {
    return existing
  }

  // 按本地偏好独立解析（服务器解析默认以房间房主 Cookie 身份执行，
  // 见 resolveBilibiliOnline 的 useHostCookie 说明）
  try {
    const resolved = await resolveBilibiliOnline(movie, undefined, {
      preferMp4: adjustedPreferMp4,
      // 多 P 视频：切 P 只更新 movie.cid/currentPage，url 不变，
      // 必须显式传 page 才能解析到当前分 P（否则固定解析第 1 P）
      page: movie.currentPage,
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

/**
 * 将观众本地覆盖源合并进房主广播状态（CLI 清晰度覆盖与本地偏好独立解析共用）。
 */
function withViewerOverride(
  state: WatchTogetherState,
  resolved: ResolvedSource
): WatchTogetherState {
  return {
    ...state,
    sourceUrl: resolved.videoUrl,
    audioUrl: resolved.audioUrl,
    format: resolved.format,
    videoCodec: resolved.videoCodec,
    audioCodec: resolved.audioCodec,
    duration: resolved.duration ?? state.duration,
    currentQn: resolved.currentQn,
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
    // 影片级浏览器播放引擎开关（添加影片时设置），是 shouldUsePlaysVideo
    // 的唯一门控（原生失败不回退管线）
    playsvideoEnabled: state.playsvideoEnabled,
    // 挂载直链模式：直连失败不回退服务器代理，直接提示错误
    noProxyFallback: state.noProxyFallback,
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
  // cliOnly（仅允许CLI模式）影片强制包装——即使本机偏好未开 CLI，
  // 媒体流也必须经本机 CLI（观众无 CLI 时已被 ensureViewerLocalOverride 拦截）。
  if (state.sourceType === 'bilibili' && movieId != null) {
    const movie = useRoomStore.getState().movies.find((m) => m.id === movieId)
    const { cliEnabled } = getBilibiliParseOptions(movieId)
    const cliOnly = movie?.cliOnly === true
    const proxyUrl = cliEnabled || cliOnly ? getActiveCliProxyUrl() : null
    if (proxyUrl) {
      source.url = buildCliProxyUrl(proxyUrl, state.sourceUrl)
      if (source.audioUrl) {
        source.audioUrl = buildCliProxyUrl(proxyUrl, source.audioUrl)
      }
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
  // 播放期错误提示（usePlayerSource 统一判定后回调）：
  // B站源由 useWatchTogether 的 stalled/error 自动重载链路负责，此处过滤
  const handlePlaybackError = useCallback(
    (err: Error) => {
      const state = useRoomStore.getState().watchTogether
      if (state.sourceType === 'bilibili') return
      if (suppressEventsRef.current) return
      message.error(err.message)
    },
    [suppressEventsRef]
  )

  const { attachSource, cleanup, seekTo, forceReload } = usePlayerSource({
    videoRef,
    onPlaybackError: handlePlaybackError,
  })
  const restoredRef = useRef(false)

  const cleanupMedia = cleanup

  // ── 观众端生效源解析（唯一入口）────────────────────────
  // 观众端所有 attach/reload 路径必须共用此函数决定实际挂载的源：
  // 优先复用已有本地覆盖（CLI 清晰度覆盖或本地偏好独立解析结果），
  // 无匹配覆盖时按本地偏好独立解析（ensureViewerLocalOverride
  // 内部同样会复用满足格式条件的既有覆盖）。
  //
  // ⚠️ 若仅部分路径应用覆盖（如历史版本中 applySourceToVideo 走覆盖而
  // reloadVideo 直接用广播源），观众端会在「本地覆盖源（MP4→经典引擎）」
  // 与「房主广播源（DASH→dash 引擎）」之间反复切换引擎：每次翻转都是
  // 一次完整重挂，并伴随 dash.js destroy 后监听器残留的崩溃刷屏
  // （PlaybackController 读已置空的 streamInfo → "D is null"）与
  // blob revoke 后的 code 25 噪音。新增观众端挂载路径时必须经过此函数。
  const resolveViewerEffectiveState = useCallback(
    async (state: WatchTogetherState): Promise<WatchTogetherState> => {
      if (isHostRef.current || !state.sourceUrl) return state
      const storeState = useRoomStore.getState()
      const currentMovieId = storeState.currentMovieId
      const existing = storeState.viewerCliResolvedSource
      // 分 P 切换检测：override 只记录解析时刻的分 P（cid），房主切分 P 后
      // 广播 state.cid 变化而 movieId 不变——cid 不一致说明 override 已过期，
      // 必须重新解析当前分 P，否则观众停留在切 P 前的旧分 P。
      const override =
        existing &&
        existing.movieId === currentMovieId &&
        existing.resolved.cid === state.cid
          ? existing
          : await ensureViewerLocalOverride(state)
      if (override && override.movieId === currentMovieId) {
        return withViewerOverride(state, override.resolved)
      }
      return state
    },
    [isHostRef]
  )

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

      const effectiveState = await resolveViewerEffectiveState(state)

      // cliOnly 未满足（观众本机 CLI 未连接）：不挂载任何源——广播源是
      // 房主本机 CLI 地址（观众不可达），服务器转发也被 cliOnly 禁止。
      // 播放器覆盖层据 viewerCliRequiredMovieId 显示 CLI 安装引导。
      if (
        !isHostRef.current &&
        useRoomStore.getState().viewerCliRequiredMovieId != null
      ) {
        return
      }

      await attachSource(
        video,
        toPlayerSource(effectiveState, startTime, blobs)
      )
    },
    [attachSource, resolveViewerEffectiveState, isHostRef]
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
    // DASH 引擎从该时间对应的字节偏移开始下载，而非从文件头顺序下载。
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
  // 也用于 MSE seek 失败（video.error）时：创建全新 DASH 引擎实例，
  // 用最新 state URL 重新加载，避免旧实例的 video.error / URL 过期问题。
  const reloadVideo = useCallback(
    async (video: HTMLVideoElement) => {
      // 在重载前快照当前播放状态（避免 attach 异步期间状态变化）
      const snapshot = takeSnapshot(video)

      // 获取最新 state，确保使用最新 URL（避免 URL 过期）
      const state = useRoomStore.getState().watchTogether
      if (!state.sourceUrl) return

      // 观众端必须与 applySourceToVideo 同源（resolveViewerEffectiveState）：
      // 若此处直接用广播源重挂，seek 失败兜底/手动重载会把本地覆盖源
      // （MP4→经典引擎）替换为房主广播源（DASH→dash 引擎），引发引擎反复翻转
      const effectiveState = await resolveViewerEffectiveState(state)

      suppressEventsRef.current = true
      useRoomStore.getState().setReloadingState(true, snapshot.currentTime)
      try {
        await forceReload(
          video,
          toPlayerSource(effectiveState, snapshot.currentTime)
        )
        await restoreSnapshot(video, snapshot)
      } catch (err) {
        console.error('[useVideoSource] 重载视频源失败:', err)
        message.error(err instanceof Error ? err.message : '视频重载失败')
      } finally {
        suppressEventsRef.current = false
        useRoomStore.getState().setReloadingState(false, null)
      }
    },
    [forceReload, resolveViewerEffectiveState, suppressEventsRef]
  )

  // seek 到未缓冲区域时的处理：
  // 当用户回退到 SourceBuffer 中已被清理的位置时，视频会卡死（没有数据可播放）。
  // 调用 executeSeek → 引擎 seekTo（不重建 MediaSource，清空 SourceBuffer + Range 下载）。
  // 仅对 MSE 流（DASH / 含 audioUrl）生效，普通 mp4 直链由浏览器原生处理。
  // MSE seek 失败时（如 video.error），executeSeek 会调用 onSeekFailed → reloadVideo
  // 创建全新 DASH 引擎实例（用最新 state URL）重新加载。
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
