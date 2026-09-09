/**
 * WebRTC 屏幕共享观众端。
 *
 * 从 WatchPage.tsx 中拆分，仅处理 WebRTC 子模式的观众端：
 * - RTCPeerConnection 管理（挂载时自动创建，卸载时自动清理）
 * - 信令通道订阅（signal-offer / signal-ice-candidate / sharer-ready）
 * - video 元素绑定与分辨率/PiP 监听
 * - 控制栏、批注层、网页全屏等 UI
 *
 * WatchPage 分发器根据 roomMode + shareMethod 决定渲染本组件或 StreamPushViewer。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useHeaderCenterSlot } from '@/hooks/useHeaderCenterSlot'
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
import {
  RoomLayout,
  RoomModeSwitchBar,
} from '@/modules/room/components/RoomLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { useControlBarAutoHide } from '@/hooks/useControlBarAutoHide'
import { useP2PTunnel } from '@/modules/p2p'
import type { P2PStatus } from '@/modules/p2p/types'
import { useViewerPeerConnection } from '../hooks/useViewerPeerConnection'
import { useSignalingChannel } from '../hooks/useSignalingChannel'
import { RemoteVideoPlayer } from './RemoteVideoPlayer'
import { WatchControlsBar } from './WatchControlsBar'

/** 观众端 P2P 状态快照 */
export interface ViewerP2PStateSnapshot {
  enabled: boolean
  pc: RTCPeerConnection | null
  status: P2PStatus
  fallbackNotice: boolean
  toggle: (enabled: boolean) => void
}

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

  // 当前模式标签 → 全局 Header 中央槽位（观众只读标签，无切换权限）
  const headerCenterSlot = useHeaderCenterSlot()
  const modeSwitchPortal =
    headerCenterSlot != null
      ? createPortal(<RoomModeSwitchBar isHost={false} />, headerCenterSlot)
      : null

  // WebRTC 播放器舞台 ref（用于控制栏自动隐藏）
  const webrtcStageRef = useRef<HTMLDivElement | null>(null)

  // video ref（使用回调 ref 触发 videoVersion 变化，驱动 resolution 监听 effect 重新订阅）
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoVersion, setVideoVersion] = useState(0)
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    const prev = videoRef.current
    videoRef.current = node
    if (node && !prev) setVideoVersion((v) => v + 1)
  }, [])

  // 观众 PC hook
  const {
    pc,
    hasRemoteStream,
    hasRemoteAudio,
    connectionState,
    create: createPc,
    cleanup: cleanupPc,
    handleSignalOffer,
    handleSignalIceCandidate,
    handleSharerReady,
  } = useViewerPeerConnection({
    socket,
    roomId,
    videoRef,
    videoMountedVersion: videoVersion,
  })

  // 挂载时自动创建 PC，卸载时自动清理
  // 替代原 WatchPage 中 useJoinRoom.onApprovedScreenShare / onRoomModeChanged 的 PC 创建逻辑
  useEffect(() => {
    createPc()
    return () => {
      cleanupPc()
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [createPc, cleanupPc])

  // 信令 channel hook（订阅 signal-offer / signal-ice-candidate）
  useSignalingChannel({
    socket,
    onSignalOffer: handleSignalOffer,
    onSignalIceCandidate: handleSignalIceCandidate,
  })

  // P2P 直连隧道（观众为 receiver，remotePeerId 由 offer 自动填充）
  const [p2pFallbackNotice, setP2pFallbackNotice] = useState(false)
  const { enableP2P, disableP2P, p2pEnabled, p2pPC, p2pStatus } = useP2PTunnel({
    socket,
    roomId,
    role: 'receiver',
    onStatusChange: (status, didFallback) => {
      if (didFallback) {
        setP2pFallbackNotice(true)
        message.warning('P2P 连接失败，已回退到服务器中转')
      } else if (status === 'connected') {
        setP2pFallbackNotice(false)
        message.success('P2P 直连已建立')
      } else if (status === 'connecting') {
        setP2pFallbackNotice(false)
      }
    },
  })

  // 观众接收房主 P2P 模式广播：同步开关状态
  useEffect(() => {
    if (!socket) return
    const handleP2PModeChange = (data: {
      roomId: string
      enabled: boolean
    }) => {
      if (data.roomId !== roomId) return
      if (data.enabled) {
        void enableP2P()
      } else {
        disableP2P()
      }
    }
    socket.on('p2p-mode-change', handleP2PModeChange)
    return () => {
      socket.off('p2p-mode-change', handleP2PModeChange)
    }
  }, [socket, roomId, enableP2P, disableP2P])

  const handleToggleP2P = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        void enableP2P()
      } else {
        disableP2P()
      }
    },
    [enableP2P, disableP2P]
  )

  // WebRTC 控制栏自动隐藏（逻辑仿照 WatchTogetherCore）
  const webrtcControlBarVisible = useControlBarAutoHide(webrtcStageRef)

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

  // 订阅 sharer-ready 事件：房主开始共享时触发，观众重建 PC 并重发 viewer-ready
  useEffect(() => {
    if (!socket) return
    const handleSharerReadyEvent = (data: { roomId: string }) => {
      if (data.roomId !== roomId) return
      handleSharerReady()
    }
    socket.on('sharer-ready', handleSharerReadyEvent)
    return () => {
      socket.off('sharer-ready', handleSharerReadyEvent)
    }
  }, [socket, roomId, handleSharerReady])

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
      message.error('画中画模式不可用')
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
    cleanupPc()
    setTimeout(() => createPc(), 0)
  }, [cleanupPc, createPc])

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
      />
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
        connectionState={connectionState}
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
    <>
      {modeSwitchPortal}
      <RoomLayout
        mainContent={playerContent}
        peerConnection={pc}
        sharingRole="receiver"
        sharingActive
        p2pEnabled={p2pEnabled}
        p2pPC={p2pPC}
        p2pStatus={p2pStatus}
        p2pFallbackNotice={p2pFallbackNotice}
        onToggleP2P={handleToggleP2P}
        webFullscreen={isWebFullscreen}
        rightPanel={
          <CommentPanel socket={socket} roomId={roomId} commentsOnly />
        }
        controls={<RoomInfoPanel roomId={roomId} isHost={false} />}
        controlLabels={['房间状态']}
      />
    </>
  )
}

export default WebrtcWatchPage
