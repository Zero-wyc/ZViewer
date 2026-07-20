import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import {
  AnnotationLayer,
  AnnotationToolbar,
  type AnnotationTool,
} from '@/components/AnnotationLayer'
import { CommentPanel } from '@/components/CommentPanel'
import { WatchTogetherPanel } from '@/modules/room/watch-together/WatchTogetherPanel'
import { CinemaLayout } from '@/modules/room/components/CinemaLayout'
import { RoomLayout } from '@/modules/room/components/RoomLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { MovieListPanel } from '@/modules/room/components/MovieListPanel'
import { useJoinRoom } from '../hooks/useJoinRoom'
import { useViewerPeerConnection } from '../hooks/useViewerPeerConnection'
import { useSignalingChannel } from '../hooks/useSignalingChannel'
import { useStreamPush } from '../hooks/useStreamPush'
import { buildFlvUrl } from '../streamPushApi'
import { JoinRoomForm } from './JoinRoomForm'
import { RemoteVideoPlayer } from './RemoteVideoPlayer'
import { WatchControlsBar } from './WatchControlsBar'
import { FlvPlayer } from './FlvPlayer'
import { ConnectionStatsPanel } from './ConnectionStatsPanel'
import { StreamStatusPanel } from './StreamStatusPanel'
import type { JoinFormValues } from '../types'

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

function WatchPage() {
  const { roomId } = useParams<{ roomId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { socket, connected } = useSocket()

  // 从房间列表进入时携带的 state：{ fromList, hasPassword, name }
  // - hasPassword=true：显示密码输入框，不自动 requestJoin（避免空密码触发"密码错误"）
  // - hasPassword=false：显示加载动画，useJoinRoom 自动 requestJoin
  const navState = location.state as {
    fromList?: boolean
    hasPassword?: boolean
    name?: string | null
  } | null
  const fromList = navState?.fromList === true
  const listHasPassword = navState?.hasPassword === true
  const listRoomName = navState?.name ?? null

  // UI state
  const [isMuted, setIsMuted] = useState(false)
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

  // video ref（使用回调 ref 触发 videoVersion 变化，驱动 resolution 监听 effect 重新订阅）
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoVersion, setVideoVersion] = useState(0)
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    const prev = videoRef.current
    videoRef.current = node
    if (node && !prev) setVideoVersion((v) => v + 1)
  }, [])

  // ref 转发模式：解决 useJoinRoom 回调调用 useViewerPeerConnection 函数的循环依赖
  const createPcRef = useRef<() => void>(() => {})
  const cleanupPcRef = useRef<() => void>(() => {})

  // 1. 加入房间 hook
  const { joinStatus, roomMode, requestJoin } = useJoinRoom({
    socket,
    roomId,
    connected,
    // 从房间列表进入有密码的房间时，不自动 requestJoin，等待用户输入密码
    autoJoin: !(fromList && listHasPassword),
    onApprovedScreenShare: () => {
      createPcRef.current()
    },
    onRoomClosed: (data) => {
      message.warning(`房间 ${data.roomId} 已关闭`)
      cleanupPcRef.current()
      if (videoRef.current) videoRef.current.srcObject = null
      setTimeout(() => navigate('/room', { replace: true }), 1500)
    },
    onRoomModeChanged: (data) => {
      if (data.mode === 'watch-together') {
        cleanupPcRef.current()
        if (videoRef.current) videoRef.current.srcObject = null
      } else if (data.mode === 'screen-share' && joinStatus === 'approved') {
        createPcRef.current()
      }
    },
  })

  // 2. 观众 PC hook
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
  })

  // 同步 create/cleanup 到 ref，供 useJoinRoom 回调使用
  useEffect(() => {
    createPcRef.current = createPc
  }, [createPc])
  useEffect(() => {
    cleanupPcRef.current = cleanupPc
  }, [cleanupPc])

  // 3. 信令 channel hook（订阅 signal-offer / signal-ice-candidate）
  useSignalingChannel({
    socket,
    onSignalOffer: handleSignalOffer,
    onSignalIceCandidate: handleSignalIceCandidate,
  })

  // 3.5 推流子模式状态（仅 screen-share + stream-push 时使用）
  const { shareMethod, streamStatus } = useStreamPush({
    socket,
    roomId: roomId ?? '',
    isHost: false,
  })

  // 3.7 订阅 sharer-ready 事件：房主开始共享时触发，观众重建 PC 并重发 viewer-ready
  useEffect(() => {
    if (!socket) return
    const handleSharerReadyEvent = (data: { roomId: string }) => {
      if (data.roomId !== roomId) return
      if (joinStatus !== 'approved') return
      if (roomMode !== 'screen-share') return
      if (shareMethod !== 'webrtc') return
      handleSharerReady()
    }
    socket.on('sharer-ready', handleSharerReadyEvent)
    return () => {
      socket.off('sharer-ready', handleSharerReadyEvent)
    }
  }, [socket, roomId, joinStatus, roomMode, shareMethod, handleSharerReady])

  // 4. video 元素 resolution / PiP 监听
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
        setVideoResolution({
          width: video.videoWidth,
          height: video.videoHeight,
        })
    }, 1000)

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener(pipEnter, handleEnterPiP)
      video.removeEventListener(pipLeave, handleLeavePiP)
      clearInterval(interval)
    }
  }, [joinStatus, hasRemoteStream, videoVersion])

  // 5. isMuted 同步到 video 元素
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = isMuted
  }, [isMuted])

  // 6. 事件处理
  const handleJoin = (values: JoinFormValues) => {
    if (!values.roomId.trim()) {
      message.warning('请输入房间号')
      return
    }
    const targetRoomId = values.roomId.trim()
    if (targetRoomId !== roomId) {
      // 导航到新房间，useJoinRoom 内部 effect 会自动 requestJoin
      navigate(`/room/${targetRoomId}`)
    } else {
      requestJoin(targetRoomId, values.password ?? '')
    }
  }

  const handleFullscreen = () => {
    const video = videoRef.current
    if (!video) return
    video.requestFullscreen().catch((err) => {
      console.error('[WatchPage] fullscreen error:', err)
      message.error('无法进入全屏模式')
    })
  }

  const handleTogglePictureInPicture = async () => {
    const video = videoRef.current
    if (!video) return
    try {
      if (document.pictureInPictureElement === video)
        await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    } catch (err) {
      console.error('[WatchPage] picture-in-picture error:', err)
      message.error('画中画模式不可用')
    }
  }

  const handleToggleMute = () => setIsMuted((prev) => !prev)

  // 7.1 已加入且 roomMode === 'watch-together'：观众使用与房主统一的 RoomLayout
  if (joinStatus === 'approved' && roomMode === 'watch-together') {
    return (
      <RoomLayout
        roomId={roomId ?? ''}
        isHost={false}
        mainContent={
          <WatchTogetherPanel roomId={roomId ?? ''} isHost={false} />
        }
        rightPanel={
          <CommentPanel
            socket={socket}
            roomId={roomId ?? ''}
            commentsOnly={false}
          />
        }
        controls={
          <>
            <RoomInfoPanel roomId={roomId ?? ''} isHost={false} />
            <MovieListPanel isHost={false} />
          </>
        }
      />
    )
  }

  // 7.2 已加入且 roomMode === 'screen-share'：保持原有 CinemaLayout
  if (joinStatus === 'approved' && roomMode === 'screen-share') {
    // screen-share + stream-push 子模式：使用 FlvPlayer 拉流播放
    if (shareMethod === 'stream-push') {
      const flvUrl = buildFlvUrl(roomId ?? '')
      const playerContent = (
        <div className="relative h-full w-full">
          {streamStatus === 'offline' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
              <div className="text-base font-medium text-[var(--md-sys-color-on-surface-variant)]">
                主播未推流
              </div>
              <div className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
                请等待房主开始 OBS 推流
              </div>
            </div>
          ) : (
            <FlvPlayer src={flvUrl} muted={isMuted} autoPlay />
          )}
        </div>
      )

      return (
        <CinemaLayout
          children={playerContent}
          statsPanel={<StreamStatusPanel streamStatus={streamStatus} />}
          chatPanel={
            <CommentPanel socket={socket} roomId={roomId ?? ''} commentsOnly />
          }
        />
      )
    }

    // screen-share + webrtc 子模式：原有 WebRTC 接收逻辑
    const playerContent = (
      <div className="relative h-full w-full">
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
          roomId={roomId ?? ''}
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
          hasRemoteAudio={hasRemoteAudio}
          hasRemoteStream={hasRemoteStream}
          isPictureInPicture={isPictureInPicture}
          isPiPSupported={isPiPSupported}
          showAnnotationToolbar={showAnnotationToolbar}
          connected={connected}
          connectionState={connectionState}
          videoResolution={videoResolution}
          onToggleMute={handleToggleMute}
          onFullscreen={handleFullscreen}
          onTogglePiP={handleTogglePictureInPicture}
          onToggleAnnotation={() => setShowAnnotationToolbar((prev) => !prev)}
        />
      </div>
    )

    return (
      <CinemaLayout
        children={playerContent}
        statsPanel={<ConnectionStatsPanel pc={pc} mode="server" />}
        chatPanel={
          <CommentPanel socket={socket} roomId={roomId ?? ''} commentsOnly />
        }
      />
    )
  }

  // 7.3 未加入或加入失败：根据入口来源渲染不同 UI
  // - 从房间列表进入的无密码房间：显示加载动画（useJoinRoom 正在自动加入）
  // - 从房间列表进入的有密码房间：显示密码输入框（隐藏房间号）
  // - 其他情况（直接访问 URL）：显示完整的 JoinRoomForm
  if (
    fromList &&
    !listHasPassword &&
    (joinStatus === 'idle' || joinStatus === 'joining')
  ) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
        <Spinner tip="正在加入房间..." size={48} />
        {listRoomName && <Text type="secondary">正在加入：{listRoomName}</Text>}
      </div>
    )
  }

  return (
    <JoinRoomForm
      initialRoomId={roomId ?? ''}
      joinStatus={joinStatus}
      onSubmit={handleJoin}
      onBack={() => navigate('/')}
      hideRoomId={fromList && listHasPassword}
      roomName={
        fromList && listHasPassword ? (listRoomName ?? undefined) : undefined
      }
      passwordRequired={fromList && listHasPassword}
    />
  )
}

export default WatchPage
