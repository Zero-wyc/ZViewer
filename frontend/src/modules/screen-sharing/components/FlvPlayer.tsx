/**
 * FlvPlayer —— HTTP-FLV 拉流播放器（ArtPlayer 壳 + 统一引擎路由版）。
 *
 * - ArtPlayer 仅承担 UI（isLive 模式 + 自定义玻璃拟态控制栏），与
 *   WebRTC 控制栏风格一致
 * - 拉流与 flv.js 实例管理走引擎层统一路由（selectEngine → flv-engine
 *   isLive 模式）：重连（指数退避 5 次）、延迟追赶、统计上报由引擎
 *   提供，本组件只消费 FlvRuntimeEvents 驱动连接状态机与统计展示
 * - 保留：自动播放静音重试、卡死自动恢复（waiting 兜底跳帧 +
 *   stalled 定时器检测）、刷新重建
 * - props 契约与重构前完全一致（WatchPage / StreamPushPage 无需改动）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Artplayer from 'artplayer'
import type { Option } from 'artplayer'
import {
  Maximize,
  Maximize2,
  Minimize,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { IconButton } from '@/components/VideoControls'
import { configureArtStatics } from '@/modules/art-player'
import { usePlayerSource } from '@/modules/player'
import type { FlvRuntimeEvents, PlayerSource } from '@/modules/player'
import { cn } from '@/lib/utils'
import {
  isIOSDevice,
  supportsContainerFullscreen,
  getFullscreenElement,
  exitFullscreen,
  requestFullscreen,
  onFullscreenChange,
} from '@/lib/fullscreen-utils'
import { useControlBarAutoHide } from '@/hooks/useControlBarAutoHide'
import '@/modules/art-player/art-overrides.css'

/** flv.js 统计信息
 *
 * 注意：flv.js 的 STATISTICS_INFO 事件只提供网络层统计，
 * 不提供 videoDataRate/audioDataRate 等编码层信息。
 * 帧率通过 decodedFrames 差值自行计算，
 * 总码率近似为 speed（下载速度 KB/s）× 8。
 */
export interface FlvStatistics {
  /** 网络下载速度 (KB/s) */
  speed: number
  /** 当前近似总码率 (Kbps)，由 speed × 8 计算得出 */
  totalDataRate: number
  /** 当前帧率（fps），由 decodedFrames 差值 / 时间差计算） */
  fps: number
  /** 已解码帧数 */
  decodedFrames: number
  /** 丢帧数 */
  droppedFrames: number
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
  /** 网页全屏状态（受控） */
  isWebFullscreen?: boolean
  /** 切换网页全屏 */
  onToggleWebFullscreen?: () => void
}

type StreamStatus = 'connecting' | 'playing' | 'error' | 'stopped'

export function FlvPlayer({
  src,
  autoPlay = true,
  muted = true,
  className,
  onError,
  onStatusChange,
  onStatistics,
  isWebFullscreen = false,
  onToggleWebFullscreen,
}: FlvPlayerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(muted)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting')

  // 控制栏自动隐藏（逻辑仿照 WatchTogetherCore）
  const controlBarVisible = useControlBarAutoHide(stageRef, {
    disabled: loading || !!errorMsg,
  })

  // 用 ref 存储回调，避免内联函数引用变化导致 useEffect 重新执行（播放器闪烁）
  const onErrorRef = useRef(onError)
  const onStatusChangeRef = useRef(onStatusChange)
  const onStatisticsRef = useRef(onStatistics)
  const mutedRef = useRef(muted)
  const autoPlayRef = useRef(autoPlay)

  useEffect(() => {
    onErrorRef.current = onError
    onStatusChangeRef.current = onStatusChange
    onStatisticsRef.current = onStatistics
    mutedRef.current = muted
    autoPlayRef.current = autoPlay
  }, [onError, onStatusChange, onStatistics, muted, autoPlay])

  // 统一引擎路由：attach / cleanup 由 usePlayerSource 管理（串行队列、
  // video 级会话互斥、活跃引擎登记）。直播错误由 flv-engine 内部退避
  // 重连并经 flvRuntimeEvents 上报，不经 onPlaybackError 全局提示。
  const { attachSource, cleanup } = usePlayerSource({ videoRef })

  // 统计帧率计算状态（flv.js STATISTICS_INFO 不直接提供 fps）
  const lastStatsTimeRef = useRef(0)
  const lastDecodedFramesRef = useRef(0)

  // 创建 ArtPlayer + 引擎 attach（src 变化 / 手动刷新时重建）
  useEffect(() => {
    const container = containerRef.current
    if (!container || !src) return

    configureArtStatics()

    setLoading(true)
    setErrorMsg(null)
    setStreamStatus('connecting')
    onStatusChangeRef.current?.('connecting')
    lastStatsTimeRef.current = 0
    lastDecodedFramesRef.current = 0

    // ── ArtPlayer 实例（isLive 隐藏进度条与时间显示）────────────
    const art = new Artplayer({
      container,
      url: '',
      lang: 'zh-cn',
      isLive: true,
      muted: mutedRef.current,
      autoplay: false,
      // 禁用单击视频区域暂停：共享画面通过控制栏按钮控制
      click: false,
      hotkey: false,
      pip: false,
      screenshot: false,
      setting: false,
      loop: false,
      flip: false,
      playbackRate: false,
      aspectRatio: false,
      // 禁用 ArtPlayer 原生全屏和控制栏；由自定义控制栏接管
      fullscreen: false,
      fullscreenWeb: false,
      subtitleOffset: false,
      miniProgressBar: false,
      airplay: false,
      mutex: true,
      backdrop: true,
      playsInline: true,
      moreVideoAttr: {
        playsInline: true,
      },
      // 禁用 ArtPlayer 原生控制栏
      controls: [],
    } as Option)
    // 空 url 初始化会让 ArtPlayer 一直显示 loading，延迟隐藏
    const hideLoadingTimer = setTimeout(() => {
      art.loading.show = false
    }, 100)

    const video = art.video
    video.muted = mutedRef.current
    videoRef.current = video

    // ── video 事件监听：同步播放/静音状态到自定义控制栏 ──────
    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleVolumeChange = () => setIsMuted(video.muted)
    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('volumechange', handleVolumeChange)

    // ── 阻止点击视频画面暂停/播放：由控制栏按钮控制 ──────────
    // ArtPlayer 的 click:false 可能不完全阻止点击暂停，
    // 在 capture 阶段拦截 click/dblclick 确保 video 点击不触发任何操作
    const blockVideoClick = (e: Event) => {
      if (e.target === video) {
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    }
    video.addEventListener('click', blockVideoClick, true)
    video.addEventListener('dblclick', blockVideoClick, true)

    // ── 源挂载：走统一引擎路由（selectEngine → flv-engine isLive）──
    // 事件经 ref 转发，引擎闭包持有的回调稳定不随渲染变化。
    const runtimeEvents: FlvRuntimeEvents = {
      onRetrying: (attempt, max) => {
        console.log(`[FlvPlayer] retrying ${attempt}/${max}`)
        setStreamStatus('connecting')
        onStatusChangeRef.current?.('connecting')
      },
      onReady: () => {
        setLoading(false)
        setErrorMsg(null)
        setStreamStatus('playing')
        onStatusChangeRef.current?.('playing')
      },
      onExhausted: (message) => {
        console.error('[FlvPlayer] exhausted:', message)
        const err = new Error(message)
        setErrorMsg(message)
        onErrorRef.current?.(err)
        setStreamStatus('error')
        onStatusChangeRef.current?.('error')
      },
      onStreamEnd: () => {
        setStreamStatus('stopped')
        onStatusChangeRef.current?.('stopped')
      },
      onStatistics: (info) => {
        const now = performance.now()
        let fps = 0
        if (lastStatsTimeRef.current > 0) {
          const dt = (now - lastStatsTimeRef.current) / 1000
          const frameDelta = info.decodedFrames - lastDecodedFramesRef.current
          if (dt > 0 && frameDelta >= 0) {
            fps = Math.round(frameDelta / dt)
          }
        }
        lastStatsTimeRef.current = now
        lastDecodedFramesRef.current = info.decodedFrames

        onStatisticsRef.current?.({
          speed: Math.round(info.speed),
          totalDataRate: Math.round(info.speed * 8),
          fps,
          decodedFrames: info.decodedFrames,
          droppedFrames: info.droppedFrames,
        })
      },
    }

    const source: PlayerSource = {
      url: src,
      format: 'flv',
      isLive: true,
      flvRuntimeEvents: runtimeEvents,
    }

    void attachSource(video, source)
      .then(() => {
        // metadata 就绪：关闭 loading（部分流 MEDIA_INFO 早于 resolve 已触发）
        setLoading(false)
        setErrorMsg(null)
        setStreamStatus('playing')
        onStatusChangeRef.current?.('playing')

        // 自动播放（静音重试处理浏览器自动播放策略）
        if (autoPlayRef.current) {
          const tryPlay = async () => {
            try {
              const ret = video.play()
              if (ret && typeof ret.catch === 'function') {
                await ret.catch(async (err: Error) => {
                  console.warn('[FlvPlayer] autoplay failed:', err)
                  if (!video.muted) {
                    video.muted = true
                    try {
                      await video.play()
                      console.log('[FlvPlayer] muted autoplay succeeded')
                    } catch (mutedErr) {
                      console.warn(
                        '[FlvPlayer] muted autoplay failed:',
                        mutedErr
                      )
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
      })
      .catch((err: unknown) => {
        // attach 失败（waitForMetadata 30s 超时 / flv.js 不可用等）
        const message = err instanceof Error ? err.message : '直播流连接失败'
        console.error('[FlvPlayer] attach failed:', err)
        setErrorMsg(message)
        onErrorRef.current?.(err instanceof Error ? err : new Error(message))
        setStreamStatus('error')
        onStatusChangeRef.current?.('error')
      })

    // 卡死自动恢复：当视频暂停但 buffered 有数据时，向前跳过一小段恢复播放
    const handleWaiting = () => {
      if (video.readyState < 3) {
        const buffered = video.buffered
        if (buffered.length > 0) {
          const bufferedEnd = buffered.end(buffered.length - 1)
          if (bufferedEnd - video.currentTime > 0.5) {
            video.currentTime = bufferedEnd - 0.3
            console.log(
              '[FlvPlayer] recovered from stall, seek to',
              video.currentTime
            )
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
            console.log(
              '[FlvPlayer] recovered from stall (timer), seek to',
              video.currentTime
            )
          }
        }
      }
    }, 3000)

    return () => {
      video.removeEventListener('waiting', handleWaiting)
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('volumechange', handleVolumeChange)
      video.removeEventListener('click', blockVideoClick, true)
      video.removeEventListener('dblclick', blockVideoClick, true)
      videoRef.current = null
      clearInterval(stallCheckTimer)
      clearTimeout(hideLoadingTimer)
      cleanup()
      try {
        art.destroy(false)
      } catch (err) {
        console.warn('[FlvPlayer] art destroy error:', err)
      }
    }
  }, [src, reloadVersion, attachSource, cleanup])

  // ── 全屏状态跟踪 ──────────────────────────────────────
  useEffect(() => {
    const dispose = onFullscreenChange(() => {
      setIsFullscreen(Boolean(getFullscreenElement()))
    })
    return dispose
  }, [])

  // ── 控制栏操作 ─────────────────────────────────────────
  const handleTogglePlayPause = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [])

  const handleToggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
  }, [])

  const handleFullscreen = useCallback(() => {
    // iOS 不支持容器全屏，降级为网页全屏（CSS 模拟全屏，保留控制栏等 UI）
    if (isIOSDevice() || !supportsContainerFullscreen()) {
      onToggleWebFullscreen?.()
      return
    }
    const stage = stageRef.current
    if (!stage) return
    if (getFullscreenElement()) {
      void exitFullscreen()
    } else {
      void requestFullscreen(stage).catch(() => {
        onToggleWebFullscreen?.()
      })
    }
  }, [onToggleWebFullscreen])

  const handleRefresh = useCallback(() => {
    setReloadVersion((v) => v + 1)
  }, [])

  return (
    <div
      ref={stageRef}
      className={cn(
        'zart-stage group',
        isWebFullscreen && 'zart-web-fullscreen fixed inset-0 z-[100]',
        className
      )}
      style={
        isWebFullscreen ? { width: '100dvw', height: '100dvh' } : undefined
      }
    >
      <div ref={containerRef} className="h-full w-full" />

      {loading && !errorMsg && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <Spinner tip="正在连接直播流..." size={32} />
        </div>
      )}
      {errorMsg && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
          <div className="text-base font-medium text-[var(--md-sys-color-error)]">
            {errorMsg}
          </div>
          <div className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
            请检查网络连接或房主推流状态
          </div>
          <button
            type="button"
            className="mt-1 rounded-lg border border-white/20 px-4 py-1.5 text-sm text-white transition-colors hover:bg-white/10"
            onClick={handleRefresh}
          >
            重新连接
          </button>
        </div>
      )}

      {/* 自定义玻璃拟态控制栏（与 WebRTC 控制栏风格一致） */}
      {!loading && !errorMsg && (
        <div
          className={cn(
            'vc-container absolute bottom-0 left-0 right-0 z-20 p-2',
            !controlBarVisible && 'pointer-events-none'
          )}
        >
          <div
            className={cn(
              'glass-strong rounded-xl px-2.5 py-2 shadow-lg',
              controlBarVisible
                ? 'zart-controlbar-enter'
                : 'zart-controlbar-exit'
            )}
          >
            <div className="flex flex-wrap items-center vc-gap">
              <IconButton
                icon={isPlaying ? <Pause /> : <Play />}
                label={isPlaying ? '暂停' : '播放'}
                onClick={handleTogglePlayPause}
              />
              <IconButton
                icon={isMuted ? <VolumeX /> : <Volume2 />}
                label={isMuted ? '取消静音' : '静音'}
                onClick={handleToggleMute}
              />
              <IconButton
                icon={isWebFullscreen ? <Minimize /> : <Maximize />}
                label={isWebFullscreen ? '退出网页全屏' : '网页全屏'}
                onClick={onToggleWebFullscreen}
              />
              <IconButton
                icon={isFullscreen ? <Minimize2 /> : <Maximize2 />}
                label={isFullscreen ? '退出全屏' : '全屏'}
                onClick={handleFullscreen}
              />
              <IconButton
                icon={<RefreshCw />}
                label="刷新连接"
                onClick={handleRefresh}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Tag
                color={
                  streamStatus === 'playing'
                    ? 'success'
                    : streamStatus === 'error'
                      ? 'danger'
                      : 'primary'
                }
              >
                {streamStatus === 'playing'
                  ? '直播中'
                  : streamStatus === 'error'
                    ? '连接失败'
                    : streamStatus === 'stopped'
                      ? '已停止'
                      : '连接中'}
              </Tag>
              <Tag color="primary">OBS 推流</Tag>
              {isMuted ? (
                <Tag color="default">静音中</Tag>
              ) : (
                <Tag color="cyan">音频开启</Tag>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
