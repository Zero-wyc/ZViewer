import { useEffect, useRef, useCallback, useState } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import {
  useRoomStore,
  type WatchTogetherState,
  type MovieDto,
  mapDtoToMovie,
} from '@/store/roomStore'
import { resolveBilibiliWithOptions } from '@/modules/bilibili/bilibiliApi'
import { type QualityOption } from './resolveSource'
import { useBilibiliQuality } from '@/modules/bilibili/useBilibiliQuality'
import {
  useHostBroadcast,
  useViewerStateSync,
  useHostStateRequest,
  useVideoEventBindings,
  useHostHeartbeat,
  useViewerHeartbeat,
  useViewerList,
  useTrackSync,
  useVideoSource,
  SOCKET_EVENT,
  safePlay,
} from '@/modules/sync-playback'
import { type MediaFormat } from '@/lib/mediaFormat'

// 格式化跳转时间用于提示信息（mm:ss 或 h:mm:ss）
function formatSeekTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = m.toString().padStart(2, '0')
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export type SourceType =
  'url' | 'webdav' | 'ftp' | 'openlist' | 'smb' | 'bilibili' | string

export type { QualityOption }

interface UseWatchTogetherOptions {
  roomId: string
  isHost: boolean
  videoRef: React.RefObject<HTMLVideoElement | null>
  /**
   * 房主刷新/重连恢复时由后端返回的最近一次播放状态。
   * 提供时，loadMovie 加载完成后若 currentMovieId 与之匹配，
   * 则将 currentTime 设置为 initialPlayback.currentTime 并强制暂停（不自动播放）。
   */
  initialPlayback?: {
    currentTime: number
    isPlaying: boolean
    playbackRate: number
    duration?: number
    sourceUrl?: string
    sourceType?: string
    audioUrl?: string
    format?: MediaFormat
    videoCodec?: string
    audioCodec?: string
    cid?: number
    currentQn?: number
    currentMovieId?: number
    updatedAt: number
  } | null
}

/**
 * 一起看聚合 Hook：组合 useVideoSource（视频源管理）与 useSyncPlayback（同步核心），
 * 并保留 B站 清晰度切换、影片列表/当前影片同步、pendingQualityChange 消费等业务逻辑。
 *
 * 对外导出签名与重构前完全一致，WatchTogetherPanel.tsx 无需修改。
 */
export function useWatchTogether({
  roomId,
  isHost,
  videoRef,
  initialPlayback,
}: UseWatchTogetherOptions) {
  const { socket } = useSocket()
  const {
    watchTogether,
    setWatchTogether,
    movies,
    currentMovieId,
    setMovies,
    setCurrentMovieId,
    fetchMovies,
    pendingQualityChange,
    setPendingQualityChange,
    pendingPreviewPlay,
    setPendingPreviewPlay,
  } = useRoomStore()
  const isHostRef = useRef(isHost)
  const suppressEventsRef = useRef(false)
  const lastLoadedMovieRef = useRef<{ id: number; url: string } | null>(null)
  // 房主刷新恢复：用于在 loadMovie 完成后应用 initialPlayback.currentTime 并暂停
  // 通过 ref 暂存，避免修改 effect 依赖导致 loadMovie 重新触发
  // 采用 latest ref pattern：每次渲染同步，确保 loadMovie 内部读到最新值
  const initialPlaybackRef = useRef(initialPlayback)
  useEffect(() => {
    initialPlaybackRef.current = initialPlayback
  }, [initialPlayback])
  const appliedPlaybackRef = useRef(false)

  // B站 视频解析进度：用于在播放器上显示后台解析过程
  const [isResolving, setIsResolving] = useState(false)
  const [resolvingMessage, setResolvingMessage] = useState('')

  useEffect(() => {
    isHostRef.current = isHost
  }, [isHost])

  // 1. 视频源管理：applySourceToVideo / cleanupMedia / restoredRef
  const { applySourceToVideo, cleanupMedia } = useVideoSource({
    videoRef,
    suppressEventsRef,
    watchTogether,
    isHostRef,
  })

  // 2. 同步核心（分离式架构：8 个单一职责 hooks）
  // 房主：状态广播 + 控制指令 + forceSync（浅比较优化跳过等价状态广播）
  const { broadcastState, sendControl, forceSync } = useHostBroadcast({
    roomId,
    isHostRef,
    videoRef,
  })

  // 观众：接收房主 state/control 事件，串行化 applySourceToVideo（Bug #8 修复），
  // 自适应 seek 跟随阈值（高倍速下放大阈值避免抖动）
  useViewerStateSync({
    roomId,
    isHostRef,
    videoRef,
    suppressEventsRef,
    setWatchTogether,
    applySourceToVideo,
  })

  // 房主：响应观众的 watch-together-request-state 请求
  useHostStateRequest({
    roomId,
    isHostRef,
    videoRef,
  })

  // 房主：绑定 video 元素事件（play/pause/seeked/ratechange/timeupdate）
  // 节流广播 + seek 防抖，通过 useRoomStore.getState() 读最新源字段避免闭包失效
  useVideoEventBindings({
    isHostRef,
    videoRef,
    suppressEventsRef,
    setWatchTogether,
    broadcastState,
    sendControl,
  })

  // 房主：每 2s 广播心跳（后端新增转发 handler，修复观众端误报房主离线的 bug）
  useHostHeartbeat({
    roomId,
    isHostRef,
    videoRef,
  })

  // 观众：监听房主心跳，6s 未收到则判定离线；同时监听 host-disconnected 立即暂停
  useViewerHeartbeat({
    isHostRef,
    videoRef,
  })

  // 房主与观众：同步在线观众列表（viewer-joined / viewer-left）
  useViewerList()

  // 弹幕/字幕轨道同步（合并事件 track-change，后端新增转发 handler 修复功能失效 bug）
  const {
    broadcastDanmakuTrackChange,
    broadcastSubtitleTrackChange,
    setSubtitleTrackIndex,
    subtitleTrackIndex,
    danmakuTrackId,
    onDanmakuTrackChange,
    onSubtitleTrackChange,
  } = useTrackSync({
    roomId,
    isHostRef,
  })

  // B站 清晰度切换统一 Hook：封装 currentQuality/availableQualities/isSwitchingQuality
  // 状态及房主/观众/列表触发的切换逻辑。
  // 协议精简（v2）：不再传 socket/roomId，清晰度切换通过 broadcastState 推送完整 state 同步。
  const quality = useBilibiliQuality({
    videoRef,
    isHostRef,
    suppressEventsRef,
    applySourceToVideo,
    setWatchTogether,
    broadcastState,
    setIsResolving,
    setResolvingMessage,
  })

  // 监听影片列表与当前播放影片的同步事件
  useEffect(() => {
    if (!socket) return

    const handleMovieList = (payload: { movies: MovieDto[] }) => {
      // 后端广播的 movie-list 事件仅作实时刷新：直接覆盖本地缓存
      setMovies(payload.movies.map(mapDtoToMovie))
    }

    const handleCurrentMovie = (payload: { movieId: number | null }) => {
      setCurrentMovieId(payload.movieId)
    }

    // 观众端：接收房主广播的预览源，直接加载播放（不经过影片列表）
    const handlePreviewSource = (payload: {
      source: {
        url: string
        title?: string
        sourceType?: string
        format?: MediaFormat
        audioUrl?: string
        videoCodec?: string
        audioCodec?: string
        headers?: Record<string, string>
        duration?: number
      }
    }) => {
      if (isHostRef.current) return
      const video = videoRef.current
      if (!video) return

      const { source } = payload
      const newState: WatchTogetherState = {
        sourceUrl: source.url,
        sourceType: source.sourceType || 'anime',
        audioUrl: source.audioUrl,
        format: source.format as MediaFormat | undefined,
        videoCodec: source.videoCodec,
        audioCodec: source.audioCodec,
        isPlaying: true,
        currentTime: 0,
        playbackRate: watchTogether.playbackRate,
        duration: source.duration ?? 0,
        headers: source.headers,
        isPreview: true,
        previewTitle: source.title,
      }
      setWatchTogether(newState)
      suppressEventsRef.current = true
      void applySourceToVideo(video, newState)
        .then(() => {
          video.currentTime = 0
          if (video.paused) {
            void safePlay(video)
          }
          suppressEventsRef.current = false
        })
        .catch((err: unknown) => {
          console.error('[useWatchTogether] 观众端预览源加载失败:', err)
          suppressEventsRef.current = false
          message.error(err instanceof Error ? err.message : '预览源加载失败')
        })
    }

    socket.on(SOCKET_EVENT.MOVIE_LIST, handleMovieList)
    socket.on(SOCKET_EVENT.CURRENT_MOVIE, handleCurrentMovie)
    socket.on(SOCKET_EVENT.PREVIEW_SOURCE, handlePreviewSource)

    // 房间加入/刷新时优先通过 REST 接口加载影片列表
    fetchMovies(roomId).catch((err) => {
      console.error('[useWatchTogether] fetchMovies error:', err)
    })
    socket.emit(SOCKET_EVENT.REQUEST_CURRENT_MOVIE, { roomId })

    return () => {
      socket.off(SOCKET_EVENT.MOVIE_LIST, handleMovieList)
      socket.off(SOCKET_EVENT.CURRENT_MOVIE, handleCurrentMovie)
      socket.off(SOCKET_EVENT.PREVIEW_SOURCE, handlePreviewSource)
    }
  }, [
    socket,
    roomId,
    setMovies,
    setCurrentMovieId,
    fetchMovies,
    applySourceToVideo,
    broadcastState,
    sendControl,
    suppressEventsRef,
    videoRef,
    watchTogether.playbackRate,
    setWatchTogether,
  ])

  // 根据当前视频源类型计算可用清晰度列表。
  // B站 DASH 流使用后端返回的真实 acceptQuality；其他单源类型返回空数组，由 UI 隐藏选择器。
  useEffect(() => {
    quality.syncFromState(watchTogether)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖已按字段列出，无需整个 watchTogether
  }, [
    watchTogether.sourceType,
    watchTogether.format,
    watchTogether.sourceUrl,
    watchTogether.acceptQuality,
    watchTogether.currentQn,
    quality.syncFromState,
  ])

  // 房主：切换清晰度。重新解析对应 qn 的 URL、attach MSE 流并保留进度，同时广播给观众。
  const changeQuality = useCallback(
    async (qualityId: number) => {
      if (!isHostRef.current) return
      if (qualityId === quality.currentQuality) return

      const storeState = useRoomStore.getState()
      const movie = storeState.movies.find(
        (m) => m.id === storeState.currentMovieId
      )
      if (!movie?.url) return

      await quality.applyQualityChange(movie, qualityId, {
        broadcast: true,
        message: '正在切换清晰度...',
      })
    },
    [quality]
  )

  // 房主：重新解析当前 B站 视频（用于解析偏好变更后即时生效）
  const reloadBilibili = useCallback(async () => {
    const video = videoRef.current
    if (!video || !isHostRef.current) return

    const state = useRoomStore.getState().watchTogether
    if (state.sourceType !== 'bilibili') return

    const storeState = useRoomStore.getState()
    const movie = storeState.movies.find(
      (m) => m.id === storeState.currentMovieId
    )
    if (!movie?.url) return

    setIsResolving(true)
    setResolvingMessage('正在重新解析...')
    suppressEventsRef.current = true

    const preserveTime = video.currentTime
    const shouldPlay = !video.paused

    try {
      const resolved = await resolveBilibiliWithOptions(
        movie.url,
        quality.currentQuality ?? movie.currentQn,
        (_step, msg) => setResolvingMessage(msg)
      )
      if (!resolved.videoUrl) {
        throw new Error('未获取到对应清晰度的播放地址')
      }

      const newState: WatchTogetherState = {
        ...state,
        sourceUrl: resolved.videoUrl,
        audioUrl: resolved.audioUrl,
        videoCodec: resolved.videoCodec,
        audioCodec: resolved.audioCodec,
        format: resolved.format,
        currentQn:
          resolved.currentQn ?? quality.currentQuality ?? movie.currentQn,
        acceptQuality: resolved.acceptQuality,
      }
      setWatchTogether(newState)

      await applySourceToVideo(video, newState)
      video.currentTime = preserveTime
      if (shouldPlay) {
        void safePlay(video)
      }

      quality.setCurrentQuality(newState.currentQn ?? null)
      quality.setAvailableQualities(newState.acceptQuality ?? [])

      broadcastState(newState)
    } catch (err) {
      console.error('[useWatchTogether] 重新解析 B站 视频失败:', err)
      message.error(err instanceof Error ? err.message : '重新解析失败')
      try {
        await applySourceToVideo(video, state)
        if (preserveTime > 0) {
          video.currentTime = preserveTime
        }
        if (shouldPlay) {
          void safePlay(video)
        }
      } catch {
        // 忽略恢复失败
      }
    } finally {
      suppressEventsRef.current = false
      quality.setIsSwitchingQuality(false)
      setIsResolving(false)
      setResolvingMessage('')
    }
  }, [videoRef, quality, applySourceToVideo, setWatchTogether, broadcastState])

  // 观众：清晰度切换通过 watch-together-state.currentQn 同步。
  // 旧版使用独立的 quality-change 事件，但后端无转发 handler 导致功能失效；
  // 重构后移除该事件，房主切换清晰度时通过 applyQualityChange 内的
  // broadcastState(newState) 立即推送完整状态（含 currentQn），
  // 观众端 useViewerStateSync 接收后由 quality.syncFromState 自动更新 UI。
  // 见下方 syncFromState effect（依赖 watchTogether.currentQn）。

  // 响应 MovieListPanel 触发的清晰度切换请求：若对应影片正在播放，立即应用新源。
  useEffect(() => {
    if (!pendingQualityChange) return

    // 立即捕获并清除 pending，防止 applyQualityChange 执行期间
    // setWatchTogether 触发重新渲染导致 quality 对象变化、effect 重复触发、
    // 多个 applyQualityChange 并发执行造成 MSE 流冲突白屏。
    const pending = pendingQualityChange
    setPendingQualityChange(null)

    const applyPending = async () => {
      const video = videoRef.current
      if (!video) return

      if (pending.movieId !== currentMovieId) return

      const storeState = useRoomStore.getState()
      const movie = storeState.movies.find((m) => m.id === pending.movieId)
      if (!movie) return

      await quality.applyQualityChange(movie, undefined, {
        broadcast: isHostRef.current,
        resolved: pending.resolved,
        message: '正在应用清晰度...',
      })
    }

    void applyPending()
  }, [
    pendingQualityChange,
    currentMovieId,
    quality,
    setPendingQualityChange,
    videoRef,
  ])

  // currentMovieId 变化时自动加载对应影片到 video 元素
  // 仅房主执行加载逻辑：房主解析视频源并广播给观众。
  // 观众端完全依赖 handleState 接收房主广播的 sourceUrl/audioUrl 进行 MSE attach，
  // 不独立解析（避免与房主状态冲突导致黑屏）。
  useEffect(() => {
    if (!currentMovieId) return
    if (!isHostRef.current) return
    const movie = movies.find((m) => m.id === currentMovieId)
    if (!movie) return

    // 避免 movies 列表刷新时重复加载同一部影片
    if (
      lastLoadedMovieRef.current?.id === movie.id &&
      lastLoadedMovieRef.current?.url === movie.url
    ) {
      return
    }

    const video = videoRef.current
    if (!video) return

    const sourceType: WatchTogetherState['sourceType'] =
      movie.sourceType === 'mp4' ? 'url' : movie.sourceType

    suppressEventsRef.current = true
    lastLoadedMovieRef.current = { id: movie.id, url: movie.url }

    const loadMovie = async () => {
      let sourceUrl = movie.url
      let audioUrl = movie.audioUrl
      let format = movie.format
      let videoCodec = movie.videoCodec
      let audioCodec = movie.audioCodec
      let cid = movie.cid
      let duration = movie.duration || 0
      let currentQn: number | undefined = movie.currentQn
      let acceptQuality: QualityOption[] | undefined = movie.acceptQuality

      // B站 地址带有快速过期的签名，播放前重新解析以获取最新可用地址
      if (sourceType === 'bilibili') {
        setIsResolving(true)
        setResolvingMessage('正在初始化解析...')
        try {
          const resolved = await resolveBilibiliWithOptions(
            movie.url,
            movie.currentQn,
            (_step, msg) => setResolvingMessage(msg)
          )
          sourceUrl = resolved.videoUrl
          audioUrl = resolved.audioUrl
          format = resolved.format
          videoCodec = resolved.videoCodec
          audioCodec = resolved.audioCodec
          cid = resolved.cid
          duration = resolved.duration ?? duration
          currentQn = resolved.currentQn ?? movie.currentQn
          acceptQuality = resolved.acceptQuality ?? movie.acceptQuality
          if (acceptQuality?.length) {
            quality.setAvailableQualities(acceptQuality)
          }
          quality.setCurrentQuality(currentQn ?? acceptQuality?.[0]?.id ?? null)
        } catch (err) {
          console.error('[useWatchTogether] 解析 B站 视频失败:', err)
          message.error(err instanceof Error ? err.message : 'B站视频解析失败')
          // 解析失败时 movie.url 是 BV 页面地址（非媒体 URL），
          // 若继续用作 sourceUrl 会导致 MSE 把 HTML 当作 m4s 解析抛 ParseError，
          // 进而 suppressEventsRef 永久卡死、房主无法广播 → 观众端永久黑屏。
          suppressEventsRef.current = false
          return
        } finally {
          setIsResolving(false)
          setResolvingMessage('')
        }
      }

      // 房主刷新恢复：若 initialPlayback.currentMovieId 与当前加载的影片 ID 匹配，
      // 则使用 initialPlayback.currentTime 替代 0，并强制暂停而非自动播放。
      // B站 URL 每次解析都会变，因此通过 currentMovieId 匹配而非 sourceUrl。
      const recovery = initialPlaybackRef.current
      const isRecovery =
        !appliedPlaybackRef.current &&
        !!recovery &&
        typeof recovery.currentMovieId === 'number' &&
        recovery.currentMovieId === movie.id
      const recoveryTime = isRecovery ? recovery!.currentTime : 0
      if (isRecovery) {
        appliedPlaybackRef.current = true
      }

      const newState: WatchTogetherState = {
        sourceUrl,
        sourceType,
        audioUrl,
        format,
        videoCodec,
        audioCodec,
        cid,
        isPlaying: isRecovery ? false : true,
        currentTime: recoveryTime,
        playbackRate: isRecovery
          ? (recovery!.playbackRate ?? watchTogether.playbackRate)
          : watchTogether.playbackRate,
        duration,
        currentQn,
        acceptQuality,
      }

      setWatchTogether(newState)
      void applySourceToVideo(video, newState)
        .then(() => {
          if (isRecovery && recoveryTime > 0) {
            // 恢复进度：seek 到目标时间并强制暂停
            try {
              video.currentTime = recoveryTime
            } catch {
              // ignore
            }
            video.pause()
            suppressEventsRef.current = false
            if (isHostRef.current) {
              broadcastState(newState)
              sendControl('pause')
            }
            message.info(`已恢复到 ${formatSeekTime(recoveryTime)}（已暂停）`)
          } else {
            video.currentTime = 0
            if (video.paused) {
              void safePlay(video)
            }
            suppressEventsRef.current = false

            if (isHostRef.current) {
              broadcastState(newState)
              sendControl('play')
            }
          }
        })
        .catch((err: unknown) => {
          // MSE attach 失败时必须释放 suppressEventsRef，否则房主端
          // play/pause/seek/timeupdate 事件全部被吞，broadcastState 永不调用，
          // 观众端 appliedSourceUrlRef 永远不更新，导致永久黑屏。
          console.error('[useWatchTogether] applySourceToVideo 失败:', err)
          suppressEventsRef.current = false
          // 向用户展示错误（如不支持的视频格式），避免黑屏无反馈
          message.error(err instanceof Error ? err.message : '视频源加载失败')
        })
    }

    void loadMovie()
  }, [
    currentMovieId,
    movies,
    videoRef,
    watchTogether.playbackRate,
    setWatchTogether,
    applySourceToVideo,
    broadcastState,
    sendControl,
    quality,
    suppressEventsRef,
  ])

  // 组件卸载或切换房间时释放 MSE blob URL 与音频同步资源
  useEffect(() => {
    return () => {
      cleanupMedia()
    }
  }, [cleanupMedia])

  // Bug #14 修复：B站 CDN 地址 deadline 过期后，MSE 流式下载 fetch 会返回 403，
  // 播放器进入 stalled 状态。监听 video 的 stalled/error 事件，
  // 房主端自动触发 reloadBilibili 重新解析新地址（带 5s 去抖动 + 单次重试限制）。
  useEffect(() => {
    if (!isHostRef.current) return
    const video = videoRef.current
    if (!video) return

    const state = useRoomStore.getState().watchTogether
    if (state.sourceType !== 'bilibili') return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let lastReloadAt = 0
    const RELOAD_COOLDOWN_MS = 10000 // 同一影片 10s 内最多重新解析一次，避免死循环

    const triggerReload = () => {
      const now = Date.now()
      if (now - lastReloadAt < RELOAD_COOLDOWN_MS) {
        console.log(
          '[useWatchTogether] stalled/error 已在冷却期内，跳过重新解析'
        )
        return
      }
      lastReloadAt = now
      console.log('[useWatchTogether] 检测到播放停滞，自动重新解析 B站 视频')
      void reloadBilibili()
    }

    const handleStalled = () => {
      if (suppressEventsRef.current) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(triggerReload, 5000)
    }
    const handleError = () => {
      if (suppressEventsRef.current) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(triggerReload, 2000)
    }

    video.addEventListener('stalled', handleStalled)
    video.addEventListener('error', handleError)

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      video.removeEventListener('stalled', handleStalled)
      video.removeEventListener('error', handleError)
    }
  }, [
    videoRef,
    reloadBilibili,
    suppressEventsRef,
    watchTogether.sourceType,
    watchTogether.sourceUrl,
  ])

  /**
   * 房主端：播放预览源（不写入影片列表，直接加载并广播给观众）。
   * 用于 ani-subs / Kazumi 等番剧源选集后的实时播放。
   */
  const previewPlay = useCallback(
    (params: {
      url: string
      title?: string
      sourceType?: string
      format?: MediaFormat
      audioUrl?: string
      videoCodec?: string
      audioCodec?: string
      headers?: Record<string, string>
      duration?: number
    }) => {
      const video = videoRef.current
      if (!video) return

      const newState: WatchTogetherState = {
        sourceUrl: params.url,
        sourceType: params.sourceType || 'anime',
        audioUrl: params.audioUrl,
        format: params.format,
        videoCodec: params.videoCodec,
        audioCodec: params.audioCodec,
        isPlaying: true,
        currentTime: 0,
        playbackRate: watchTogether.playbackRate,
        duration: params.duration ?? 0,
        headers: params.headers,
        isPreview: true,
        previewTitle: params.title,
      }

      setWatchTogether(newState)
      // 清除当前影片标记，避免 loadMovie effect 触发覆盖预览源
      setCurrentMovieId(null)

      suppressEventsRef.current = true
      void applySourceToVideo(video, newState)
        .then(() => {
          video.currentTime = 0
          if (video.paused) {
            void safePlay(video)
          }
          suppressEventsRef.current = false
          // 广播给观众
          broadcastState(newState)
          // 通过专用事件通知观众加载预览源
          socket?.emit('play-preview-source', {
            roomId,
            source: {
              url: params.url,
              title: params.title,
              sourceType: params.sourceType,
              format: params.format,
              audioUrl: params.audioUrl,
              videoCodec: params.videoCodec,
              audioCodec: params.audioCodec,
              headers: params.headers,
              duration: params.duration,
            },
          })
        })
        .catch((err: unknown) => {
          console.error('[useWatchTogether] previewPlay 加载失败:', err)
          suppressEventsRef.current = false
          message.error(err instanceof Error ? err.message : '预览源加载失败')
        })
    },
    [
      videoRef,
      watchTogether.playbackRate,
      setWatchTogether,
      setCurrentMovieId,
      applySourceToVideo,
      broadcastState,
      socket,
      roomId,
      suppressEventsRef,
    ]
  )

  // 监听 pendingPreviewPlay：由 MoviePushPanel 等外部组件触发，
  // 通过 store 解耦后在此消费，调用内部 previewPlay 执行实际加载与广播。
  // 捕获后立即清除 pending，防止 previewPlay 内部 setWatchTogether
  // 触发重新渲染导致 effect 重复触发、多次 applySourceToVideo 并发。
  useEffect(() => {
    if (!pendingPreviewPlay) return
    const payload = pendingPreviewPlay
    setPendingPreviewPlay(null)
    previewPlay(payload)
  }, [pendingPreviewPlay, previewPlay, setPendingPreviewPlay])

  return {
    watchTogether,
    setWatchTogether,
    videoRef,
    isHost,
    broadcastState,
    sendControl,
    forceSync,
    suppressEventsRef,
    applySourceToVideo,
    cleanupMedia,
    previewPlay,
    // 清晰度相关
    currentQuality: quality.currentQuality,
    availableQualities: quality.availableQualities,
    isSwitchingQuality: quality.isSwitchingQuality,
    changeQuality,
    // B站 解析进度
    isResolving,
    resolvingMessage,
    // B站 重新解析
    reloadBilibili,
    // 轨道同步（合并事件）
    broadcastDanmakuTrackChange,
    broadcastSubtitleTrackChange,
    setSubtitleTrackIndex,
    subtitleTrackIndex,
    danmakuTrackId,
    onDanmakuTrackChange,
    onSubtitleTrackChange,
  }
}
