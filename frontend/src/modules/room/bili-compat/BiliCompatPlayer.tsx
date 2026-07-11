import { useEffect, useRef, useState, useCallback } from 'react'
import { AlertCircle } from 'lucide-react'

import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import {
  BILI_PLAYER_ORIGIN,
  playIframe,
  pauseIframe,
  seekIframe,
  getIframeState,
  setDanmakuEnabled,
  extractBiliState,
  type BiliIframeState,
} from './biliIframeApi'

interface BiliCompatPlayerProps {
  bvid: string
  roomId: string
  isHost: boolean
  danmakuEnabled?: boolean
}

type LoadState = 'loading' | 'ready' | 'error'

// 服务端 -> 观众：状态广播
interface ServerStatePayload {
  currentTime: number
  paused: boolean
  url: string
  bvid: string
  lastUpdate: number
}

// 服务端 -> 观众：动作广播
interface ServerActionPayload {
  action: 'seek' | 'pause' | 'play'
  currentTime?: number
}

// 服务端 -> 观众：强制对齐
interface ServerSeekPayload {
  currentTime: number
  paused: boolean
}

// 主机检测 seek 的最小时间差（秒），小于该差值视为正常播放进度
const SEEK_DETECT_THRESHOLD = 2
// 观众执行同步动作后抑制本地上报的时间（毫秒），防止回环
const SUPPRESS_REPORT_MS = 500

export function BiliCompatPlayer({
  bvid,
  roomId,
  isHost,
  danmakuEnabled = true,
}: BiliCompatPlayerProps) {
  const { socket } = useSocket()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState('')

  // 防回环：执行同步动作时临时禁用本地上报
  const suppressReportRef = useRef(false)
  // 房主已知的最新 iframe 状态，用于检测 play/pause/seek 变化
  const lastHostStateRef = useRef<BiliIframeState | null>(null)

  const src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(
    bvid
  )}&high_quality=1&danmaku=1&autoplay=0`

  const showOpUnavailable = useCallback(() => {
    message.warning('该操作在 B站兼容模式下不可用')
  }, [])

  const handleLoad = useCallback(() => {
    setLoadState('ready')
  }, [])

  const handleError = useCallback(() => {
    setLoadState('error')
    setErrorMsg('B站播放器加载失败，请检查网络或 BVID 是否正确')
  }, [])

  // bvid 切换时重置加载状态，等待新 iframe 加载完成
  useEffect(() => {
    setLoadState('loading')
  }, [bvid])

  // ============ 房主端逻辑 ============
  useEffect(() => {
    if (!isHost || !socket) return

    let cancelled = false

    // 监听 B站 iframe 主动上报的状态消息，即时检测 play/pause/seek
    const handleMessage = (event: MessageEvent) => {
      if (cancelled) return
      if (event.origin !== BILI_PLAYER_ORIGIN) return
      if (suppressReportRef.current) return

      const extracted = extractBiliState(event.data)
      if (!extracted) return

      const incoming: BiliIframeState = {
        currentTime:
          typeof extracted.currentTime === 'number'
            ? extracted.currentTime
            : (lastHostStateRef.current?.currentTime ?? 0),
        paused:
          typeof extracted.paused === 'boolean'
            ? extracted.paused
            : (lastHostStateRef.current?.paused ?? false),
        duration:
          typeof extracted.duration === 'number'
            ? extracted.duration
            : lastHostStateRef.current?.duration,
      }

      const prev = lastHostStateRef.current
      lastHostStateRef.current = incoming

      if (!prev) return

      // 检测 paused 变化 -> play/pause 动作
      if (prev.paused !== incoming.paused) {
        socket.emit('bili-compat-host-action', {
          roomId,
          action: incoming.paused ? 'pause' : 'play',
          currentTime: incoming.currentTime,
        })
        return
      }

      // 检测 seek（currentTime 跳变超过阈值）
      if (
        Math.abs(incoming.currentTime - prev.currentTime) >
        SEEK_DETECT_THRESHOLD
      ) {
        socket.emit('bili-compat-host-action', {
          roomId,
          action: 'seek',
          currentTime: incoming.currentTime,
        })
      }
    }

    window.addEventListener('message', handleMessage)

    // 5 秒定时器：拉取状态并广播给观众
    const timer = window.setInterval(() => {
      if (cancelled || suppressReportRef.current) return

      void getIframeState(iframeRef.current)
        .then((state) => {
          if (cancelled) return

          const prev = lastHostStateRef.current
          lastHostStateRef.current = state

          // 在轮询中也检测变化（防止 message 事件丢失）
          if (prev) {
            if (prev.paused !== state.paused) {
              socket.emit('bili-compat-host-action', {
                roomId,
                action: state.paused ? 'pause' : 'play',
                currentTime: state.currentTime,
              })
            } else if (
              Math.abs(state.currentTime - prev.currentTime) >
              SEEK_DETECT_THRESHOLD
            ) {
              socket.emit('bili-compat-host-action', {
                roomId,
                action: 'seek',
                currentTime: state.currentTime,
              })
            }
          }

          socket.emit('bili-compat-host-state', {
            roomId,
            currentTime: state.currentTime,
            paused: state.paused,
            url: src,
            bvid,
          })
        })
        .catch((err: unknown) => {
          // 静默处理轮询失败，避免每 5s 弹 toast 干扰用户
          console.warn('[BiliCompat] host state poll failed:', err)
        })
    }, 5000)

    return () => {
      cancelled = true
      window.removeEventListener('message', handleMessage)
      window.clearInterval(timer)
    }
  }, [isHost, socket, roomId, bvid, src])

  // ============ 观众端逻辑 ============
  useEffect(() => {
    if (isHost || !socket) return

    let cancelled = false

    // 挂载时发送加入请求
    socket.emit('bili-compat-join', { roomId })

    const resetSuppress = () => {
      window.setTimeout(() => {
        suppressReportRef.current = false
      }, SUPPRESS_REPORT_MS)
    }

    // 初始化或状态同步：设置 iframe 状态（seek + play/pause）
    const applyState = (payload: ServerStatePayload) => {
      if (cancelled) return
      // 仅同步相同 bvid 的状态
      if (payload.bvid && payload.bvid !== bvid) return

      suppressReportRef.current = true
      try {
        const seekOk = seekIframe(iframeRef.current, payload.currentTime)
        const playPauseOk = payload.paused
          ? pauseIframe(iframeRef.current)
          : playIframe(iframeRef.current)

        if (!seekOk || !playPauseOk) {
          showOpUnavailable()
        }
      } finally {
        resetSuppress()
      }
    }

    // 动作广播：执行对应动作
    const applyAction = (payload: ServerActionPayload) => {
      if (cancelled) return

      suppressReportRef.current = true
      let ok = true
      try {
        switch (payload.action) {
          case 'play':
            ok = playIframe(iframeRef.current)
            break
          case 'pause':
            ok = pauseIframe(iframeRef.current)
            break
          case 'seek':
            if (typeof payload.currentTime === 'number') {
              ok = seekIframe(iframeRef.current, payload.currentTime)
            }
            break
        }
        if (!ok) showOpUnavailable()
      } finally {
        resetSuppress()
      }
    }

    // 强制对齐：seek + play/pause
    const applySeek = (payload: ServerSeekPayload) => {
      if (cancelled) return

      suppressReportRef.current = true
      try {
        const seekOk = seekIframe(iframeRef.current, payload.currentTime)
        const playPauseOk = payload.paused
          ? pauseIframe(iframeRef.current)
          : playIframe(iframeRef.current)

        if (!seekOk || !playPauseOk) {
          showOpUnavailable()
        }
      } finally {
        resetSuppress()
      }
    }

    socket.on('bili-compat-state', applyState)
    socket.on('bili-compat-action', applyAction)
    socket.on('bili-compat-seek', applySeek)

    return () => {
      cancelled = true
      socket.off('bili-compat-state', applyState)
      socket.off('bili-compat-action', applyAction)
      socket.off('bili-compat-seek', applySeek)
    }
  }, [isHost, socket, roomId, bvid, showOpUnavailable])

  // ============ 弹幕开关 ============
  useEffect(() => {
    if (loadState !== 'ready') return
    const ok = setDanmakuEnabled(iframeRef.current, danmakuEnabled)
    if (!ok) {
      console.warn('[BiliCompat] setDanmakuEnabled failed')
    }
  }, [danmakuEnabled, loadState])

  return (
    <div className="relative h-full w-full bg-black">
      <iframe
        ref={iframeRef}
        src={src}
        title="B站兼容模式播放器"
        className="absolute inset-0 h-full w-full border-0"
        allow="fullscreen"
        onLoad={handleLoad}
        onError={handleError}
      />

      {loadState === 'loading' && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-4"
          style={{ backgroundColor: 'var(--md-sys-color-surface)' }}
        >
          <div className="flex w-full max-w-md flex-col gap-3 px-8">
            <div
              className="h-8 w-3/4 animate-pulse rounded"
              style={{
                backgroundColor:
                  'var(--md-sys-color-surface-container-high)',
              }}
            />
            <div
              className="aspect-video w-full animate-pulse rounded"
              style={{
                backgroundColor:
                  'var(--md-sys-color-surface-container-high)',
              }}
            />
            <div className="flex gap-2">
              <div
                className="h-8 w-20 animate-pulse rounded"
                style={{
                  backgroundColor:
                    'var(--md-sys-color-surface-container-high)',
                }}
              />
              <div
                className="h-8 w-20 animate-pulse rounded"
                style={{
                  backgroundColor:
                    'var(--md-sys-color-surface-container-high)',
                }}
              />
            </div>
          </div>
          <Text type="secondary" className="text-sm">
            正在加载 B站播放器...
          </Text>
        </div>
      )}

      {loadState === 'error' && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3"
          style={{ backgroundColor: 'var(--md-sys-color-surface)' }}
        >
          <div
            className="flex h-16 w-16 items-center justify-center rounded-full"
            style={{
              backgroundColor: 'var(--md-sys-color-error-container)',
              color: 'var(--md-sys-color-on-error-container)',
            }}
          >
            <AlertCircle className="h-8 w-8" />
          </div>
          <Text type="danger" className="text-base font-medium">
            {errorMsg}
          </Text>
          <Text type="secondary" className="text-sm">
            BVID: {bvid}
          </Text>
        </div>
      )}
    </div>
  )
}
