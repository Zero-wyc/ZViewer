import { useEffect, useRef, useState, useCallback } from 'react'
import flvjs from 'flv.js'
import { Maximize, Minimize, Volume2, VolumeX, Play, Pause } from 'lucide-react'
import { Spinner } from '@/components/ui/Spinner'

/** flv.js 统计信息 */
export interface FlvStatistics {
  /** 网络下载速度 (KB/s) */
  speed: number
  /** 视频码率 (kbps) */
  videoDataRate: number
  /** 音频码率 (kbps) */
  audioDataRate: number
  /** 当前帧率 */
  fps: number
  /** 丢帧数 */
  droppedVideoFrames: number
  /** 总帧数 */
  totalVideoFrames: number
}

interface FlvPlayerProps {
  /** 拉流地址（HTTP-FLV），例如 http://host:3335/live/xxx.flv */
  src: string
  /** 是否自动播放 */
  autoPlay?: boolean
  /** 是否静音（默认 true，处理浏览器自动播放策略） */
  muted?: boolean
  /** 附加 className */
  className?: string
  /** 拉流出错时回调 */
  onError?: (error: Error) => void
  /** 状态变化回调 */
  onStatusChange?: (
    status: 'connecting' | 'playing' | 'error' | 'stopped'
  ) => void
  /** 统计信息回调（每秒触发） */
  onStatistics?: (stats: FlvStatistics) => void
}

const MAX_RETRY = 5
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]

/**
 * 基于 flv.js 的 HTTP-FLV 拉流播放器。
 * - 拉流失败时自动重连（指数退避，最多 5 次）
 * - src 变化或组件卸载时销毁实例释放资源
 */
export function FlvPlayer({
  src,
  autoPlay = true,
  muted = true,
  className,
  onError,
  onStatusChange,
  onStatistics,
}: FlvPlayerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const playerRef = useRef<flvjs.Player | null>(null)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isMuted, setIsMuted] = useState(muted)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // 用 ref 存储回调，避免内联函数引用变化导致 useEffect 重新执行（播放器闪烁）
  const onErrorRef = useRef(onError)
  const onStatusChangeRef = useRef(onStatusChange)
  const onStatisticsRef = useRef(onStatistics)
  onErrorRef.current = onError
  onStatusChangeRef.current = onStatusChange
  onStatisticsRef.current = onStatistics

  // 帧率计算：flv.js STATISTICS_INFO 不直接提供 fps，通过 decodedVideoFrames 差值计算
  const lastStatsTimeRef = useRef(0)
  const lastDecodedFramesRef = useRef(0)

  // 创建并启动 flv player
  useEffect(() => {
    if (!videoRef.current || !src) return
    if (!flvjs.isSupported()) {
      const err = new Error('当前浏览器不支持 MSE / flv.js')
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 错误处理
      setErrorMsg(err.message)
      onErrorRef.current?.(err)
      onStatusChangeRef.current?.('error')
      return
    }

    setLoading(true)
    setErrorMsg(null)
    onStatusChangeRef.current?.('connecting')
    // 重置帧率计算基准
    lastStatsTimeRef.current = 0
    lastDecodedFramesRef.current = 0

    const player = flvjs.createPlayer(
      {
        type: 'flv',
        url: src,
        isLive: true,
        cors: true,
      },
      {
        enableWorker: false,
        enableStashBuffer: true,
        stashInitialSize: 256,
        // 自动清理已播放的 SourceBuffer，防止内存膨胀
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 8,
        autoCleanupMinBackwardDuration: 4,
        // 直播延迟追赶：缓冲超过阈值时自动追帧（flv.js 运行时支持，类型定义缺失）
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 1.5,
        liveBufferLatencyTargetLatency: 0.5,
      } as Record<string, unknown>
    )
    player.attachMediaElement(videoRef.current)
    player.on(flvjs.Events.ERROR, (errorType: string, errorDetail: string) => {
      console.error('[FlvPlayer] error:', errorType, errorDetail)
      if (retryCountRef.current < MAX_RETRY) {
        const delay = RETRY_DELAYS_MS[retryCountRef.current]
        retryCountRef.current += 1
        console.log(
          `[FlvPlayer] retry ${retryCountRef.current}/${MAX_RETRY} in ${delay}ms`
        )
        onStatusChangeRef.current?.('connecting')
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => {
          player.unload()
          player.load()
          try {
            const ret = player.play()
            if (ret && typeof ret.catch === 'function') ret.catch(() => {})
          } catch {
            // ignore
          }
        }, delay)
      } else {
        const err = new Error(
          `拉流失败（${errorType}/${errorDetail}），已重试 ${MAX_RETRY} 次`
        )
        setErrorMsg(err.message)
        onErrorRef.current?.(err)
        onStatusChangeRef.current?.('error')
      }
    })
    player.on(flvjs.Events.MEDIA_INFO, () => {
      retryCountRef.current = 0
      setLoading(false)
      setErrorMsg(null)
    })

    // 统计信息上报（flv.js 内部约每秒触发一次）
    player.on(flvjs.Events.STATISTICS_INFO, (info: Record<string, unknown>) => {
      const now = performance.now()
      const decodedFrames = (info.decodedVideoFrames as number) ?? 0
      const droppedFrames = (info.droppedVideoFrames as number) ?? 0

      // 通过两次统计的帧数差和时间差计算实际帧率
      let fps = 0
      if (lastStatsTimeRef.current > 0) {
        const dt = (now - lastStatsTimeRef.current) / 1000
        const frameDelta = decodedFrames - lastDecodedFramesRef.current
        if (dt > 0 && frameDelta >= 0) {
          fps = Math.round(frameDelta / dt)
        }
      }
      lastStatsTimeRef.current = now
      lastDecodedFramesRef.current = decodedFrames

      onStatisticsRef.current?.({
        speed: Math.round((info.speed as number) ?? 0),
        videoDataRate: Math.round((info.videoDataRate as number) ?? 0),
        audioDataRate: Math.round((info.audioDataRate as number) ?? 0),
        fps,
        droppedVideoFrames: droppedFrames,
        totalVideoFrames: decodedFrames + droppedFrames,
      })
    })

    // 兜底：当 video 元素实际拿到画面时关闭 loading（部分流 MEDIA_INFO 触发较晚或不触发）
    const video = videoRef.current
    const handleLoadedMetadata = () => {
      retryCountRef.current = 0
      setLoading(false)
      setErrorMsg(null)
    }
    video.addEventListener('loadedmetadata', handleLoadedMetadata)

    // 卡死自动恢复：当视频暂停但 buffered 有数据时，向前跳过一小段恢复播放
    const handleWaiting = () => {
      if (video.readyState < 3) {
        // readyState < 3 (HAVE_FUTURE_DATA) 说明缓冲不足，尝试追帧
        const buffered = video.buffered
        if (buffered.length > 0) {
          const bufferedEnd = buffered.end(buffered.length - 1)
          // 如果缓冲区末尾比当前时间超前较多，跳到接近缓冲区末尾
          if (bufferedEnd - video.currentTime > 0.5) {
            video.currentTime = bufferedEnd - 0.3
            console.log('[FlvPlayer] recovered from stall, seek to', video.currentTime)
          }
        }
      }
    }
    video.addEventListener('waiting', handleWaiting)

    // 兜底：video 播放卡住但未触发 waiting 时，通过定时器检测 stalled 状态
    const stallCheckTimer = setInterval(() => {
      if (!video.paused && video.readyState < 3) {
        const buffered = video.buffered
        if (buffered.length > 0) {
          const bufferedEnd = buffered.end(buffered.length - 1)
          if (bufferedEnd - video.currentTime > 0.5) {
            video.currentTime = bufferedEnd - 0.3
            console.log('[FlvPlayer] recovered from stall (timer), seek to', video.currentTime)
          }
        }
      }
    }, 3000)

    player.on(flvjs.Events.LOADING_COMPLETE, () => {
      // 直播流不应触发 LOADING_COMPLETE，触发说明流已结束
      console.warn('[FlvPlayer] loading complete (stream ended)')
      onStatusChangeRef.current?.('stopped')
    })
    player.load()
    if (autoPlay) {
      const tryPlay = async () => {
        try {
          const ret = video.play()
          if (ret && typeof ret.catch === 'function') {
            await ret.catch(async (err: Error) => {
              console.warn('[FlvPlayer] autoplay failed:', err)
              // 自动播放被浏览器策略阻止时，尝试静音播放
              if (!video.muted) {
                video.muted = true
                try {
                  await video.play()
                  console.log('[FlvPlayer] muted autoplay succeeded')
                } catch (mutedErr) {
                  console.warn('[FlvPlayer] muted autoplay failed:', mutedErr)
                }
              }
            })
          }
        } catch (err) {
          console.warn('[FlvPlayer] autoplay failed:', err)
        }
      }
      void tryPlay()
    }

    playerRef.current = player
    onStatusChangeRef.current?.('playing')

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('waiting', handleWaiting)
      clearInterval(stallCheckTimer)
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      retryCountRef.current = 0
      try {
        player.unload()
        player.detachMediaElement()
        player.destroy()
      } catch (err) {
        console.error('[FlvPlayer] destroy error:', err)
      }
      playerRef.current = null
    }
  }, [src, autoPlay])

  // 同步 muted 状态
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted
      setIsMuted(muted)
    }
  }, [muted])

  // 全屏切换
  const handleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      el.requestFullscreen().catch(() => {})
    }
  }, [])

  // 静音切换
  const handleToggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted
      setIsMuted(videoRef.current.muted)
    }
  }, [])

  // 播放/暂停
  const [isPlaying, setIsPlaying] = useState(false)
  const handleTogglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [])

  // 全屏状态
  const [isFullscreen, setIsFullscreen] = useState(false)

  // 控制栏自动隐藏
  const [controlsVisible, setControlsVisible] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showControls = useCallback(() => {
    setControlsVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      // 播放中且非暂停时才自动隐藏
      if (videoRef.current && !videoRef.current.paused) {
        setControlsVisible(false)
      }
    }, 2500)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    if (videoRef.current && !videoRef.current.paused) {
      setControlsVisible(false)
    }
  }, [])

  // 同步全屏状态
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // 同步播放状态
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [])

  // 清理隐藏定时器
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`group relative h-full w-full ${className ?? ''}`}
      onMouseMove={showControls}
      onMouseLeave={handleMouseLeave}
    >
      <video
        ref={videoRef}
        autoPlay={autoPlay}
        playsInline
        muted={isMuted}
        className="h-full w-full object-contain"
      />

      {/* 控制栏 */}
      {!loading && !errorMsg && (
        <div
          className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-8 transition-opacity duration-200 ${
            controlsVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <div className="flex flex-wrap items-center justify-center gap-1.5 sm:justify-end">
            <button
              onClick={handleTogglePlay}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-white backdrop-blur transition hover:bg-white/20"
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={handleToggleMute}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
              title={isMuted ? '取消静音' : '静音'}
            >
              {isMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <button
              onClick={handleFullscreen}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
              title={isFullscreen ? '退出全屏' : '全屏'}
            >
              {isFullscreen ? (
                <Minimize className="h-4 w-4" />
              ) : (
                <Maximize className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      )}

      {loading && !errorMsg && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <Spinner tip="正在连接直播流..." size={32} />
        </div>
      )}
      {errorMsg && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
          <div className="text-base font-medium text-[var(--md-sys-color-error)]">
            {errorMsg}
          </div>
          <div className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
            请检查网络连接或房主推流状态
          </div>
        </div>
      )}
    </div>
  )
}
