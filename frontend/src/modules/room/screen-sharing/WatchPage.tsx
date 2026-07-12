import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Eye,
  Maximize,
  PictureInPicture,
  PictureInPicture2,
  Volume2,
  VolumeX,
  Pencil,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph, Text } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Form } from '@/components/ui/Form'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { Spinner } from '@/components/ui/Spinner'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { ConnectionStatsPanel } from '@/components/ConnectionStatsPanel'
import { VideoStatsMenu } from '@/components/VideoStatsMenu'
import { WatchTogetherPanel } from '@/modules/room/watch-together/WatchTogetherPanel'
import { CinemaLayout } from '@/modules/room/components/CinemaLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { MovieListPanel } from '@/modules/room/components/MovieListPanel'
import { MoviePushPanel } from '@/modules/room/components/MoviePushPanel'
import { CommentPanel } from '@/components/CommentPanel'
import { DanmakuLayer } from '@/components/DanmakuLayer'
import {
  AnnotationLayer,
  AnnotationToolbar,
  type AnnotationTool,
} from '@/components/AnnotationLayer'

type JoinStatus =
  'idle' | 'joining' | 'approved' | 'rejected' | 'closed' | 'password-required'

type ConnectionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

interface SignalPayload<T> {
  from: string
  data: T
}

interface RequestJoinResponse {
  success: boolean
  message?: string
  mode?: 'screen-share' | 'watch-together'
}

interface JoinFormValues {
  roomId: string
  password?: string
  [key: string]: unknown
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

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

function WatchPage() {
  const { roomId } = useParams<{ roomId?: string }>()
  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const setStoreMode = useRoomStore((state) => state.setMode)
  const setRoomName = useRoomStore((state) => state.setRoomName)
  const [roomMode, setRoomMode] = useState<
    'screen-share' | 'watch-together' | null
  >(null)
  const [joinStatus, setJoinStatus] = useState<JoinStatus>('idle')
  const [connectionState, setConnectionState] = useState<ConnectionState>('new')
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [remoteStreamState, setRemoteStreamState] =
    useState<MediaStream | null>(null)
  const [peerConnection, setPeerConnection] =
    useState<RTCPeerConnection | null>(null)
  const [hasRemoteAudio, setHasRemoteAudio] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [videoResolution, setVideoResolution] = useState<{
    width: number
    height: number
  } | null>(null)
  const [videoVersion, setVideoVersion] = useState(0)
  const [isPictureInPicture, setIsPictureInPicture] = useState(false)
  const [isPiPSupported] = useState(
    () => typeof document !== 'undefined' && document.pictureInPictureEnabled
  )
  const [annotationTool, setAnnotationTool] = useState<AnnotationTool>('pen')
  const [annotationColor, setAnnotationColor] = useState('#f76f53')
  const [annotationWidth, setAnnotationWidth] = useState(3)
  const [showAnnotationToolbar, setShowAnnotationToolbar] = useState(false)
  const annotationRef = useRef<{ clear: () => void }>(null)
  const requestedRoomIdRef = useRef<string | null>(null)
  const pendingPasswordRef = useRef<string>('')
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    const prev = videoRef.current
    videoRef.current = node
    if (node && !prev) {
      setVideoVersion((v) => v + 1)
    }
  }, [])
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const sharerSocketIdRef = useRef<string | null>(null)
  const autoplayAttemptedRef = useRef(false)
  const hasJoinedRef = useRef(false)
  const processingOfferRef = useRef(false)
  const isCreatingPcRef = useRef(false)
  const mergedStreamRef = useRef<MediaStream | null>(null)
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([])

  const cleanupPeerConnection = useCallback(() => {
    const pc = pcRef.current
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
      pcRef.current = null
    }
    sharerSocketIdRef.current = null
    remoteStreamRef.current = null
    mergedStreamRef.current?.getTracks().forEach((track) => track.stop())
    mergedStreamRef.current = null
    hasJoinedRef.current = false
    isCreatingPcRef.current = false
    pendingIceCandidatesRef.current = []
    setConnectionState('closed')
    setHasRemoteStream(false)
    setRemoteStreamState(null)
    setHasRemoteAudio(false)
    setPeerConnection(null)
    autoplayAttemptedRef.current = false
  }, [])

  const createPeerConnection = useCallback(() => {
    if (isCreatingPcRef.current) {
      console.log('[WatchPage] PC creation already in progress, skip')
      return
    }
    if (pcRef.current) {
      console.log('[WatchPage] PC already exists, skip')
      return
    }
    isCreatingPcRef.current = true

    cleanupPeerConnection()

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcRef.current = pc
    setPeerConnection(pc)
    setConnectionState(pc.connectionState as ConnectionState)

    const mergedStream = new MediaStream()
    mergedStreamRef.current = mergedStream
    remoteStreamRef.current = mergedStream

    pc.ontrack = (event) => {
      const incomingTrack = event.track
      if (!incomingTrack) return

      // 将不同 stream 的 track 合并到一个 MediaStream，避免麦克风 track 替换掉屏幕视频 stream 导致黑屏
      if (!mergedStream.getTrackById(incomingTrack.id)) {
        mergedStream.addTrack(incomingTrack)
        console.log(
          '[WatchPage] added remote track:',
          incomingTrack.kind,
          incomingTrack.label
        )
      }

      setRemoteStreamState(mergedStream)
      setHasRemoteStream(
        mergedStream.getVideoTracks().some((track) => !track.muted) ||
          mergedStream.getVideoTracks().length > 0
      )
      setHasRemoteAudio(
        mergedStream.getAudioTracks().some((track) => track.enabled)
      )
      autoplayAttemptedRef.current = false

      // 立即将合并后的流绑定到 video 元素
      const video = videoRef.current
      if (video && video.srcObject !== mergedStream) {
        video.srcObject = mergedStream
        void video.play().catch((err: Error) => {
          console.error('[WatchPage] direct play error:', err)
          if (err.name === 'NotAllowedError') {
            video.muted = true
            setIsMuted(true)
            void video.play().catch((retryErr: Error) => {
              console.error('[WatchPage] muted direct play error:', retryErr)
            })
          }
        })
      }

      if (incomingTrack.kind === 'video') {
        console.log(
          '[WatchPage] remote video track:',
          incomingTrack.label,
          'enabled:',
          incomingTrack.enabled,
          'muted:',
          incomingTrack.muted
        )
        incomingTrack.addEventListener('unmute', () => {
          console.log('[WatchPage] remote video track unmuted')
          setHasRemoteStream(true)
          setVideoVersion((v) => v + 1)
          const v2 = videoRef.current
          if (v2 && v2.srcObject !== mergedStream) {
            v2.srcObject = mergedStream
          }
          if (v2) {
            autoplayAttemptedRef.current = false
            void v2.play().catch((err: Error) => {
              console.error('[WatchPage] unmute play error:', err)
            })
          }
        })
        incomingTrack.addEventListener('mute', () => {
          console.warn('[WatchPage] remote video track muted')
        })
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && socket && sharerSocketIdRef.current) {
        socket.emit('signal-ice-candidate', {
          to: sharerSocketIdRef.current,
          data: event.candidate,
        })
      }
    }

    pc.onconnectionstatechange = () => {
      setConnectionState(pc.connectionState as ConnectionState)
    }

    // 通知共享端：观看端 RTCPeerConnection 已就绪，可以发送 offer
    if (roomId) {
      console.log('[WatchPage] emit viewer-ready for room:', roomId)
      socket?.emit('viewer-ready', { roomId })
    }

    isCreatingPcRef.current = false
    return pc
  }, [socket, cleanupPeerConnection, roomId])

  const requestJoin = useCallback(
    (targetRoomId: string, password: string) => {
      if (!socket || !connected) {
        message.warning('Socket 尚未连接，请稍后重试')
        setJoinStatus('idle')
        return
      }

      hasJoinedRef.current = false
      setJoinStatus('joining')
      socket.emit(
        'request-join',
        { roomId: targetRoomId, password },
        (response: RequestJoinResponse) => {
          if (response.success) {
            const mode = response.mode ?? 'screen-share'
            setRoomMode(mode)
            setStoreMode(mode)
            if (mode === 'watch-together') {
              if (response.message === '已加入房间') {
                // 无需确认，已加入房间
                hasJoinedRef.current = true
                setJoinStatus('approved')
                message.success(response.message)
              } else {
                // 需要房主确认，等待 join-approved 事件
                message.info(response.message ?? '等待房主确认')
              }
              return
            }
            if (response.message === '已加入房间') {
              hasJoinedRef.current = true
              setJoinStatus('approved')
              message.success(response.message)
              createPeerConnection()
            } else {
              message.info(response.message ?? '等待分享端确认')
            }
          } else {
            const isPasswordError = response.message === '密码错误'
            if (isPasswordError) {
              setJoinStatus('password-required')
              requestedRoomIdRef.current = null
              message.error('密码错误，请重新输入')
            } else {
              setJoinStatus('idle')
              message.error(response.message ?? '加入房间失败')
            }
          }
        }
      )
    },
    [socket, connected, createPeerConnection]
  )

  useEffect(() => {
    if (!socket || !connected || !roomId) return
    if (requestedRoomIdRef.current === roomId) return

    requestedRoomIdRef.current = roomId
    const password = pendingPasswordRef.current
    pendingPasswordRef.current = ''
    requestJoin(roomId, password)
  }, [socket, connected, roomId, requestJoin])

  useEffect(() => {
    if (!socket) return

    const handleJoinApproved = (data: {
      roomId: string
      name?: string | null
      mode?: 'screen-share' | 'watch-together'
    }) => {
      if (data.name) {
        setRoomName(data.name)
      }
      const mode = data.mode ?? roomMode ?? 'screen-share'
      setRoomMode(mode)
      setStoreMode(mode)
      if (mode === 'watch-together') {
        if (hasJoinedRef.current) {
          setJoinStatus('approved')
          return
        }
        hasJoinedRef.current = true
        setJoinStatus('approved')
        message.success(`已获准加入房间 ${data.roomId}`)
        return
      }
      if (hasJoinedRef.current) {
        setJoinStatus('approved')
        return
      }
      hasJoinedRef.current = true
      setJoinStatus('approved')
      message.success(`已获准加入房间 ${data.roomId}`)
      createPeerConnection()
    }

    const handleJoinRejected = (data: { roomId: string }) => {
      setJoinStatus('rejected')
      message.warning(`加入房间 ${data.roomId} 被拒绝`)
    }

    const handleRoomClosed = (data: { roomId: string }) => {
      message.warning(`房间 ${data.roomId} 已关闭`)
      setJoinStatus('closed')
      cleanupPeerConnection()
      remoteStreamRef.current?.getTracks().forEach((track) => track.stop())
      remoteStreamRef.current = null
      setRemoteStreamState(null)
      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
      setTimeout(() => navigate('/room', { replace: true }), 1500)
    }

    const handleRoomNameUpdated = (data: { roomId: string; name: string }) => {
      if (data.roomId === roomId) {
        setRoomName(data.name)
      }
    }

    const handleRoomModeChanged = (data: {
      mode: 'screen-share' | 'watch-together'
    }) => {
      setRoomMode(data.mode)
      setStoreMode(data.mode)
      if (data.mode === 'watch-together') {
        cleanupPeerConnection()
        remoteStreamRef.current?.getTracks().forEach((track) => track.stop())
        remoteStreamRef.current = null
        setRemoteStreamState(null)
        if (videoRef.current) {
          videoRef.current.srcObject = null
        }
      } else if (data.mode === 'screen-share' && joinStatus === 'approved') {
        // 切换回屏幕共享：等待房主开始共享后接收 offer
        createPeerConnection()
      }
    }

    const handleSignalOffer = async (
      data: SignalPayload<RTCSessionDescriptionInit>
    ) => {
      sharerSocketIdRef.current = data.from
      const pc = pcRef.current
      if (!pc) {
        message.error('WebRTC 连接尚未创建')
        return
      }

      // 避免并发处理多个 offer 导致 SDP 状态混乱
      if (processingOfferRef.current) {
        console.log('[WatchPage] already processing offer, skip duplicate')
        return
      }
      processingOfferRef.current = true

      try {
        console.log('[WatchPage] handle offer, state:', pc.signalingState)
        if (pc.signalingState === 'have-remote-offer') {
          console.log('[WatchPage] already have remote offer, skip')
          processingOfferRef.current = false
          return
        }
        if (pc.signalingState !== 'stable') {
          console.log('[WatchPage] skip offer in state:', pc.signalingState)
          processingOfferRef.current = false
          return
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.data))
        console.log(
          '[WatchPage] after setRemoteDescription, state:',
          pc.signalingState
        )

        // 处理在 setRemoteDescription 之前到达的 ICE candidate
        const pending = pendingIceCandidatesRef.current
        pendingIceCandidatesRef.current = []
        for (const candidate of pending) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          } catch (candidateErr) {
            console.error(
              '[WatchPage] add queued ice candidate error:',
              candidateErr
            )
          }
        }

        const answer = await pc.createAnswer()
        console.log('[WatchPage] created answer')
        await pc.setLocalDescription(answer)
        console.log(
          '[WatchPage] after setLocalDescription, state:',
          pc.signalingState
        )
        console.log('[WatchPage] sending answer to', data.from)
        socket.emit('signal-answer', {
          to: data.from,
          data: answer,
        })
      } catch (err) {
        console.error('[WatchPage] handle offer error:', err)
        message.error('处理共享端连接请求失败')
      } finally {
        processingOfferRef.current = false
      }
    }

    const handleSignalIceCandidate = async (
      data: SignalPayload<RTCIceCandidateInit>
    ) => {
      const pc = pcRef.current
      if (!pc) return
      try {
        if (!pc.remoteDescription) {
          console.log(
            '[WatchPage] queuing ice candidate until remote description is set'
          )
          pendingIceCandidatesRef.current.push(data.data)
          return
        }
        await pc.addIceCandidate(new RTCIceCandidate(data.data))
      } catch (err) {
        console.error('[WatchPage] add ice candidate error:', err)
        message.error('处理网络候选失败')
      }
    }

    socket.on('join-approved', handleJoinApproved)
    socket.on('join-rejected', handleJoinRejected)
    socket.on('room-closed', handleRoomClosed)
    socket.on('room-name-updated', handleRoomNameUpdated)
    socket.on('room-mode-changed', handleRoomModeChanged)
    socket.on('signal-offer', handleSignalOffer)
    socket.on('signal-ice-candidate', handleSignalIceCandidate)

    return () => {
      socket.off('join-approved', handleJoinApproved)
      socket.off('join-rejected', handleJoinRejected)
      socket.off('room-closed', handleRoomClosed)
      socket.off('room-name-updated', handleRoomNameUpdated)
      socket.off('room-mode-changed', handleRoomModeChanged)
      socket.off('signal-offer', handleSignalOffer)
      socket.off('signal-ice-candidate', handleSignalIceCandidate)
    }
  }, [
    socket,
    navigate,
    createPeerConnection,
    cleanupPeerConnection,
    roomMode,
    joinStatus,
    setStoreMode,
    setRoomName,
    roomId,
  ])

  useEffect(() => {
    return () => {
      remoteStreamRef.current?.getTracks().forEach((track) => track.stop())
      remoteStreamRef.current = null

      const videoElement = videoRef.current
      if (videoElement) {
        videoElement.srcObject = null
      }
      cleanupPeerConnection()
    }
  }, [cleanupPeerConnection])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleLoadedMetadata = () => {
      setVideoResolution({
        width: video.videoWidth,
        height: video.videoHeight,
      })
    }

    const handleEnterPiP = () => setIsPictureInPicture(true)
    const handleLeavePiP = () => setIsPictureInPicture(false)

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener(
      'enterpictureinpicture' as keyof HTMLVideoElementEventMap,
      handleEnterPiP
    )
    video.addEventListener(
      'leavepictureinpicture' as keyof HTMLVideoElementEventMap,
      handleLeavePiP
    )

    const interval = setInterval(() => {
      if (video.videoWidth && video.videoHeight) {
        setVideoResolution({
          width: video.videoWidth,
          height: video.videoHeight,
        })
      }
    }, 1000)

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener(
        'enterpictureinpicture' as keyof HTMLVideoElementEventMap,
        handleEnterPiP
      )
      video.removeEventListener(
        'leavepictureinpicture' as keyof HTMLVideoElementEventMap,
        handleLeavePiP
      )
      clearInterval(interval)
    }
  }, [joinStatus, hasRemoteStream, videoVersion])

  useEffect(() => {
    const video = videoRef.current
    const stream = remoteStreamState
    if (!video || !stream) return

    video.srcObject = stream
    autoplayAttemptedRef.current = false

    const attemptPlay = () => {
      if (!video || autoplayAttemptedRef.current) return
      autoplayAttemptedRef.current = true
      video
        .play()
        .then(() => {
          console.log('[WatchPage] remote video playing')
        })
        .catch((err: Error) => {
          console.error('[WatchPage] autoplay error:', err)
          if (err.name === 'NotAllowedError') {
            setIsMuted(true)
            video.muted = true
            autoplayAttemptedRef.current = false
            attemptPlay()
          }
        })
    }

    // 立即尝试播放；同时监听轨道 unmute，防止初始 muted 导致黑屏
    attemptPlay()

    const unmuteHandlers: Array<() => void> = []
    stream.getVideoTracks().forEach((track) => {
      const handler = () => {
        console.log('[WatchPage] remote video track unmuted, retry play')
        autoplayAttemptedRef.current = false
        attemptPlay()
      }
      track.addEventListener('unmute', handler)
      unmuteHandlers.push(() => track.removeEventListener('unmute', handler))
    })

    const handleLoadedMetadata = () => {
      autoplayAttemptedRef.current = false
      attemptPlay()
    }
    video.addEventListener('loadedmetadata', handleLoadedMetadata)

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      unmuteHandlers.forEach((cleanup) => cleanup())
    }
  }, [remoteStreamState, videoVersion])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = isMuted
  }, [isMuted])

  const handleJoin = (values: JoinFormValues) => {
    if (!values.roomId.trim()) {
      message.warning('请输入房间号')
      return
    }

    const targetRoomId = values.roomId.trim()
    setJoinStatus('idle')
    setConnectionState('new')
    setHasRemoteStream(false)
    setRemoteStreamState(null)
    setHasRemoteAudio(false)
    cleanupPeerConnection()

    if (targetRoomId !== roomId) {
      pendingPasswordRef.current = values.password ?? ''
      navigate(`/room/${targetRoomId}`)
    } else {
      requestedRoomIdRef.current = targetRoomId
      requestJoin(targetRoomId, values.password ?? '')
    }
  }

  const handleFullscreen = () => {
    const video = videoRef.current
    if (!video) return
    video
      .requestFullscreen()
      .then(() => {
        // 全屏由浏览器原生控制，无需额外状态
      })
      .catch((err) => {
        console.error('[WatchPage] fullscreen error:', err)
        message.error('无法进入全屏模式')
      })
  }

  const handleTogglePictureInPicture = async () => {
    const video = videoRef.current
    if (!video) return

    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture()
      } else {
        await video.requestPictureInPicture()
      }
    } catch (err) {
      console.error('[WatchPage] picture-in-picture error:', err)
      message.error('画中画模式不可用')
    }
  }

  const handleToggleMute = () => {
    setIsMuted((prev) => !prev)
  }

  const getStatusText = () => {
    switch (joinStatus) {
      case 'joining':
        return '正在等待分享端确认...'
      case 'approved':
        return '已成功加入房间'
      case 'rejected':
        return '加入请求被拒绝'
      case 'closed':
        return '房间已关闭'
      case 'password-required':
        return '该房间需要密码，请输入密码后重新加入'
      default:
        return '正在连接房间'
    }
  }

  const getConnectionStateText = () => {
    switch (connectionState) {
      case 'connecting':
        return '连接中'
      case 'connected':
        return '已连接'
      case 'disconnected':
        return '已断开'
      case 'failed':
        return '连接失败'
      case 'closed':
        return '连接已关闭'
      default:
        return '等待连接'
    }
  }

  const getConnectionStateColor = () => {
    switch (connectionState) {
      case 'connected':
        return 'success' as const
      case 'connecting':
        return 'primary' as const
      case 'disconnected':
      case 'failed':
      case 'closed':
        return 'danger' as const
      default:
        return 'default' as const
    }
  }

  const showJoinForm = !roomId || joinStatus === 'password-required'

  if (joinStatus === 'approved' && roomMode) {
    const isScreenShare = roomMode === 'screen-share'
    const playerContent = isScreenShare ? (
      <div className="relative h-full w-full">
        <video
          ref={setVideoRef}
          autoPlay
          playsInline
          muted={isMuted}
          className="h-full w-full object-contain"
        />
        <VideoStatsMenu
          videoElement={videoRef.current}
          pc={peerConnection}
          sourceType="webrtc"
        />
        {!hasRemoteStream && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/80">
            <Spinner tip="正在接收画面..." size={32} />
          </div>
        )}
        <DanmakuLayer socket={socket} />
        <AnnotationLayer
          ref={annotationRef}
          socket={socket}
          roomId={roomId ?? ''}
          tool={annotationTool}
          color={annotationColor}
          width={annotationWidth}
        />

        {/* 批注工具浮窗 */}
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

        {/* 底部控制栏 */}
        <div
          className="absolute bottom-0 left-0 right-0 z-20 p-3"
          style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
        >
          <Space className="w-full" wrap>
            {hasRemoteAudio && (
              <Button
                icon={
                  isMuted ? (
                    <VolumeX className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )
                }
                onClick={handleToggleMute}
              >
                {isMuted ? '取消静音' : '静音'}
              </Button>
            )}
            <Button
              icon={<Maximize className="h-4 w-4" />}
              onClick={handleFullscreen}
            >
              全屏
            </Button>
            {isPiPSupported && (
              <Button
                icon={
                  isPictureInPicture ? (
                    <PictureInPicture2 className="h-4 w-4" />
                  ) : (
                    <PictureInPicture className="h-4 w-4" />
                  )
                }
                onClick={handleTogglePictureInPicture}
              >
                {isPictureInPicture ? '退出画中画' : '画中画'}
              </Button>
            )}
            <Button
              variant={showAnnotationToolbar ? 'primary' : 'secondary'}
              icon={
                showAnnotationToolbar ? (
                  <X className="h-4 w-4" />
                ) : (
                  <Pencil className="h-4 w-4" />
                )
              }
              onClick={() => setShowAnnotationToolbar((prev) => !prev)}
            >
              {showAnnotationToolbar ? '关闭批注' : '批注'}
            </Button>
          </Space>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Tag color={connected ? 'success' : 'default'}>
              {connected ? '已连接' : '未连接'}
            </Tag>
            <Tag color="primary">已加入</Tag>
            <Tag color={getConnectionStateColor()}>
              {getConnectionStateText()}
            </Tag>
            {hasRemoteStream && hasRemoteAudio && (
              <Tag color="cyan">{isMuted ? '静音中' : '音频开启'}</Tag>
            )}
          </div>
          {videoResolution && (
            <Paragraph className="m-0 mt-2">
              <Text type="secondary">
                分辨率：{videoResolution.width} x {videoResolution.height}
              </Text>
            </Paragraph>
          )}
          <ConnectionStatsPanel pc={peerConnection} mode="server" />
        </div>
      </div>
    ) : (
      <WatchTogetherPanel roomId={roomId ?? ''} isHost={false} />
    )

    return (
      <CinemaLayout
        children={playerContent}
        roomInfoPanel={<RoomInfoPanel roomId={roomId ?? ''} isHost={false} />}
        movieListPanel={<MovieListPanel isHost={false} />}
        moviePushPanel={<MoviePushPanel isHost={false} />}
        chatPanel={<CommentPanel socket={socket} roomId={roomId ?? ''} />}
      />
    )
  }

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="relative w-full max-w-xl text-center">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={() => navigate('/')}
          className="absolute left-4 top-4"
        >
          返回
        </Button>
        <Title level={3}>加入房间</Title>
        {showJoinForm ? (
          <Form<JoinFormValues>
            onFinish={handleJoin}
            initialValues={{ roomId: roomId ?? '', password: '' }}
            className="mt-4 text-left"
          >
            <Form.Item
              label="房间号"
              name="roomId"
              rules={[{ required: true, message: '请输入房间号' }]}
            >
              <Input size="lg" placeholder="请输入要加入的房间号" />
            </Form.Item>
            <Form.Item label="房间密码（可选）" name="password">
              <InputPassword
                size="lg"
                placeholder="如房间未设置密码可留空"
                maxLength={32}
              />
            </Form.Item>
            <Form.Item>
              <Button
                variant="primary"
                type="submit"
                size="lg"
                block
                icon={<Eye className="h-5 w-5" />}
              >
                {joinStatus === 'password-required' ? '重新加入' : '加入观看'}
              </Button>
            </Form.Item>
          </Form>
        ) : (
          <Space direction="vertical" className="mt-4 w-full">
            <Paragraph type="secondary">{getStatusText()}</Paragraph>
            <Paragraph
              className="rounded px-3 py-1.5 font-mono text-xl font-semibold"
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
              }}
            >
              {roomId}
            </Paragraph>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Tag color={connected ? 'success' : 'default'}>
                {connected ? '已连接' : '未连接'}
              </Tag>
            </div>
            {joinStatus === 'joining' && (
              <Spinner tip="等待分享端确认..." size={32} />
            )}
            <Paragraph type="secondary" className="text-xs">
              分享端确认后，将在此显示远端画面。
            </Paragraph>
          </Space>
        )}
      </Card>
    </div>
  )
}

export default WatchPage
