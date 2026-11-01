/**
 * WebRTC 屏幕共享观众端。
 *
 * 与旧实现的区别：连接不由页面建立。观众进房只发 `share.hello`，之后由服务端
 * 下发的候选驱动建连（`ShareViewerSession`）；解出第一帧才算「接上了」，页面
 * 拿到 active 才挂画面。恢复由会话自己做（预算 2 次），耗尽后把刷新按钮交给用户。
 *
 * 页面只负责：绑定 video 元素、把会话状态映到控制栏、以及所有 UI（批注、网页
 * 全屏、画中画）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2 } from 'lucide-react'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { cn } from '@/lib/utils'
import {
  isIOSDevice,
  supportsContainerFullscreen,
} from '@/lib/fullscreen-utils'
import {
  AnnotationLayer,
  AnnotationToolbar,
  type AnnotationTool,
} from '@/components/AnnotationLayer'
import { CommentPanel } from '@/components/CommentPanel'
import { RoomLayout } from '@/modules/room/components/RoomLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { useControlBarAutoHide } from '@/hooks/useControlBarAutoHide'
import { useWakeLock } from '@/hooks/useWakeLock'
import { ICE_SERVERS } from '@/lib/iceServers'
import { useShareViewer } from '../hooks/useShareViewer'
import { viewerStatusText } from '../utils/shareMessages'
import { RemoteVideoPlayer } from './RemoteVideoPlayer'
import { WatchControlsBar } from './WatchControlsBar'
import { t } from '@/i18n'

declare global {
  interface HTMLVideoElement {
    requestPictureInPicture(): Promise<unknown>
  }
  interface Document {
    readonly pictureInPictureElement: HTMLVideoElement | null
    readonly pictureInPictureEnabled: boolean
    exitPictureInPicture(): Promise<void>
  }
}

interface WebrtcWatchPageProps {
  roomId: string
}

function WebrtcWatchPage({ roomId }: WebrtcWatchPageProps) {
  const { socket, connected } = useSocket()

  // UI state
  const [isMuted, setIsMuted] = useState(false)
  const [isPlaying, setIsPlaying] = useState(true)
  const [videoResolution, setVideoResolution] = useState<{
    width: number
    height: number
  } | null>(null)
  const [isPictureInPicture, setIsPictureInPicture] = useState(false)
  const [isPiPSupported] = useState(
    () => typeof document !== 'undefined' && document.pictureInPictureEnabled
  )
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('pen')
  const [annotationColor, setAnnotationColor] = useState('#f76f53')
  const [annotationWidth, setAnnotationWidth] = useState(3)
  const [showAnnotationToolbar, setShowAnnotationToolbar] = useState(false)
  const annotationRef = useRef<{ clear: () => void }>(null)
  const [isWebFullscreen, setIsWebFullscreen] = useState(false)

  // WebRTC 播放器舞台 ref（用于控制栏自动隐藏）
  const webrtcStageRef = useRef<HTMLDivElement | null>(null)

  // video ref（使用回调 ref 触发 videoVersion 变化：远端流可能先于元素到达，
  // 会话需要这个版本号才能在元素就位后补一次 srcObject 绑定）
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoVersion, setVideoVersion] = useState(0)
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    const prev = videoRef.current
    videoRef.current = node
    if (node && !prev) setVideoVersion((v) => v + 1)
  }, [])

  const {
    pc,
    hasRemoteStream,
    hasRemoteAudio,
    connectionState,
    state,
    sharingMode,
    retry,
  } = useShareViewer({
    socket,
    roomId,
    iceServers: ICE_SERVERS,
    videoRef,
    videoVersion,
  })

  // 恢复预算耗尽：明确告诉用户「停下来等你点刷新」，而不是无限重连。
  useEffect(() => {
    if (state.exhausted) message.warning(t('连接已断开，请点击刷新重试'))
  }, [state.exhausted])

  // 卸载时清掉画面，避免下一次进房短暂显示上一场的最后一帧。
  useEffect(() => {
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [])

  // WebRTC 控制栏自动隐藏（逻辑仿照 WatchTogetherCore）
  const webrtcControlBarVisible = useControlBarAutoHide(webrtcStageRef)

  // 防息屏：移动/平板观众正在观看共享画面时保持屏幕常亮
  // （移植自 mirotalk wakeLock；桌面设备与页面不可见时内部自动失效）
  useWakeLock(hasRemoteStream && isPlaying)

  // WebRTC 网页全屏模式下按 ESC 退出
  useEffect(() => {
    if (!isWebFullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsWebFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isWebFullscreen])

  // video 元素 resolution / PiP 监听
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleLoadedMetadata = () =>
      setVideoResolution({ width: video.videoWidth, height: video.videoHeight })
    const handleEnterPiP = () => setIsPictureInPicture(true)
    const handleLeavePiP = () => setIsPictureInPicture(false)
    const pipEnter = 'enterpictureinpicture' as keyof HTMLVideoElementEventMap
    const pipLeave = 'leavepictureinpicture' as keyof HTMLVideoElementEventMap

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener(pipEnter, handleEnterPiP)
    video.addEventListener(pipLeave, handleLeavePiP)

    const interval = setInterval(() => {
      if (video.videoWidth && video.videoHeight)
        setVideoResolution((prev) => {
          if (
            prev &&
            prev.width === video.videoWidth &&
            prev.height === video.videoHeight
          ) {
            return prev
          }
          return { width: video.videoWidth, height: video.videoHeight }
        })
    }, 1000)

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener(pipEnter, handleEnterPiP)
      video.removeEventListener(pipLeave, handleLeavePiP)
      clearInterval(interval)
    }
  }, [hasRemoteStream, videoVersion])

  // isMuted 同步到 video 元素
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = isMuted
  }, [isMuted])

  // muted 状态双向同步（issue #26）：浏览器自动播放策略拦截有声播放时，
  // 播放回退逻辑会直接改 video.muted（React 状态不知情），若不同步会出现
  // 「界面显示已开声音、实际无声」。volumechange 把任何来源的 muted 变化
  // 回写 isMuted；挂载/流到达时先主动同步一次，兜住监听器挂上前发生的静音。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handleVolumeChange = () => setIsMuted(video.muted)
    handleVolumeChange()
    video.addEventListener('volumechange', handleVolumeChange)
    return () => video.removeEventListener('volumechange', handleVolumeChange)
  }, [hasRemoteStream, videoVersion])

  // 一键开启声音：自动播放被浏览器强制静音时，画面上方悬浮提示，
  // 点击后取消静音并恢复播放（用户手势内执行，浏览器放行有声播放）
  const handleUnmute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = false
    setIsMuted(false)
    void video.play().catch(() => {})
  }, [])

  // 监听 video play/pause 事件同步 isPlaying 状态
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
    }
  }, [videoVersion])

  // 事件处理
  const handleFullscreen = () => {
    if (isIOSDevice() || !supportsContainerFullscreen()) {
      setIsWebFullscreen((prev) => !prev)
      return
    }
    const video = videoRef.current
    if (!video) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      video.requestFullscreen().catch(() => {
        setIsWebFullscreen((prev) => !prev)
      })
    }
  }

  const handleTogglePictureInPicture = async () => {
    const video = videoRef.current
    if (!video) return
    try {
      if (document.pictureInPictureElement === video)
        await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    } catch (err) {
      console.error('[WebrtcWatchPage] picture-in-picture error:', err)
      message.error(t('画中画模式不可用'))
    }
  }

  const handleToggleMute = () => setIsMuted((prev) => !prev)

  const handleTogglePlayPause = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [])

  const handleRefresh = useCallback(() => {
    retry()
  }, [retry])

  // 控制栏上的连接状态：还没接到画面时要区分「房主没共享」和「正在建连」。
  const displayConnectionState: RTCPeerConnectionState = hasRemoteStream
    ? connectionState
    : state.recovering
      ? 'disconnected'
      : state.sharing
        ? 'connecting'
        : 'new'

  const playerContent = (
    <div
      ref={webrtcStageRef}
      className={cn(
        'zart-stage relative h-full w-full',
        isWebFullscreen && 'zart-web-fullscreen fixed inset-0 z-[100]'
      )}
      style={
        isWebFullscreen ? { width: '100dvw', height: '100dvh' } : undefined
      }
    >
      <RemoteVideoPlayer
        videoRef={videoRef}
        setVideoRef={setVideoRef}
        isMuted={isMuted}
        hasRemoteStream={hasRemoteStream}
        peerConnection={pc}
        statusTip={viewerStatusText(state)}
      />
      {hasRemoteStream && hasRemoteAudio && isMuted && (
        <button
          type="button"
          onClick={handleUnmute}
          className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white shadow-lg transition-colors hover:brightness-110"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.72)' }}
        >
          <Volume2 className="h-4 w-4" />
          {t('浏览器已自动静音，点击开启声音')}
        </button>
      )}
      <AnnotationLayer
        ref={annotationRef}
        socket={socket}
        roomId={roomId}
        active={showAnnotationToolbar}
        tool={annotationTool}
        color={annotationColor}
        width={annotationWidth}
      />
      {showAnnotationToolbar && (
        <div className="absolute bottom-20 right-3 z-30 max-w-[220px]">
          <AnnotationToolbar
            tool={annotationTool}
            color={annotationColor}
            width={annotationWidth}
            onToolChange={setAnnotationTool}
            onColorChange={setAnnotationColor}
            onWidthChange={setAnnotationWidth}
            onClear={() => annotationRef.current?.clear()}
            canClear
          />
        </div>
      )}
      <WatchControlsBar
        isMuted={isMuted}
        isPlaying={isPlaying}
        hasRemoteAudio={hasRemoteAudio}
        hasRemoteStream={hasRemoteStream}
        isPictureInPicture={isPictureInPicture}
        isPiPSupported={isPiPSupported}
        showAnnotationToolbar={showAnnotationToolbar}
        connected={connected}
        connectionState={displayConnectionState}
        videoResolution={videoResolution}
        onToggleMute={handleToggleMute}
        onTogglePlayPause={handleTogglePlayPause}
        onFullscreen={handleFullscreen}
        onTogglePiP={handleTogglePictureInPicture}
        onToggleAnnotation={() => setShowAnnotationToolbar((prev) => !prev)}
        onRefresh={handleRefresh}
        controlBarVisible={webrtcControlBarVisible}
        isWebFullscreen={isWebFullscreen}
        onToggleWebFullscreen={() => setIsWebFullscreen((prev) => !prev)}
      />
    </div>
  )

  return (
    <RoomLayout
      isHost={false}
      mainContent={playerContent}
      peerConnection={pc}
      sharingRole="receiver"
      sharingMode={sharingMode}
      sharingActive
      webFullscreen={isWebFullscreen}
      rightPanel={<CommentPanel socket={socket} roomId={roomId} commentsOnly />}
      controls={<RoomInfoPanel roomId={roomId} isHost={false} />}
      controlLabels={[t('房间状态')]}
    />
  )
}

export default WebrtcWatchPage
