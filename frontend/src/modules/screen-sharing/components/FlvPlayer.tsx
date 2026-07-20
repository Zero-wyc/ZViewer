import { useEffect, useRef, useState } from 'react'
import flvjs from 'flv.js'
import { Spinner } from '@/components/ui/Spinner'

interface FlvPlayerProps {
  /** 拉流地址（HTTP-FLV），例如 http://host:8000/live/xxx.flv */
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
}: FlvPlayerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const playerRef = useRef<flvjs.Player | null>(null)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // 创建并启动 flv player
  useEffect(() => {
    if (!videoRef.current || !src) return
    if (!flvjs.isSupported()) {
      const err = new Error('当前浏览器不支持 MSE / flv.js')
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 错误处理
      setErrorMsg(err.message)
      onError?.(err)
      onStatusChange?.('error')
      return
    }

    setLoading(true)
    setErrorMsg(null)
    onStatusChange?.('connecting')

    const player = flvjs.createPlayer(
      {
        type: 'flv',
        url: src,
        isLive: true,
        cors: true,
      },
      {
        enableWorker: false,
        enableStashBuffer: false,
        stashInitialSize: 128,
      }
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
        onStatusChange?.('connecting')
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
        onError?.(err)
        onStatusChange?.('error')
      }
    })
    player.on(flvjs.Events.MEDIA_INFO, () => {
      retryCountRef.current = 0
      setLoading(false)
      setErrorMsg(null)
    })
    player.on(flvjs.Events.LOADING_COMPLETE, () => {
      // 直播流不应触发 LOADING_COMPLETE，触发说明流已结束
      console.warn('[FlvPlayer] loading complete (stream ended)')
      onStatusChange?.('stopped')
    })
    player.load()
    if (autoPlay) {
      try {
        const ret = player.play()
        if (ret && typeof ret.catch === 'function') {
          ret.catch((err) => console.warn('[FlvPlayer] autoplay failed:', err))
        }
      } catch (err) {
        console.warn('[FlvPlayer] autoplay failed:', err)
      }
    }

    playerRef.current = player
    onStatusChange?.('playing')

    return () => {
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
  }, [src, autoPlay, onError, onStatusChange])

  // 同步 muted 状态
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = muted
    }
  }, [muted])

  return (
    <div className={`relative h-full w-full ${className ?? ''}`}>
      <video
        ref={videoRef}
        autoPlay={autoPlay}
        playsInline
        muted={muted}
        className="h-full w-full object-contain"
      />
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
