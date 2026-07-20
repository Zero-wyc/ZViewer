import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Monitor } from 'lucide-react'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { Spinner } from '@/components/ui/Spinner'
import { useSocket } from '@/hooks/useSocket'
import { useSubtitles } from '@/hooks/useSubtitles'
import { useRoomStore } from '@/store/roomStore'
import { useDanmakuStore } from '@/store/danmakuStore'
import {
  DanmakuLayer,
  type DanmakuLayerHandle,
} from '@/components/DanmakuLayer'
import {
  VideoControls,
  type VideoControlsHandle,
} from '@/components/VideoPlayer/VideoControls'
import { VideoStatsMenu } from '@/components/VideoStatsMenu'
import { useWatchTogether } from './useWatchTogether'
import { fetchBilibiliDanmaku, type BilibiliDanmakuItem } from './danmakuEngine'
import {
  RequestNotification,
  type RequestNotificationItem,
} from '@/components/ui/RequestNotification'
import { cn } from '@/lib/utils'
import type { MediaFormat } from '@/lib/mediaFormat'

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

interface WatchTogetherPanelProps {
  roomId: string
  isHost: boolean
  /**
   * 受控的网页全屏状态。提供时组件将使用外部状态替代内部 state。
   */
  isWebFullscreen?: boolean
  /**
   * 受控的网页全屏切换回调。提供时组件将调用外部回调替代内部 state 切换。
   */
  onToggleWebFullscreen?: () => void
  /**
   * 房主刷新/重连恢复时由后端返回的最近一次播放状态。
   * 提供时，视频源加载完成后会将 currentTime 设置为此值并强制暂停。
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

export function WatchTogetherPanel({
  roomId,
  isHost,
  isWebFullscreen: controlledWebFullscreen,
  onToggleWebFullscreen: controlledToggleWebFullscreen,
  initialPlayback,
}: WatchTogetherPanelProps) {
  const { socket } = useSocket()
  const setMode = useRoomStore((state) => state.setMode)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const {
    watchTogether,
    setWatchTogether,
    forceSync,
    isResolving,
    resolvingMessage,
    currentQuality,
    availableQualities,
  } = useWatchTogether({
    roomId,
    isHost,
    videoRef,
    initialPlayback,
  })

  // 字幕状态：房主操作广播同步，观众监听应用
  const subtitles = useSubtitles({ roomId, isHost })

  // 房主端：观众加入请求（null 表示无待处理请求）
  // 改为右下角 RequestNotification 卡片展示，不再用居中 ConfirmModal 遮挡视频
  const [confirmJoin, setConfirmJoin] = useState<{
    viewerSocketId: string
  } | null>(null)

  // 房主端：观众申请跳转进度（null 表示无待处理请求）
  const [seekRequest, setSeekRequest] = useState<{
    viewerSocketId: string
    viewerUsername?: string
    time: number
  } | null>(null)

  // 房主端：观众申请暂停（null 表示无待处理请求）
  const [pauseRequest, setPauseRequest] = useState<{
    viewerSocketId: string
    viewerUsername?: string
  } | null>(null)

  // 观众端：拖动进度条申请跳转时显示「等待房主确认」提示，避免重复申请
  const [seekPending, setSeekPending] = useState(false)

  // 观众端：申请暂停时显示「等待房主确认」提示，避免重复申请
  const [pausePending, setPausePending] = useState(false)

  // 房主端：「自动通过申请」开关。开启后所有 seek/pause 申请自动通过，无需手动确认。
  // 使用 latest ref pattern 让 socket handler 始终读到最新值。
  const [autoApproveRequests, setAutoApproveRequests] = useState(false)
  const autoApproveRef = useRef(autoApproveRequests)
  useEffect(() => {
    autoApproveRef.current = autoApproveRequests
  }, [autoApproveRequests])

  const videoContainerRef = useRef<HTMLDivElement | null>(null)
  const videoControlsRef = useRef<VideoControlsHandle | null>(null)
  const danmakuLayerRef = useRef<DanmakuLayerHandle | null>(null)
  // 缓存已加载的 B站 弹幕，用于弹幕开关重新开启时重新加载
  const danmakuItemsRef = useRef<BilibiliDanmakuItem[]>([])
  const loadedTracksRef = useRef<Set<string>>(new Set())
  const [danmakuEnabled, setDanmakuEnabled] = useState(true)
  const [internalWebFullscreen, setInternalWebFullscreen] = useState(false)
  const isWebFullscreen = controlledWebFullscreen ?? internalWebFullscreen
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(
    null
  )
  // seek 过渡动画状态：仅在「显著跳转」（> 2s）时触发淡出淡入，
  // 忽略 drift correction 等小幅 currentTime 调整避免频繁闪烁。
  const [isSeeking, setIsSeeking] = useState(false)
  const lastTimeRef = useRef(0)

  // Bug #10 修复：使用 useCallback 锁定 ref callback 引用，
  // 避免每次渲染都创建新函数导致 React 在 commit 阶段先调用旧 callback(null)、
  // 再调用新 callback(node)，期间 videoRef.current 短暂为 null，socket 事件被吞。
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node
    setVideoElement(node)
  }, [])

  const toggleWebFullscreen = useCallback(() => {
    if (controlledToggleWebFullscreen) {
      controlledToggleWebFullscreen()
    } else {
      setInternalWebFullscreen((prev) => !prev)
    }
  }, [controlledToggleWebFullscreen])

  const exitWebFullscreen = useCallback(() => {
    if (controlledWebFullscreen) {
      controlledToggleWebFullscreen?.()
    } else {
      setInternalWebFullscreen(false)
    }
  }, [controlledWebFullscreen, controlledToggleWebFullscreen])

  // 网页全屏模式下按 ESC 退出
  useEffect(() => {
    if (!isWebFullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exitWebFullscreen()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isWebFullscreen, exitWebFullscreen])

  // seek 过渡动画：监听 video 元素的 seeking/seeked 事件，
  // 仅在显著跳转（> 2s）时触发淡出淡入，忽略 drift correction 等小幅调整。
  // - seeking：currentTime 变化时触发，检查与上次记录的差距
  // - seeked：seek 完成后触发，恢复 opacity 并更新 lastTimeRef
  // - timeupdate：持续更新 lastTimeRef 供下次 seeking 比较
  useEffect(() => {
    if (!videoElement) return
    const SEEK_ANIMATION_THRESHOLD = 2 // 秒，小于此差距不触发动画

    const onTimeUpdate = () => {
      lastTimeRef.current = videoElement.currentTime
    }
    const onSeeking = () => {
      const delta = Math.abs(videoElement.currentTime - lastTimeRef.current)
      if (delta >= SEEK_ANIMATION_THRESHOLD) {
        setIsSeeking(true)
      }
    }
    const onSeeked = () => {
      setIsSeeking(false)
      lastTimeRef.current = videoElement.currentTime
    }

    videoElement.addEventListener('timeupdate', onTimeUpdate)
    videoElement.addEventListener('seeking', onSeeking)
    videoElement.addEventListener('seeked', onSeeked)
    return () => {
      videoElement.removeEventListener('timeupdate', onTimeUpdate)
      videoElement.removeEventListener('seeking', onSeeking)
      videoElement.removeEventListener('seeked', onSeeked)
    }
  }, [videoElement])

  const tracks = useDanmakuStore((state) => state.tracks)
  const style = useDanmakuStore((state) => state.style)
  const setDefaultTrack = useDanmakuStore((state) => state.setDefaultTrack)
  const setStyle = useDanmakuStore((state) => state.setStyle)
  const setFilters = useDanmakuStore((state) => state.setFilters)
  const setAdvancedStyle = useDanmakuStore((state) => state.setAdvancedStyle)
  const resetStyle = useDanmakuStore((state) => state.resetStyle)

  // 加载 B站 官方弹幕：缓存后通过 DanmakuLayer 时间轴弹幕接口加载
  useEffect(() => {
    const cid = watchTogether.cid
    if (!cid || watchTogether.sourceType !== 'bilibili') {
      danmakuItemsRef.current = []
      setDefaultTrack([])
      danmakuLayerRef.current?.loadDanmakuTrack('default', [])
      danmakuLayerRef.current?.clear()
      return
    }
    fetchBilibiliDanmaku(cid)
      .then((items) => {
        // 缓存 items，用于弹幕开关重新开启时重新加载
        danmakuItemsRef.current = items
        setDefaultTrack(items)
        danmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
        const video = videoRef.current
        if (video) {
          danmakuLayerRef.current?.seek(video.currentTime)
        }
      })
      .catch((err) => {
        console.error('[WatchTogether] load danmaku error:', err)
      })
  }, [watchTogether.cid, watchTogether.sourceType, setDefaultTrack])

  // 弹幕开关重新开启时，重新加载当前时间轴弹幕并 seek 到当前时间
  useEffect(() => {
    if (!danmakuEnabled) return
    const items = danmakuItemsRef.current
    if (items.length > 0) {
      danmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
      const video = videoRef.current
      if (video) {
        danmakuLayerRef.current?.seek(video.currentTime)
      }
    }
  }, [danmakuEnabled])

  // 同步 store 中的轨道变化到弹幕引擎
  useEffect(() => {
    const layer = danmakuLayerRef.current
    if (!layer) return
    const current = new Set<string>()
    tracks.forEach((track) => {
      layer.loadDanmakuTrack(track.trackId, track.items, track.offset)
      current.add(track.trackId)
    })
    loadedTracksRef.current.forEach((id) => {
      if (!current.has(id)) {
        layer.removeDanmakuTrack(id)
      }
    })
    loadedTracksRef.current = current
  }, [tracks])

  // 视频加载后更新总时长
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleLoadedMetadata = () => {
      if (video.duration && isFinite(video.duration)) {
        setWatchTogether({ duration: video.duration })
      }
    }

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
    }
  }, [setWatchTogether])

  // 房主刷新/重连恢复逻辑已移至 useWatchTogether.loadMovie 内部：
  // 当 initialPlayback.currentMovieId 与正在加载的影片 ID 匹配时，
  // 加载完成后会 seek 到 initialPlayback.currentTime 并强制暂停。
  // 通过 currentMovieId 匹配（而非 sourceUrl），避免 B站 URL 每次解析变化导致匹配失败。

  // 应用字幕状态到 video 的 textTracks：
  // - 关闭字幕：所有轨道 mode = 'disabled'（track 被禁用并隐藏）
  // - 开启字幕：激活轨道 mode = 'showing'，其余 'disabled'
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const tracks = video.textTracks
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (!subtitles.subtitleEnabled) {
        track.mode = 'disabled'
      } else if (i === subtitles.activeTrackIndex) {
        track.mode = 'showing'
      } else {
        track.mode = 'disabled'
      }
    }
  }, [
    subtitles.subtitleEnabled,
    subtitles.activeTrackIndex,
    subtitles.subtitleTracks,
    videoElement,
  ])

  // 房主：处理观众加入请求
  useEffect(() => {
    if (!socket || !isHost) return

    const handleJoinRequest = (data: { viewerSocketId: string }) => {
      setConfirmJoin({ viewerSocketId: data.viewerSocketId })
    }

    socket.on('join-request', handleJoinRequest)
    return () => {
      socket.off('join-request', handleJoinRequest)
    }
  }, [socket, isHost])

  // 房主：处理观众申请跳转进度
  useEffect(() => {
    if (!socket || !isHost) return

    const handleSeekRequest = (data: {
      viewerSocketId: string
      viewerUsername?: string
      time: number
    }) => {
      if (!data?.viewerSocketId) return
      // 自动通过开关开启时，直接执行同意逻辑，不弹确认框
      if (autoApproveRef.current) {
        const video = videoRef.current
        if (video && Number.isFinite(data.time)) {
          video.currentTime = data.time
        }
        socket.emit(
          'seek-response',
          {
            roomId,
            viewerSocketId: data.viewerSocketId,
            accept: true,
            time: data.time,
          },
          () => {
            /* ack */
          }
        )
        return
      }
      setSeekRequest({
        viewerSocketId: data.viewerSocketId,
        viewerUsername: data.viewerUsername,
        time: data.time,
      })
    }

    socket.on('seek-request', handleSeekRequest)
    return () => {
      socket.off('seek-request', handleSeekRequest)
    }
  }, [socket, isHost, roomId])

  // 房主：处理观众申请暂停
  useEffect(() => {
    if (!socket || !isHost) return

    const handlePauseRequest = (data: {
      viewerSocketId: string
      viewerUsername?: string
    }) => {
      if (!data?.viewerSocketId) return
      // 自动通过开关开启时，直接执行同意逻辑，不弹确认框
      if (autoApproveRef.current) {
        const video = videoRef.current
        if (video) {
          video.pause()
        }
        socket.emit(
          'pause-response',
          {
            roomId,
            viewerSocketId: data.viewerSocketId,
            accept: true,
          },
          () => {
            /* ack */
          }
        )
        return
      }
      setPauseRequest({
        viewerSocketId: data.viewerSocketId,
        viewerUsername: data.viewerUsername,
      })
    }

    socket.on('pause-request', handlePauseRequest)
    return () => {
      socket.off('pause-request', handlePauseRequest)
    }
  }, [socket, isHost, roomId])

  // 观众：监听房主对 seek 申请的回应
  useEffect(() => {
    if (!socket || isHost) return

    const handleSeekResponse = (data: { accept: boolean; time?: number }) => {
      setSeekPending(false)
      if (data?.accept) {
        message.success(`房主已同意跳转到 ${formatSeekTime(data.time ?? 0)}`)
        // 实际 seek 由房主广播的 watch-together-state/control 同步执行
      } else {
        message.info('房主拒绝了您的跳转申请')
      }
    }

    socket.on('seek-response', handleSeekResponse)
    return () => {
      socket.off('seek-response', handleSeekResponse)
    }
  }, [socket, isHost])

  // 观众：监听房主对 pause 申请的回应
  useEffect(() => {
    if (!socket || isHost) return

    const handlePauseResponse = (data: { accept: boolean }) => {
      setPausePending(false)
      if (data?.accept) {
        message.success('房主已同意暂停')
        // 实际 pause 由房主广播的 watch-together-state/control 同步执行
      } else {
        message.info('房主拒绝了您的暂停申请')
      }
    }

    socket.on('pause-response', handlePauseResponse)
    return () => {
      socket.off('pause-response', handlePauseResponse)
    }
  }, [socket, isHost])

  // 所有用户：监听房间模式切换
  useEffect(() => {
    if (!socket) return

    const handleRoomModeChanged = (data: {
      mode: 'screen-share' | 'watch-together'
    }) => {
      setMode(data.mode)
    }

    socket.on('room-mode-changed', handleRoomModeChanged)
    return () => {
      socket.off('room-mode-changed', handleRoomModeChanged)
    }
  }, [socket, setMode])

  const handleApproveJoin = () => {
    if (!confirmJoin) return
    const viewerSocketId = confirmJoin.viewerSocketId
    if (!socket || !viewerSocketId) return
    socket.emit(
      'approve-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.success('已允许加入')
        } else {
          message.error(response.message || '操作失败')
        }
      }
    )
    setConfirmJoin(null)
  }

  const handleRejectJoin = () => {
    if (!confirmJoin) return
    const viewerSocketId = confirmJoin.viewerSocketId
    if (!socket || !viewerSocketId) return
    socket.emit(
      'reject-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.info('已拒绝加入')
        } else {
          message.error(response.message || '操作失败')
        }
      }
    )
    setConfirmJoin(null)
  }

  // 房主：同意观众的跳转申请 —— 本地 seek 后由 useSyncPlayback 广播 state 同步给所有观众
  const handleAcceptSeek = () => {
    if (!seekRequest) return
    const { viewerSocketId, time } = seekRequest
    if (!socket || !viewerSocketId) return
    const video = videoRef.current
    if (video && Number.isFinite(time)) {
      video.currentTime = time
    }
    // 通知申请者结果（房主端已经通过 watch-together-state 同步 seek）
    socket.emit(
      'seek-response',
      { roomId, viewerSocketId, accept: true, time },
      () => {
        /* 回应仅用于 ack，无需提示 */
      }
    )
    setSeekRequest(null)
  }

  // 房主：拒绝观众的跳转申请
  const handleRejectSeek = () => {
    if (!seekRequest) return
    const { viewerSocketId } = seekRequest
    if (!socket || !viewerSocketId) return
    socket.emit(
      'seek-response',
      { roomId, viewerSocketId, accept: false },
      () => {
        /* 回应仅用于 ack */
      }
    )
    setSeekRequest(null)
  }

  // 房主：同意观众的暂停申请 —— 本地 pause 后由 useSyncPlayback 广播 state 同步给所有观众
  const handleAcceptPause = () => {
    if (!pauseRequest) return
    const { viewerSocketId } = pauseRequest
    if (!socket || !viewerSocketId) return
    const video = videoRef.current
    if (video) {
      video.pause()
    }
    socket.emit(
      'pause-response',
      { roomId, viewerSocketId, accept: true },
      () => {
        /* 回应仅用于 ack，无需提示 */
      }
    )
    setPauseRequest(null)
  }

  // 房主：拒绝观众的暂停申请
  const handleRejectPause = () => {
    if (!pauseRequest) return
    const { viewerSocketId } = pauseRequest
    if (!socket || !viewerSocketId) return
    socket.emit(
      'pause-response',
      { roomId, viewerSocketId, accept: false },
      () => {
        /* 回应仅用于 ack */
      }
    )
    setPauseRequest(null)
  }

  // 观众：拖动进度条后向房主申请跳转
  const handleRequestSeek = useCallback(
    (time: number) => {
      if (!socket || isHost || seekPending) return
      if (!Number.isFinite(time)) return
      setSeekPending(true)
      socket.emit(
        'seek-request',
        { roomId, time },
        (response: { success: boolean; message?: string }) => {
          if (!response.success) {
            setSeekPending(false)
            message.error(response.message || '申请跳转失败')
          } else {
            message.info('已发送跳转申请，等待房主确认')
          }
        }
      )
    },
    [socket, isHost, roomId, seekPending]
  )

  // 观众：向房主申请暂停
  const handleRequestPause = useCallback(() => {
    if (!socket || isHost || pausePending) return
    setPausePending(true)
    socket.emit(
      'pause-request',
      { roomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success) {
          setPausePending(false)
          message.error(response.message || '申请暂停失败')
        } else {
          message.info('已发送暂停申请，等待房主确认')
        }
      }
    )
  }, [socket, isHost, roomId, pausePending])

  // 房主：切换「自动通过申请」开关
  const handleToggleAutoApprove = useCallback(() => {
    setAutoApproveRequests((prev) => {
      const next = !prev
      message.info(next ? '已开启自动通过申请' : '已关闭自动通过申请')
      return next
    })
  }, [])

  const handleShowControls = () => {
    videoControlsRef.current?.showControls()
  }

  const videoContainer = (
    <div
      ref={videoContainerRef}
      className={cn(
        isWebFullscreen ? 'fixed inset-0 z-[100]' : 'relative h-full w-full'
      )}
      style={
        isWebFullscreen ? { width: '100dvw', height: '100dvh' } : undefined
      }
      onMouseMove={handleShowControls}
      onMouseEnter={handleShowControls}
      onClick={handleShowControls}
    >
      <video
        ref={setVideoRef}
        className={cn(
          'h-full w-full object-contain transition-[filter,opacity] duration-200 ease-out',
          isSeeking && 'opacity-60 [filter:blur(2px)_brightness(0.85)]'
        )}
        playsInline
        preload="metadata"
      >
        {/* 字幕轨道挂载：mode 由 textTracks effect 根据 subtitleEnabled 控制 */}
        {subtitles.subtitleTracks.map((t, i) => (
          <track
            key={`${t.url}-${i}`}
            kind="subtitles"
            src={t.url}
            label={t.label}
            srcLang={t.lang || 'zh'}
          />
        ))}
      </video>

      {/* 字幕样式：使用 Monet 主题变量，字号可调、底色半透明 */}
      <style>{`
          video::cue {
            font-size: ${subtitles.subtitleFontSize}px;
            background-color: rgba(var(--md-sys-color-surface-container-rgb), var(--glass-strength));
            color: var(--md-sys-color-on-surface, #ffffff);
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
          }
        `}</style>

      {isResolving && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
          <Spinner size={32} />
          <Text className="text-sm">
            {resolvingMessage || '正在解析视频...'}
          </Text>
        </div>
      )}

      <VideoStatsMenu
        videoElement={videoElement}
        sourceType={
          watchTogether.sourceType === 'bilibili' ? 'bilibili' : 'custom'
        }
        videoCodec={watchTogether.videoCodec}
        sourceUrl={watchTogether.sourceUrl}
        currentQuality={currentQuality}
        availableQualities={availableQualities}
      />

      {!watchTogether.sourceUrl && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div className="glass-strong flex h-20 w-20 items-center justify-center rounded-full">
            <Monitor
              className="h-10 w-10 opacity-70"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            />
          </div>
          <Text className="text-sm">
            {isHost ? '请在下方添加并播放影片' : '等待房主播放影片'}
          </Text>
        </div>
      )}

      {watchTogether.sourceUrl && (
        <>
          <DanmakuLayer
            ref={danmakuLayerRef}
            socket={socket}
            videoElement={videoElement}
            enabled={danmakuEnabled}
            opacity={style.opacity}
            displayArea={style.displayArea}
            density={style.advanced.density}
            speed={style.speed}
            scaleWithScreen={style.scaleWithScreen}
            filters={style.filters}
            advancedStyle={style.advanced}
            fontSize={style.fontSize}
          />
          <div className="absolute bottom-0 left-0 right-0 z-20">
            <VideoControls
              ref={videoControlsRef}
              video={videoElement}
              containerRef={videoContainerRef}
              isHost={isHost}
              // 观众端启用只读模式：隐藏所有可操作控件，仅显示进度条与时间
              readOnly={!isHost}
              isDanmakuEnabled={danmakuEnabled}
              onToggleDanmaku={() => setDanmakuEnabled((prev) => !prev)}
              onSendDanmaku={(text) => {
                const trimmed = text.trim()
                if (!trimmed) return

                // 本地弹幕层即时显示，不依赖 socket 状态
                const item: BilibiliDanmakuItem = {
                  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  content: trimmed,
                  time: videoRef.current?.currentTime ?? 0,
                  mode: 1,
                  color: 16777215,
                  size: 25,
                }

                danmakuLayerRef.current?.addDanmaku(item)

                // socket 可用时再发送到聊天区
                if (!socket) return
                socket.emit(
                  'send-comment',
                  { roomId, content: trimmed, isDanmaku: true },
                  (response: { success: boolean; message?: string }) => {
                    if (!response.success) {
                      message.error(response.message ?? '弹幕发送失败')
                    }
                  }
                )
              }}
              onSync={() => {
                if (!isHost) return
                forceSync()
              }}
              // 观众端 readOnly 模式下拖动进度条触发申请跳转
              onRequestSeek={isHost ? undefined : handleRequestSeek}
              // 观众端 readOnly 模式下点击申请暂停
              onRequestPause={isHost ? undefined : handleRequestPause}
              // 房主端「自动通过申请」开关
              autoApproveRequests={isHost ? autoApproveRequests : undefined}
              onToggleAutoApprove={isHost ? handleToggleAutoApprove : undefined}
              isWebFullscreen={isWebFullscreen}
              onToggleWebFullscreen={toggleWebFullscreen}
              subtitleEnabled={subtitles.subtitleEnabled}
              subtitleTracks={subtitles.subtitleTracks}
              activeTrackIndex={subtitles.activeTrackIndex}
              subtitleFontSize={subtitles.subtitleFontSize}
              onToggleSubtitles={subtitles.setEnabled}
              onSelectSubtitleTrack={subtitles.setActiveTrack}
              onAddSubtitleUrl={subtitles.addTrackFromUrl}
              onAddSubtitleFile={subtitles.addTrackFromFile}
              onChangeSubtitleFontSize={subtitles.setFontSize}
              danmakuStyle={style}
              onDanmakuStyleChange={setStyle}
              onDanmakuFilterChange={setFilters}
              onDanmakuAdvancedChange={setAdvancedStyle}
              onResetDanmakuStyle={resetStyle}
            />
          </div>
        </>
      )}
    </div>
  )

  // 房主端：将 3 类申请（加入/跳转/暂停）汇总为右下角通知列表
  // 替代原居中 ConfirmModal 弹窗，不遮挡正在观看的视频内容。
  // 每条通知 12 秒后自动按「拒绝」处理，避免遗漏堆积。
  const requestNotifications: RequestNotificationItem[] = []
  if (confirmJoin) {
    requestNotifications.push({
      id: 'join',
      title: '观看请求',
      okText: '允许',
      cancelText: '拒绝',
      onOk: handleApproveJoin,
      onCancel: handleRejectJoin,
      autoCloseMs: 12000,
      content: (
        <>
          有观看者请求加入房间（
          <span style={{ color: 'var(--md-sys-color-primary)' }}>
            {confirmJoin.viewerSocketId.slice(0, 8)}
          </span>
          ），是否允许？
        </>
      ),
    })
  }
  if (seekRequest) {
    // eslint-disable-next-line react-hooks/refs -- 回调在用户点击时才执行，不在 render 中读取 ref
    requestNotifications.push({
      id: 'seek',
      title: '跳转申请',
      okText: '同意',
      cancelText: '拒绝',
      onOk: handleAcceptSeek,
      onCancel: handleRejectSeek,
      autoCloseMs: 12000,
      content: (
        <>
          观众{' '}
          <span style={{ color: 'var(--md-sys-color-primary)' }}>
            {seekRequest.viewerUsername ||
              seekRequest.viewerSocketId.slice(0, 8)}
          </span>{' '}
          申请跳转到{' '}
          <span style={{ color: 'var(--md-sys-color-primary)' }}>
            {formatSeekTime(seekRequest.time)}
          </span>
        </>
      ),
    })
  }
  if (pauseRequest) {
    // eslint-disable-next-line react-hooks/refs -- 回调在用户点击时才执行，不在 render 中读取 ref
    requestNotifications.push({
      id: 'pause',
      title: '暂停申请',
      okText: '同意',
      cancelText: '拒绝',
      onOk: handleAcceptPause,
      onCancel: handleRejectPause,
      autoCloseMs: 12000,
      content: (
        <>
          观众{' '}
          <span style={{ color: 'var(--md-sys-color-primary)' }}>
            {pauseRequest.viewerUsername ||
              pauseRequest.viewerSocketId.slice(0, 8)}
          </span>{' '}
          申请暂停播放
        </>
      ),
    })
  }

  const handleCloseNotification = (id: string) => {
    if (id === 'join') setConfirmJoin(null)
    else if (id === 'seek') setSeekRequest(null)
    else if (id === 'pause') setPauseRequest(null)
  }

  return (
    <>
      {isWebFullscreen
        ? createPortal(videoContainer, document.body)
        : videoContainer}

      <RequestNotification
        items={requestNotifications}
        onClose={handleCloseNotification}
      />
    </>
  )
}
