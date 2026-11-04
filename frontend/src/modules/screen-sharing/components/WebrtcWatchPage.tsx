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
import { usePiikShareViewer } from '@/modules/piik-share/usePiikShareViewer'
import { ViewerAudio, type ViewerAudioSnapshot } from '../core/viewer-audio'
import {
  loadViewerVolume,
  saveViewerVolume,
  VIEWER_VOLUME_MAX,
} from '../utils/mediaSettingsStorage'
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
  //
  // 静音与音量的真相都在 `ViewerAudio` 里（它同时管原生播放与增益），
  // 页面只持有它回传的快照。**不要**再从 `video.muted` 反推：增益模式下
  // 那个属性是被强置成 true 的（出声走 GainNode），拿它判断会永远显示「静音中」。
  const [audioSnapshot, setAudioSnapshot] = useState<ViewerAudioSnapshot>({
    level: 1,
    muted: false,
    boostAvailable: typeof AudioContext !== 'undefined',
  })
  const viewerAudioRef = useRef<ViewerAudio | null>(null)
  const isMuted = audioSnapshot.muted || audioSnapshot.level === 0
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
    remoteStream,
    hasRemoteStream,
    hasRemoteAudio,
    connectionState,
    state,
    sharingMode,
    edges,
    retry,
  } = usePiikShareViewer({ roomId, videoRef, videoVersion })

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

  // 音量/静音托管：元素就位时建一个 ViewerAudio（videoVersion 变化 = 元素换了）
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const audio = new ViewerAudio(video, setAudioSnapshot)
    viewerAudioRef.current = audio
    audio.setLevel(loadViewerVolume())
    // 默认尝试有声播放：被浏览器拦下时 hook 会把元素静音重试，
    // 那次 volumechange 会回到 ViewerAudio，再由快照驱动「点击开启声音」提示。
    audio.setMuted(false)
    return () => {
      audio.dispose()
      if (viewerAudioRef.current === audio) viewerAudioRef.current = null
    }
  }, [videoVersion])

  // 远端音轨到达/更换时换源：换流只重建源节点，不动增益图与用户设置。
  useEffect(() => {
    viewerAudioRef.current?.bind(remoteStream)
  }, [remoteStream, videoVersion])

  // 一键开启声音：自动播放被浏览器强制静音时，画面上方悬浮提示，
  // 点击后取消静音并恢复播放（用户手势内执行，浏览器放行有声播放）
  const handleUnmute = useCallback(() => {
    const audio = viewerAudioRef.current
    if (!audio) return
    // 音量被拖到 0 时「取消静音」仍然是没声音，先恢复到原始音量。
    if (audio.snapshot.level === 0) audio.setLevel(1)
    audio.setMuted(false)
    void videoRef.current?.play().catch(() => {})
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

  const handleToggleMute = useCallback(() => {
    const audio = viewerAudioRef.current
    if (!audio) return
    const { muted, level } = audio.snapshot
    if (muted || level === 0) {
      // 拖到 0 等同于静音：直接「取消静音」还是没声音，先恢复到原始音量。
      if (level === 0) audio.setLevel(1)
      audio.setMuted(false)
      return
    }
    audio.setMuted(true)
  }, [])

  /** 音量滑杆：0–200%，写入即持久化。 */
  const handleVolumeChange = useCallback((level: number) => {
    const clamped = Math.max(0, Math.min(VIEWER_VOLUME_MAX, level))
    viewerAudioRef.current?.setLevel(clamped)
    saveViewerVolume(clamped)
  }, [])

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
        managedMuted
        hasRemoteStream={hasRemoteStream}
        edges={edges}
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
        volumeLevel={audioSnapshot.level}
        boostAvailable={audioSnapshot.boostAvailable}
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
        onVolumeChange={handleVolumeChange}
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
      edges={edges}
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
