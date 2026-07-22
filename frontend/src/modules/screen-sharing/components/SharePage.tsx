import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Monitor, Copy, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { ConfirmModal } from '@/components/ui/Modal'
import { RequestNotification } from '@/components/ui/RequestNotification'
import type { RequestNotificationItem } from '@/components/ui/RequestNotification'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { AnnotationLayer } from '@/components/AnnotationLayer'
import { useLocalMediaStream } from '../hooks/useLocalMediaStream'
import { useHostPeerConnections } from '../hooks/useHostPeerConnections'
import { useSignalingChannel } from '../hooks/useSignalingChannel'
import { useStreamStatus, useShareMethod } from '../hooks/useStreamPush'
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
  const streamStatus = useStreamStatus(socket, currentRoomId)
  const { shareMethod, updateShareMethod } = useShareMethod(
    socket,
    currentRoomId,
    true,
  )

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
  // 观众加入审批：投屏模式下与一起看模式行为一致，弹通知卡由房主手动同意/拒绝
  const [confirmJoin, setConfirmJoin] = useState<{
    viewerSocketId: string
  } | null>(null)

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  // onStreamEnded 需引用下方 hook 返回的 stop/cleanupPeerConnections，用 ref 转发避免循环依赖
  const handleStreamEndedRef = useRef<() => void>(() => {})

  const {
    stream,
    micStream,
    isSharing,
    starting,
    isPaused,
    error: mediaError,
    start,
    stop,
    pause,
    resume,
  } = useLocalMediaStream({
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

  // 结束共享：仅停止本地媒体流与 PeerConnection，不关闭房间。
  // 房主回到未共享状态（显示房间号和「开始共享」按钮），可重新开始共享或切换到一起看模式。
  // 关闭房间由导航栏返回 / 时由 RoomLayout defaultBack 触发 close-room 事件完成。
  const handleStopSharing = useCallback(() => {
    stop()
    cleanupPeerConnections()
  }, [stop, cleanupPeerConnections])

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

  const handleCopyError = useCallback(() => {
    if (!mediaError) return
    navigator.clipboard
      .writeText(mediaError)
      .then(() => message.success('错误详情已复制，可粘贴给管理员'))
      .catch(() => message.error('复制失败，请手动选择文本复制'))
  }, [mediaError])

  // 检测是否在 iframe 中（如 IDE 内置预览），用于显示「在新窗口打开」按钮
  const inIframe = (() => {
    try {
      return window.self !== window.top
    } catch {
      return true
    }
  })()

  const handleOpenInNewWindow = useCallback(() => {
    window.open(window.location.href, '_blank', 'noopener,noreferrer')
  }, [])

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

  // 房主端单独订阅 join-request：弹通知卡由房主手动同意/拒绝（与一起看模式行为一致）
  useEffect(() => {
    if (!socket) return
    const handleJoinRequest = (data: { viewerSocketId: string }) => {
      setConfirmJoin({ viewerSocketId: data.viewerSocketId })
    }
    socket.on('join-request', handleJoinRequest)
    return () => void socket.off('join-request', handleJoinRequest)
  }, [socket])

  const handleApproveJoin = useCallback(() => {
    if (!confirmJoin || !socket) return
    const viewerSocketId = confirmJoin.viewerSocketId
    socket.emit(
      'approve-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.success('已允许加入')
        } else {
          message.error(response.message ?? '允许加入失败')
        }
      }
    )
    setConfirmJoin(null)
  }, [confirmJoin, socket])

  const handleRejectJoin = useCallback(() => {
    if (!confirmJoin || !socket) return
    const viewerSocketId = confirmJoin.viewerSocketId
    socket.emit(
      'reject-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.info('已拒绝加入')
        } else {
          message.error(response.message ?? '拒绝失败')
        }
      }
    )
    setConfirmJoin(null)
  }, [confirmJoin, socket])

  // 房主端：将观众加入请求汇总为右下角通知列表（与 WatchTogetherPanel 行为一致）
  const joinRequestNotifications: RequestNotificationItem[] = []
  if (confirmJoin) {
    joinRequestNotifications.push({
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

  const handleCloseJoinNotification = useCallback((id: string) => {
    if (id === 'join') setConfirmJoin(null)
  }, [])

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
          <StreamPushPage roomId={currentRoomId} />
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
            loading={starting}
            disabled={starting || closing}
          >
            {starting ? '正在请求权限...' : '开始共享'}
          </Button>
          {inIframe && (
            <div
              className="m-0 max-w-md rounded px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--md-sys-color-tertiary-container)',
              }}
            >
              <Paragraph type="secondary" className="m-0 mb-2 text-xs">
                检测到当前页面运行在嵌入式预览（iframe）环境中，屏幕共享功能可能被浏览器限制。建议在新窗口中打开本页面：
              </Paragraph>
              <Button
                variant="secondary"
                size="sm"
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={handleOpenInNewWindow}
              >
                在新窗口打开
              </Button>
            </div>
          )}
          {mediaError && (
            <div
              className="relative m-0 max-w-md rounded px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--md-sys-color-error-container)',
              }}
            >
              <Paragraph
                type="danger"
                className="m-0 whitespace-pre-line pr-8 text-xs"
              >
                {mediaError}
              </Paragraph>
              <button
                type="button"
                onClick={handleCopyError}
                className="absolute right-2 top-2 rounded p-1 opacity-70 hover:opacity-100"
                style={{
                  color: 'var(--md-sys-color-on-error-container)',
                  backgroundColor: 'transparent',
                }}
                title="复制错误详情"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
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
          handleStopSharing()
        }}
        onCancel={() => setConfirmClose(false)}
        title="结束共享"
        okText="确认结束"
        cancelText="取消"
      >
        结束共享将停止屏幕共享并断开观众连接，房间仍会保留，您可以重新开始共享或切换到一起看模式。
      </ConfirmModal>

      <RequestNotification
        items={joinRequestNotifications}
        onClose={handleCloseJoinNotification}
      />
    </div>
  )
}

export default SharePage
