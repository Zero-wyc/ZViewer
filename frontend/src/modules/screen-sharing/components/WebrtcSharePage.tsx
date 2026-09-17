/**
 * WebRTC 屏幕共享房主端。
 *
 * 从 SharePage.tsx 中拆分，仅处理 WebRTC 子模式的房主逻辑：
 * - 本地媒体流采集（getDisplayMedia + 麦克风）
 * - 多 viewer PeerConnection 管理
 * - 信令通道订阅
 * - 本地预览播放器 + 批注层 + 控制栏
 *
 * SharePage 分发器根据 shareMethod 决定渲染本组件或 StreamPushPage。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Monitor, Copy, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { ConfirmModal } from '@/components/ui/Modal'
import { LiveArtPlayer } from '@/modules/art-player'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { AnnotationLayer } from '@/components/AnnotationLayer'
import { message } from '@/components/ui/message'
import { useLocalMediaStream } from '../hooks/useLocalMediaStream'
import { useHostPeerConnections } from '../hooks/useHostPeerConnections'
import { useSignalingChannel } from '../hooks/useSignalingChannel'
import { useP2PTunnel } from '@/modules/p2p'
import type { P2PStatus } from '@/modules/p2p/types'
import { MediaSettingsCard } from './MediaSettingsCard'
import { ShareControlsBar } from './ShareControlsBar'
import { SharingPausedOverlay } from './SharingPausedOverlay'
import type { CloseRoomResponse, RoomModeChangedPayload } from '../types'

/** P2P 状态快照，由 WebrtcSharePage 提升到 RoomPage 供 RoomLayout 使用 */
export interface P2PStateSnapshot {
  enabled: boolean
  pc: RTCPeerConnection | null
  status: P2PStatus
  fallbackNotice: boolean
  /** 切换 P2P 开关（enabled=true 启用，false 禁用） */
  toggle: (enabled: boolean) => void
}

interface WebrtcSharePageProps {
  className?: string
  style?: React.CSSProperties
  onStatsPeerConnectionChange?: (pc: RTCPeerConnection | null) => void
  /** P2P 状态变化回调，提升到 RoomPage 供 RoomLayout 的 SharingStatusPanel 使用 */
  onP2PStateChange?: (state: P2PStateSnapshot) => void
}

function WebrtcSharePage({
  className,
  style,
  onStatsPeerConnectionChange,
  onP2PStateChange,
}: WebrtcSharePageProps) {
  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const setMode = useRoomStore((state) => state.setMode)
  const setIsSharing = useRoomStore((state) => state.setIsSharing)
  const roomId = useRoomStore((state) => state.roomId)
  const currentRoomId = roomId ?? ''

  const [frameRate, setFrameRate] = useState(30)
  const [maxBitrateMbps, setMaxBitrateMbps] = useState(8)
  const [shareSystemAudio, setShareSystemAudio] = useState(false)
  const [shareMicrophone, setShareMicrophone] = useState(false)
  const [closing, setClosing] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  // 帧率切换时自动调整推荐码率（仅在未共享时）
  // 码率不足是 60fps 降帧的首要原因，自动提升到推荐值避免用户手动调整
  const handleFrameRateChange = useCallback((next: number) => {
    setFrameRate(next)
    // 推荐码率：15fps→4, 30fps→8, 45fps→12, 60fps→16
    const recommended = Math.max(2, Math.round(next * 0.267))
    setMaxBitrateMbps((prev) => {
      // 仅当当前码率低于推荐值时自动提升，不覆盖用户主动设置的高码率
      if (prev < recommended) return recommended
      return prev
    })
  }, [])

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const [localVideoEl, setLocalVideoEl] = useState<HTMLVideoElement | null>(
    null
  )
  const handleLocalVideoReady = useCallback((node: HTMLVideoElement | null) => {
    localVideoRef.current = node
    setLocalVideoEl(node)
  }, [])
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

  useEffect(() => {
    if (localVideoEl && stream && localVideoEl.srcObject !== stream) {
      // eslint-disable-next-line react-hooks/immutability -- 修改 DOM 元素属性，非 React 状态
      localVideoEl.srcObject = stream
      void localVideoEl.play().catch(() => {})
    }
  }, [localVideoEl, stream])

  const handleRoomClosed = useCallback(() => {
    // 提示与退房导航由 RoomPage 统一处理（避免与页面级 room-closed
    // 响应重复弹 toast / 导航冲突）；这里只做本组件的即时清理：
    // 停掉本地共享流（摄像头/屏幕 track）与所有观众 PC。
    setClosing(true)
    stop()
    cleanupPeerConnections()
  }, [stop, cleanupPeerConnections])

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

  const handleRefresh = useCallback(async () => {
    stop()
    cleanupPeerConnections()
    await start()
  }, [stop, cleanupPeerConnections, start])

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

  // P2P 直连隧道（房主为 sender，使用第一个观众作为对端）
  const [p2pFallbackNotice, setP2pFallbackNotice] = useState(false)
  const firstViewerId = viewerIds[0] ?? null
  const { enableP2P, disableP2P, p2pEnabled, p2pPC, p2pStatus } = useP2PTunnel({
    socket,
    roomId: currentRoomId,
    localStream: stream,
    role: 'sender',
    remotePeerId: firstViewerId,
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

  // 房主切换 P2P 开关：触发 hook enable/disable，并广播给房间内其他成员
  const handleToggleP2P = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        void enableP2P()
      } else {
        disableP2P()
      }
      if (socket && currentRoomId) {
        socket.emit('p2p-mode-change', { roomId: currentRoomId, enabled })
      }
    },
    [enableP2P, disableP2P, socket, currentRoomId]
  )

  // 接收房间内 P2P 模式广播（观众端同步开关状态）
  useEffect(() => {
    if (!socket) return
    const handleP2PModeChange = (data: {
      roomId: string
      enabled: boolean
    }) => {
      if (!currentRoomId || data.roomId !== currentRoomId) return
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
  }, [socket, currentRoomId, enableP2P, disableP2P])

  // 上报 P2P 状态到父组件（含 toggle 方法，供 SharingStatusPanel 开关调用）
  useEffect(() => {
    onP2PStateChange?.({
      enabled: p2pEnabled,
      pc: p2pPC,
      status: p2pStatus,
      fallbackNotice: p2pFallbackNotice,
      toggle: handleToggleP2P,
    })
  }, [
    p2pEnabled,
    p2pPC,
    p2pStatus,
    p2pFallbackNotice,
    handleToggleP2P,
    onP2PStateChange,
  ])

  useEffect(() => {
    onStatsPeerConnectionChange?.(statsPeerConnection)
  }, [statsPeerConnection, onStatsPeerConnectionChange])

  useEffect(() => {
    setIsSharing(isSharing)
  }, [isSharing, setIsSharing])

  // 房主开始共享时广播 sharer-ready
  useEffect(() => {
    if (!isSharing || !socket || !currentRoomId) return
    socket.emit(
      'sharer-ready',
      { roomId: currentRoomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success) {
          console.warn(
            '[WebrtcSharePage] sharer-ready failed:',
            response.message
          )
        }
      }
    )
  }, [isSharing, socket, currentRoomId])

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
      {isSharing ? (
        <>
          <div
            className="h-full w-full"
            style={{ opacity: isPaused ? 0.6 : 1 }}
          >
            <LiveArtPlayer
              muted
              showControls={false}
              onVideoReady={handleLocalVideoReady}
            />
          </div>
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
            onRefresh={handleRefresh}
          />
        </>
      ) : (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-5 overflow-y-auto p-6 pt-20">
          <div
            className="glass-card w-full max-w-sm rounded-2xl border p-6 shadow-sm"
            style={{
              borderColor:
                'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
              backgroundColor: 'var(--glass-bg)',
              backdropFilter: 'blur(var(--glass-blur-strong))',
              WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
            }}
          >
            <div className="mb-5 flex items-center justify-between">
              <Space align="center" size="sm">
                <Monitor className="h-5 w-5 text-[var(--md-sys-color-primary)]" />
                <Text className="text-base font-semibold">WebRTC 屏幕共享</Text>
              </Space>
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
              onFrameRateChange={handleFrameRateChange}
              onMaxBitrateChange={setMaxBitrateMbps}
              onShareSystemAudioChange={setShareSystemAudio}
              onShareMicrophoneChange={setShareMicrophone}
            />

            <Button
              variant="primary"
              className="mt-5 w-full"
              icon={<Monitor className="h-5 w-5" />}
              onClick={start}
              loading={starting}
              disabled={starting || closing}
            >
              {starting ? '正在请求权限...' : '开始共享'}
            </Button>
          </div>

          {inIframe && (
            <div
              className="w-full max-w-sm rounded-xl border px-4 py-3 text-xs"
              style={{
                borderColor: 'var(--md-sys-color-outline-variant)',
                backgroundColor: 'var(--md-sys-color-tertiary-container)',
              }}
            >
              <Paragraph type="secondary" className="m-0 mb-2 text-xs">
                检测到当前页面运行在嵌入式预览（iframe）环境中，屏幕共享功能可能被浏览器限制。建议在新窗口中打开本页面：
              </Paragraph>
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={handleOpenInNewWindow}
              >
                在新窗口打开
              </Button>
            </div>
          )}

          {mediaError && (
            <div
              className="relative w-full max-w-sm rounded-xl border px-4 py-3 text-xs"
              style={{
                borderColor: 'var(--md-sys-color-error-container)',
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

          <Paragraph
            type="secondary"
            className="!text-white m-0 max-w-sm text-center text-xs"
          >
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
    </div>
  )
}

export default WebrtcSharePage
