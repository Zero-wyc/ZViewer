import { useEffect, useRef, useCallback, useState } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import {
  useRoomStore,
  type WatchTogetherState,
  type MovieDto,
  mapDtoToMovie,
} from '@/store/roomStore'
import {
  createMseMediaUrl,
  createAudioSync,
  resetVideoElement,
} from './msePlayer'
import {
  resolveBilibili,
  getBilibiliParseOptions,
  type QualityOption,
} from './resolveSource'

export type SourceType =
  'url' | 'webdav' | 'ftp' | 'openlist' | 'smb' | 'bilibili' | string

export type { QualityOption }

interface UseWatchTogetherOptions {
  roomId: string
  isHost: boolean
  videoRef: React.RefObject<HTMLVideoElement | null>
}

export function useWatchTogether({
  roomId,
  isHost,
  videoRef,
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
  } = useRoomStore()
  const isHostRef = useRef(isHost)
  const suppressEventsRef = useRef(false)
  const lastStateRef = useRef<WatchTogetherState | null>(null)
  const mediaUrlRef = useRef<string | null>(null)
  const audioCleanupRef = useRef<(() => void) | null>(null)
  const seekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastBroadcastTimeRef = useRef(0)
  const restoredRef = useRef(false)
  const lastLoadedMovieRef = useRef<{ id: number; url: string } | null>(null)

  // 使用用户本地持久化的 B站解析偏好（编码 / CDN）重新解析
  const resolveBilibiliWithOptions = useCallback(
    async (
      url: string,
      qn?: number,
      onProgress?: (step: string, message: string) => void
    ) => {
      const options = getBilibiliParseOptions()
      return resolveBilibili(url, qn, onProgress, {
        fnval: options.fnval,
        preferCdn: options.preferCdn,
      })
    },
    []
  )

  // 清晰度状态：当前选中的 qn、可用列表、切换中标记
  const [currentQuality, setCurrentQuality] = useState<number | null>(null)
  const [availableQualities, setAvailableQualities] = useState<QualityOption[]>(
    []
  )
  const [isSwitchingQuality, setIsSwitchingQuality] = useState(false)

  // B站 视频解析进度：用于在播放器上显示后台解析过程
  const [isResolving, setIsResolving] = useState(false)
  const [resolvingMessage, setResolvingMessage] = useState('')

  const cleanupMedia = useCallback(() => {
    if (mediaUrlRef.current) {
      URL.revokeObjectURL(mediaUrlRef.current)
      mediaUrlRef.current = null
    }
    if (audioCleanupRef.current) {
      audioCleanupRef.current()
      audioCleanupRef.current = null
    }
  }, [])

  // 将指定状态中的视频源应用到 video 元素（含 MSE DASH 处理）。
  // 供房主加载、观众同步以及组件重新挂载时恢复使用。
  const applySourceToVideo = useCallback(
    async (video: HTMLVideoElement, state: WatchTogetherState) => {
      if (!state.sourceUrl) return

      // 先 detach 旧的 MediaSource，再清理 blob URL，避免 revoke 正在 attached 的 URL 导致 Format error
      resetVideoElement(video)
      cleanupMedia()

      if (state.format === 'dash' || state.audioUrl) {
        const audioUrl = state.audioUrl || ''
        if (!audioUrl) {
          if (video.src !== state.sourceUrl) {
            video.src = state.sourceUrl
            video.load()
          }
          return
        }

        const loadMse = async (
          videoUrl: string,
          audioUrl: string,
          isRetry: boolean
        ): Promise<boolean> => {
          try {
            const blobUrl = await createMseMediaUrl(
              video,
              videoUrl,
              audioUrl,
              state.videoCodec,
              state.audioCodec
            )
            mediaUrlRef.current = blobUrl
            return true
          } catch (err) {
            // B站 DASH 地址过期较快，允许重新解析后重试一次 MSE 合并
            if (!isRetry && state.sourceType === 'bilibili') {
              const storeState = useRoomStore.getState()
              const movie = storeState.movies.find(
                (m) => m.id === storeState.currentMovieId
              )
              if (movie?.url) {
                try {
                  resetVideoElement(video)
                  cleanupMedia()
                  const resolved = await resolveBilibiliWithOptions(movie.url)
                  if (resolved.videoUrl && resolved.audioUrl) {
                    const retried = await loadMse(
                      resolved.videoUrl,
                      resolved.audioUrl,
                      true
                    )
                    if (retried) {
                      storeState.setWatchTogether({
                        sourceUrl: resolved.videoUrl,
                        audioUrl: resolved.audioUrl,
                        videoCodec: resolved.videoCodec,
                        audioCodec: resolved.audioCodec,
                        format: resolved.format,
                        cid: resolved.cid,
                        duration: resolved.duration ?? state.duration,
                      })
                    }
                    return retried
                  }
                } catch (resolveErr) {
                  console.warn(
                    '[useWatchTogether] 重新解析 B站 失败:',
                    resolveErr
                  )
                }
              }
            }
            return false
          }
        }

        const success = await loadMse(state.sourceUrl, audioUrl, false)
        if (!success) {
          // DASH 源的 sourceUrl 是 m4s 片段，不能直接作为 video.src 播放，
          // 直接赋值会导致 MEDIA_ELEMENT_ERROR: Format error。
          if (state.format === 'dash') {
            throw new Error('MSE 合并失败，DASH 源无法直接播放')
          }
          console.warn('[useWatchTogether] MSE 合并失败，降级为音频同步')
          if (video.src !== state.sourceUrl) {
            video.src = state.sourceUrl
            video.load()
          }
          audioCleanupRef.current = createAudioSync(video, audioUrl)
        }
      } else if (video.src !== state.sourceUrl) {
        video.src = state.sourceUrl
        video.load()
      }
    },
    [cleanupMedia]
  )

  useEffect(() => {
    isHostRef.current = isHost
  }, [isHost])

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

    socket.on('movie-list', handleMovieList)
    socket.on('current-movie', handleCurrentMovie)

    // 房间加入/刷新时优先通过 REST 接口加载影片列表
    fetchMovies(roomId).catch((err) => {
      console.error('[useWatchTogether] fetchMovies error:', err)
    })
    socket.emit('request-current-movie', { roomId })

    return () => {
      socket.off('movie-list', handleMovieList)
      socket.off('current-movie', handleCurrentMovie)
    }
  }, [socket, roomId, setMovies, setCurrentMovieId, fetchMovies])

  // 房主：将本地状态广播给房间
  const broadcastState = useCallback(
    (state: WatchTogetherState) => {
      if (!socket || !isHostRef.current) return
      const serialized = JSON.stringify(state)
      if (serialized === JSON.stringify(lastStateRef.current)) return
      lastStateRef.current = state
      socket.emit('watch-together-state', { roomId, state })
    },
    [socket, roomId]
  )

  // 房主：发送控制事件（播放/暂停/进度/倍速）
  const sendControl = useCallback(
    (action: 'play' | 'pause' | 'seek' | 'rate', value?: number) => {
      if (!socket || !isHostRef.current) return
      socket.emit('watch-together-control', { roomId, action, value })
    },
    [socket, roomId]
  )

  // 房主：强制广播当前状态，用于手动同步
  const forceSync = useCallback(() => {
    if (!socket || !isHostRef.current) return
    const video = videoRef.current
    const state = useRoomStore.getState().watchTogether
    const hasLoadedSource = video && video.currentSrc !== ''
    const newState: WatchTogetherState = {
      sourceUrl: state.sourceUrl,
      sourceType: state.sourceType,
      audioUrl: state.audioUrl,
      format: state.format,
      videoCodec: state.videoCodec,
      audioCodec: state.audioCodec,
      cid: state.cid,
      isPlaying: hasLoadedSource ? !video.paused : state.isPlaying,
      currentTime: hasLoadedSource ? video.currentTime : state.currentTime,
      playbackRate: hasLoadedSource ? video.playbackRate : state.playbackRate,
      duration: hasLoadedSource
        ? video.duration || state.duration
        : state.duration,
    }
    lastStateRef.current = newState
    socket.emit('watch-together-state', { roomId, state: newState })
  }, [socket, roomId, videoRef])

  // 根据当前视频源类型计算可用清晰度列表。
  // B站 DASH 流使用后端返回的真实 acceptQuality；其他单源类型返回空数组，由 UI 隐藏选择器。
  useEffect(() => {
    const state = watchTogether
    if (
      state.sourceType === 'bilibili' &&
      state.format === 'dash' &&
      state.sourceUrl
    ) {
      setAvailableQualities(state.acceptQuality ?? [])
      setCurrentQuality((prev) => prev ?? state.currentQn ?? null)
    } else {
      setAvailableQualities([])
      setCurrentQuality(null)
    }
    // 切源时重置切换中标记，避免上一源的切换状态被遗留
    setIsSwitchingQuality(false)
  }, [
    watchTogether.sourceType,
    watchTogether.format,
    watchTogether.sourceUrl,
    watchTogether.acceptQuality,
    watchTogether.currentQn,
  ])

  // 房主：切换清晰度。重新解析对应 qn 的 URL、attach MSE 流并保留进度，同时广播给观众。
  const changeQuality = useCallback(
    async (qualityId: number) => {
      const video = videoRef.current
      if (!video || !isHostRef.current) return
      if (qualityId === currentQuality) return

      // 仅 B站 DASH 流支持清晰度切换
      const state = useRoomStore.getState().watchTogether
      if (state.sourceType !== 'bilibili' || state.format !== 'dash') return

      const storeState = useRoomStore.getState()
      const movie = storeState.movies.find(
        (m) => m.id === storeState.currentMovieId
      )
      if (!movie?.url) return

      setIsSwitchingQuality(true)
      setIsResolving(true)
      setResolvingMessage('正在切换清晰度...')
      suppressEventsRef.current = true

      const preserveTime = video.currentTime
      const shouldPlay = !video.paused

      try {
        const resolved = await resolveBilibiliWithOptions(
          movie.url,
          qualityId,
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
          currentQn: resolved.currentQn ?? qualityId,
          acceptQuality: resolved.acceptQuality,
        }
        setWatchTogether(newState)

        await applySourceToVideo(video, newState)
        video.currentTime = preserveTime
        if (shouldPlay) {
          video.play().catch(() => {})
        }

        setCurrentQuality(qualityId)

        // 广播 quality-change 事件给观众
        if (socket) {
          socket.emit('quality-change', { roomId, quality: qualityId })
        }
      } catch (err) {
        console.error('[useWatchTogether] 切换清晰度失败:', err)
        // 切换失败时回退到原 source（尽力恢复）
        try {
          await applySourceToVideo(video, state)
          if (preserveTime > 0) {
            video.currentTime = preserveTime
          }
          if (shouldPlay) {
            video.play().catch(() => {})
          }
        } catch {
          // 忽略恢复失败
        }
      } finally {
        suppressEventsRef.current = false
        setIsSwitchingQuality(false)
        setIsResolving(false)
        setResolvingMessage('')
      }
    },
    [
      socket,
      roomId,
      videoRef,
      currentQuality,
      applySourceToVideo,
      setWatchTogether,
    ]
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
        currentQuality ?? movie.currentQn,
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
        currentQn: resolved.currentQn ?? currentQuality ?? movie.currentQn,
        acceptQuality: resolved.acceptQuality,
      }
      setWatchTogether(newState)

      await applySourceToVideo(video, newState)
      video.currentTime = preserveTime
      if (shouldPlay) {
        video.play().catch(() => {})
      }

      setCurrentQuality(newState.currentQn ?? null)
      setAvailableQualities(newState.acceptQuality ?? [])

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
          video.play().catch(() => {})
        }
      } catch {
        // 忽略恢复失败
      }
    } finally {
      suppressEventsRef.current = false
      setIsSwitchingQuality(false)
      setIsResolving(false)
      setResolvingMessage('')
    }
  }, [
    videoRef,
    currentQuality,
    applySourceToVideo,
    setWatchTogether,
    broadcastState,
    roomId,
    socket,
  ])

  // 观众：接收房主的 quality-change 事件，自动切换到对应清晰度。
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleQualityChange = async (payload: { quality: number }) => {
      const video = videoRef.current
      if (!video) {
        setCurrentQuality(payload.quality)
        return
      }

      const state = useRoomStore.getState().watchTogether
      if (state.sourceType !== 'bilibili' || state.format !== 'dash') {
        setCurrentQuality(payload.quality)
        return
      }

      const movie = useRoomStore
        .getState()
        .movies.find((m) => m.id === useRoomStore.getState().currentMovieId)
      if (!movie?.url) {
        setCurrentQuality(payload.quality)
        return
      }

      setIsSwitchingQuality(true)
      setIsResolving(true)
      setResolvingMessage('正在同步清晰度...')
      suppressEventsRef.current = true

      const preserveTime = video.currentTime
      const shouldPlay = !video.paused

      try {
        const resolved = await resolveBilibiliWithOptions(
          movie.url,
          payload.quality,
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
          currentQn: resolved.currentQn ?? payload.quality,
          acceptQuality: resolved.acceptQuality,
        }
        setWatchTogether(newState)

        await applySourceToVideo(video, newState)
        video.currentTime = preserveTime
        if (shouldPlay) {
          video.play().catch(() => {})
        }
        setCurrentQuality(payload.quality)
      } catch (err) {
        console.error('[useWatchTogether] 观众端切换清晰度失败:', err)
        try {
          await applySourceToVideo(video, state)
          if (preserveTime > 0) {
            video.currentTime = preserveTime
          }
          if (shouldPlay) {
            video.play().catch(() => {})
          }
        } catch {
          // 忽略恢复失败
        }
      } finally {
        suppressEventsRef.current = false
        setIsSwitchingQuality(false)
        setIsResolving(false)
        setResolvingMessage('')
      }
    }

    socket.on('quality-change', handleQualityChange)
    return () => {
      socket.off('quality-change', handleQualityChange)
    }
  }, [socket, roomId, videoRef, applySourceToVideo])

  // 响应 MovieListPanel 触发的清晰度切换请求：若对应影片正在播放，立即应用新源。
  useEffect(() => {
    if (!pendingQualityChange) return

    const applyPendingQuality = async () => {
      const video = videoRef.current
      if (!video) {
        setPendingQualityChange(null)
        return
      }

      if (pendingQualityChange.movieId !== currentMovieId) {
        setPendingQualityChange(null)
        return
      }

      const existingState = useRoomStore.getState().watchTogether
      const preserveTime = video.currentTime
      const shouldPlay = !video.paused

      const resolved = pendingQualityChange.resolved
      const newState: WatchTogetherState = {
        ...existingState,
        sourceUrl: resolved.videoUrl,
        audioUrl: resolved.audioUrl,
        videoCodec: resolved.videoCodec,
        audioCodec: resolved.audioCodec,
        format: resolved.format,
        cid: resolved.cid,
        duration: resolved.duration ?? existingState.duration,
        currentQn: resolved.currentQn,
        acceptQuality: resolved.acceptQuality,
        playbackRate: existingState.playbackRate,
        isPlaying: shouldPlay,
        currentTime: preserveTime,
      }

      suppressEventsRef.current = true

      try {
        setWatchTogether(newState)
        await applySourceToVideo(video, newState)
        video.currentTime = preserveTime
        if (shouldPlay) {
          video.play().catch(() => {})
        }
        if (isHostRef.current) {
          broadcastState(newState)
        }
        setCurrentQuality(newState.currentQn ?? null)
        setAvailableQualities(newState.acceptQuality ?? [])
      } catch (err) {
        console.error('[useWatchTogether] 应用列表触发的清晰度切换失败:', err)
        try {
          await applySourceToVideo(video, existingState)
          if (preserveTime > 0) {
            video.currentTime = preserveTime
          }
          if (shouldPlay) {
            video.play().catch(() => {})
          }
        } catch {
          // 忽略恢复失败
        }
        message.warning('切换清晰度失败，已恢复为原清晰度')
      } finally {
        suppressEventsRef.current = false
        setPendingQualityChange(null)
      }
    }

    void applyPendingQuality()
  }, [
    pendingQualityChange,
    currentMovieId,
    videoRef,
    setWatchTogether,
    applySourceToVideo,
    broadcastState,
    setPendingQualityChange,
  ])

  // currentMovieId 变化时自动加载对应影片到 video 元素
  useEffect(() => {
    if (!currentMovieId) return
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
            setAvailableQualities(acceptQuality)
          }
          setCurrentQuality(currentQn ?? acceptQuality?.[0]?.id ?? null)
        } catch (err) {
          console.error(
            '[useWatchTogether] 解析 B站 视频失败，使用已有地址重试:',
            err
          )
          message.error(err instanceof Error ? err.message : 'B站视频解析失败')
        } finally {
          setIsResolving(false)
          setResolvingMessage('')
        }
      }

      const newState: WatchTogetherState = {
        sourceUrl,
        sourceType,
        audioUrl,
        format,
        videoCodec,
        audioCodec,
        cid,
        isPlaying: true,
        currentTime: 0,
        playbackRate: watchTogether.playbackRate,
        duration,
        currentQn,
        acceptQuality,
      }

      setWatchTogether(newState)
      void applySourceToVideo(video, newState).then(() => {
        video.currentTime = 0
        if (video.paused) {
          video.play().catch(() => {
            // 浏览器自动播放策略可能阻止播放
          })
        }
        suppressEventsRef.current = false

        if (isHostRef.current) {
          broadcastState(newState)
          sendControl('play')
        }
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
  ])

  // 观众：接收房主的状态同步与控制事件
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleState = (payload: { state: WatchTogetherState }) => {
      const state = payload.state
      suppressEventsRef.current = true
      setWatchTogether(state)

      const video = videoRef.current
      if (!video) {
        suppressEventsRef.current = false
        return
      }

      void applySourceToVideo(video, state)

      // 仅在差异较大时更新进度，避免抖动；seek 由 control 事件立即同步
      if (Math.abs(video.currentTime - state.currentTime) > 1.5) {
        video.currentTime = state.currentTime
      }
      if (video.playbackRate !== state.playbackRate) {
        video.playbackRate = state.playbackRate
      }
      if (state.isPlaying && video.paused) {
        video.play().catch(() => {
          // 浏览器自动播放策略可能阻止播放
        })
      } else if (!state.isPlaying && !video.paused) {
        video.pause()
      }
      suppressEventsRef.current = false
    }

    const handleControl = (payload: {
      action: 'play' | 'pause' | 'seek' | 'rate'
      value?: number
    }) => {
      const video = videoRef.current
      if (!video) return
      suppressEventsRef.current = true
      switch (payload.action) {
        case 'play':
          video.play().catch(() => {})
          break
        case 'pause':
          video.pause()
          break
        case 'seek':
          if (typeof payload.value === 'number') {
            video.currentTime = payload.value
          }
          break
        case 'rate':
          if (typeof payload.value === 'number') {
            video.playbackRate = payload.value
          }
          break
      }
      suppressEventsRef.current = false
    }

    socket.on('watch-together-state', handleState)
    socket.on('watch-together-control', handleControl)

    // 刚加入时请求当前状态
    socket.emit('watch-together-request-state', { roomId })

    return () => {
      socket.off('watch-together-state', handleState)
      socket.off('watch-together-control', handleControl)
    }
  }, [socket, roomId, videoRef, setWatchTogether, applySourceToVideo])

  // 房主：响应观众的状态请求，广播当前状态
  useEffect(() => {
    if (!socket || !isHostRef.current) return

    const handleRequestState = () => {
      const video = videoRef.current
      const state = useRoomStore.getState().watchTogether
      // 若 video 元素尚未完成源恢复（例如房主刚切回一起看模式），
      // 回退到 roomStore 中保存的状态，避免把观众重置到 00:00。
      const hasLoadedSource = video && video.currentSrc !== ''
      const newState: WatchTogetherState = {
        sourceUrl: state.sourceUrl,
        sourceType: state.sourceType,
        audioUrl: state.audioUrl,
        format: state.format,
        videoCodec: state.videoCodec,
        audioCodec: state.audioCodec,
        cid: state.cid,
        isPlaying: hasLoadedSource ? !video.paused : state.isPlaying,
        currentTime: hasLoadedSource ? video.currentTime : state.currentTime,
        playbackRate: hasLoadedSource ? video.playbackRate : state.playbackRate,
        duration: hasLoadedSource
          ? video.duration || state.duration
          : state.duration,
      }
      lastStateRef.current = newState
      socket.emit('watch-together-state', { roomId, state: newState })
    }

    socket.on('watch-together-request-state', handleRequestState)
    return () => {
      socket.off('watch-together-request-state', handleRequestState)
    }
  }, [socket, roomId, videoRef])

  // 组件重新挂载（或 videoRef 首次可用）时，从 roomStore 恢复视频源。
  // 通过 restoredRef 保证每个挂载周期只恢复一次，避免与 handleLoad / handleState 重复加载。
  useEffect(() => {
    const video = videoRef.current
    const state = useRoomStore.getState().watchTogether
    if (!video || !state.sourceUrl || restoredRef.current) return

    restoredRef.current = true
    suppressEventsRef.current = true
    void applySourceToVideo(video, state).then(() => {
      if (state.currentTime > 0) {
        video.currentTime = state.currentTime
      }
      if (video.playbackRate !== state.playbackRate) {
        video.playbackRate = state.playbackRate
      }
      if (state.isPlaying && video.paused) {
        video.play().catch(() => {
          // 浏览器自动播放策略可能阻止播放
        })
      }
      suppressEventsRef.current = false
    })
  }, [watchTogether.sourceUrl, applySourceToVideo, videoRef])

  // 绑定 video 元素事件：房主操作时广播状态
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isHostRef.current) return

    const updateState = (forceBroadcast = false) => {
      if (suppressEventsRef.current) return
      const state: WatchTogetherState = {
        sourceUrl: watchTogether.sourceUrl,
        sourceType: watchTogether.sourceType,
        audioUrl: watchTogether.audioUrl,
        format: watchTogether.format,
        videoCodec: watchTogether.videoCodec,
        audioCodec: watchTogether.audioCodec,
        cid: watchTogether.cid,
        isPlaying: !video.paused,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
        duration: video.duration || watchTogether.duration,
      }
      setWatchTogether(state)
      const now = Date.now()
      if (forceBroadcast || now - lastBroadcastTimeRef.current > 1000) {
        broadcastState(state)
        lastBroadcastTimeRef.current = now
      }
    }

    const handlePlay = () => {
      if (suppressEventsRef.current) return
      sendControl('play')
      updateState(true)
    }
    const handlePause = () => {
      if (suppressEventsRef.current) return
      sendControl('pause')
      updateState(true)
    }
    const handleSeeked = () => {
      if (suppressEventsRef.current) return
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current)
      }
      seekDebounceRef.current = setTimeout(() => {
        sendControl('seek', video.currentTime)
        updateState(true)
      }, 200)
    }
    const handleRateChange = () => {
      if (suppressEventsRef.current) return
      sendControl('rate', video.playbackRate)
      updateState(true)
    }
    const handleTimeUpdate = () => {
      if (suppressEventsRef.current) return
      updateState(false)
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('seeked', handleSeeked)
    video.addEventListener('ratechange', handleRateChange)
    video.addEventListener('timeupdate', handleTimeUpdate)

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('ratechange', handleRateChange)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      if (seekDebounceRef.current) {
        clearTimeout(seekDebounceRef.current)
      }
    }
  }, [
    videoRef,
    watchTogether.sourceUrl,
    watchTogether.sourceType,
    watchTogether.cid,
    watchTogether.audioUrl,
    watchTogether.format,
    watchTogether.videoCodec,
    watchTogether.audioCodec,
    broadcastState,
    sendControl,
    setWatchTogether,
    watchTogether.duration,
  ])

  // 组件卸载或切换房间时释放 MSE blob URL 与音频同步资源
  useEffect(() => {
    return () => {
      cleanupMedia()
    }
  }, [cleanupMedia])

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
    // 清晰度相关
    currentQuality,
    availableQualities,
    isSwitchingQuality,
    changeQuality,
    // B站 解析进度
    isResolving,
    resolvingMessage,
    // B站 重新解析
    reloadBilibili,
  }
}
