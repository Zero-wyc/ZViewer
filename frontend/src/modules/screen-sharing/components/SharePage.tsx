import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { ConfirmModal } from '@/components/ui/Modal'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { AnnotationLayer } from '@/components/AnnotationLayer'
import { useLocalMediaStream } from '../hooks/useLocalMediaStream'
import { useHostPeerConnections } from '../hooks/useHostPeerConnections'
import { useSignalingChannel } from '../hooks/useSignalingChannel'
import { useStreamPush } from '../hooks/useStreamPush'
import { MediaSettingsCard } from './MediaSettingsCard'
import { ShareControlsBar } from './ShareControlsBar'
import { SharingPausedOverlay } from './SharingPausedOverlay'
import { StreamPushPage } from './StreamPushPage'
import type {
  CloseRoomResponse,
  RoomClosedPayload,
  RoomModeChangedPayload,
} from '../types'

interface SharePageProps {
  className?: string
  style?: React.CSSProperties
  onStatsPeerConnectionChange?: (pc: RTCPeerConnection | null) => void
}

function SharePage({
  className,
  style,
  onStatsPeerConnectionChange,
}: SharePageProps) {
  const { roomId } = useParams<{ roomId?: string }>()
  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const setMode = useRoomStore((state) => state.setMode)
  const setIsSharing = useRoomStore((state) => state.setIsSharing)
  const currentRoomId = roomId ?? ''

  // 推流子模式状态（房主端独有）
  const { shareMethod, streamStatus, updateShareMethod } = useStreamPush({
    socket,
    roomId: currentRoomId,
    isHost: true,
  })

  const handleShareMethodChange = useCallback(
    (value: string) => {
      if (value === shareMethod) return
      // 切换到 webrtc 前提示先停止 OBS 推流
      if (value === 'webrtc' && streamStatus === 'live') {
        message.warning('请先在 OBS 中停止推流再切换到 WebRTC 共享')
        return
      }
      void updateShareMethod(value as 'webrtc' | 'stream-push').then((res) => {
        if (!res.success) {
          message.error(res.message ?? '切换子模式失败')
        }
      })
    },
    [shareMethod, streamStatus, updateShareMethod]
  )

  const [frameRate, setFrameRate] = useState(30)
  const [maxBitrateMbps, setMaxBitrateMbps] = useState(8)
  const [shareSystemAudio, setShareSystemAudio] = useState(false)
  const [shareMicrophone, setShareMicrophone] = useState(false)
  const [closing, setClosing] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  // onStreamEnded 需引用下方 hook 返回的 stop/cleanupPeerConnections，用 ref 转发避免循环依赖
  const handleStreamEndedRef = useRef<() => void>(() => {})

  const { stream, micStream, isSharing, isPaused, start, stop, pause, resume } =
    useLocalMediaStream({
      frameRate,
      maxBitrateMbps,
      shareSystemAudio,
      shareMicrophone,
      onStreamEnded: () => handleStreamEndedRef.current(),
      localVideoRef,
    })

  const {
    connectionCount,
    statsPeerConnection,
    viewerIds,
    handleSignalAnswer,
    handleSignalIceCandidate,
    handleViewerReady,
    handleViewerJoined,
    handleViewerLeft,
    cleanup: cleanupPeerConnections,
  } = useHostPeerConnections({
    socket,
    localStream: stream,
    micStream,
    frameRate,
    maxBitrateMbps,
  })

  const handleStreamEnded = useCallback(() => {
    stop()
    cleanupPeerConnections()
    if (!socket) return
    socket.emit('close-room', (response: CloseRoomResponse) => {
      if (response.success) {
        message.success('房间已关闭')
        navigate('/', { replace: true })
      } else {
        message.error(response.message ?? '关闭房间失败')
      }
    })
  }, [stop, cleanupPeerConnections, socket, navigate])

  useEffect(() => {
    handleStreamEndedRef.current = handleStreamEnded
  }, [handleStreamEnded])

  const handleRoomClosed = useCallback(
    (data: RoomClosedPayload) => {
      message.warning(`房间 ${data.roomId} 已关闭`)
      setClosing(true)
      stop()
      cleanupPeerConnections()
      setTimeout(() => navigate('/', { replace: true }), 1500)
    },
    [stop, cleanupPeerConnections, navigate]
  )

  const handleRoomModeChanged = useCallback(
    (data: RoomModeChangedPayload) => {
      setMode(data.mode)
      if (data.mode === 'watch-together') {
        stop()
        cleanupPeerConnections()
      }
    },
    [setMode, stop, cleanupPeerConnections]
  )

  const handleCloseRoom = useCallback(() => {
    if (!socket) return
    setClosing(true)
    stop()
    cleanupPeerConnections()
    socket.emit('close-room', (response: CloseRoomResponse) => {
      setClosing(false)
      if (response.success) {
        message.success('房间已关闭')
        navigate('/', { replace: true })
      } else {
        message.error(response.message ?? '关闭房间失败')
      }
    })
  }, [socket, stop, cleanupPeerConnections, navigate])

  const handleClearAnnotations = useCallback(() => {
    if (!socket || !currentRoomId) return
    socket.emit(
      'clear-annotations',
      { roomId: currentRoomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success) message.error(response.message ?? '清空批注失败')
      }
    )
  }, [socket, currentRoomId])

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(`${window.location.origin}/room/${currentRoomId}`)
      .then(() => message.success('观看链接已复制'))
  }, [currentRoomId])

  const handleTogglePause = useCallback(() => {
    if (isPaused) resume()
    else pause()
  }, [isPaused, pause, resume])

  // 信令 channel（onJoinRequest 不在其中，单独订阅以保持 hook 通用性）
  useSignalingChannel({
    socket,
    onSignalAnswer: handleSignalAnswer,
    onSignalIceCandidate: handleSignalIceCandidate,
    onViewerReady: handleViewerReady,
    onViewerJoined: handleViewerJoined,
    onViewerLeft: handleViewerLeft,
    onRoomClosed: handleRoomClosed,
    onRoomModeChanged: handleRoomModeChanged,
  })

  // 房主端单独订阅 join-request（自动 approve-join），保持 useSignalingChannel 通用性
  useEffect(() => {
    if (!socket) return
    const handleJoinRequest = (data: { viewerSocketId: string }) => {
      socket.emit(
        'approve-join',
        { viewerSocketId: data.viewerSocketId },
        (response: { success: boolean; message?: string }) => {
          if (!response.success)
            message.error(response.message ?? '允许加入失败')
        }
      )
    }
    socket.on('join-request', handleJoinRequest)
    return () => void socket.off('join-request', handleJoinRequest)
  }, [socket])

  useEffect(() => {
    onStatsPeerConnectionChange?.(statsPeerConnection)
  }, [statsPeerConnection, onStatsPeerConnectionChange])

  // 同步本地共享状态到 roomStore，让 RoomLayout 据此切换 aspect-video
  useEffect(() => {
    setIsSharing(isSharing)
  }, [isSharing, setIsSharing])

  // 房主开始共享时广播 sharer-ready，通知房间内已加入的观众重新发送 viewer-ready，
  // 解决观众先加入等待、房主后开始共享时信令流程断链的问题。
  useEffect(() => {
    if (!isSharing || !socket || !currentRoomId) return
    if (shareMethod !== 'webrtc') return
    socket.emit(
      'sharer-ready',
      { roomId: currentRoomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success) {
          console.warn('[SharePage] sharer-ready failed:', response.message)
        }
      }
    )
  }, [isSharing, socket, currentRoomId, shareMethod])

  // 切换到 stream-push 子模式时强制标记为非 WebRTC 共享状态，
  // 让 RoomLayout 用 min-h-[480px] 布局而非 aspect-video。
  useEffect(() => {
    if (shareMethod === 'stream-push') {
      setIsSharing(false)
    }
  }, [shareMethod, setIsSharing])

  if (!currentRoomId) {
    return (
      <div
        className={cn('flex h-full items-center justify-center p-6', className)}
        style={style}
      >
        <Paragraph type="secondary">房间号不存在，请重新创建房间</Paragraph>
      </div>
    )
  }

  return (
    <div className={cn('relative h-full w-full', className)} style={style}>
      {/* 房主端子模式切换（WebRTC 共享 / OBS 推流） */}
      <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2">
        <SegmentedToggle
          options={[
            { value: 'webrtc', label: 'WebRTC 共享' },
            { value: 'stream-push', label: 'OBS 推流' },
          ]}
          value={shareMethod}
          onChange={handleShareMethodChange}
        />
      </div>

      {shareMethod === 'stream-push' ? (
        <div className="h-full w-full pt-16">
          <StreamPushPage
            roomId={currentRoomId}
            socket={socket}
            streamStatus={streamStatus}
          />
        </div>
      ) : isSharing ? (
        <>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-contain"
            style={{ opacity: isPaused ? 0.6 : 1 }}
          />
          <AnnotationLayer socket={socket} roomId={currentRoomId} readOnly />
          <SharingPausedOverlay visible={isPaused} />
          <ShareControlsBar
            isPaused={isPaused}
            connected={connected}
            viewerCount={viewerIds.length}
            connectionCount={connectionCount}
            closing={closing}
            onTogglePause={handleTogglePause}
            onCopyLink={handleCopy}
            onClearAnnotations={handleClearAnnotations}
            onClose={() => setConfirmClose(true)}
          />
        </>
      ) : (
        <div className="flex min-h-[480px] flex-col items-center justify-start gap-4 overflow-y-auto p-6 pt-20 text-center">
          <Paragraph type="secondary" className="m-0">
            房间号
          </Paragraph>
          <Text
            className="rounded px-3 py-1.5 font-mono text-2xl"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
          >
            {currentRoomId}
          </Text>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Tag color={connected ? 'success' : 'default'}>
              {connected ? '已连接' : '未连接'}
            </Tag>
          </div>
          <MediaSettingsCard
            frameRate={frameRate}
            maxBitrateMbps={maxBitrateMbps}
            shareSystemAudio={shareSystemAudio}
            shareMicrophone={shareMicrophone}
            isSharing={isSharing}
            onFrameRateChange={setFrameRate}
            onMaxBitrateChange={setMaxBitrateMbps}
            onShareSystemAudioChange={setShareSystemAudio}
            onShareMicrophoneChange={setShareMicrophone}
          />
          <Button
            variant="primary"
            icon={<Monitor className="h-5 w-5" />}
            onClick={start}
          >
            开始共享
          </Button>
          <Paragraph type="secondary" className="m-0 max-w-md text-xs">
            将链接发送给观看方，对方打开后即可自动加入房间观看。
          </Paragraph>
        </div>
      )}

      <ConfirmModal
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        onOk={() => {
          setConfirmClose(false)
          handleCloseRoom()
        }}
        onCancel={() => setConfirmClose(false)}
        title="结束共享"
        okText="确认结束"
        cancelText="取消"
      >
        结束共享将断开所有观众的连接并关闭房间，确定要结束吗？
      </ConfirmModal>
    </div>
  )
}

export default SharePage
