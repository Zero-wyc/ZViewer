import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Copy,
  Power,
  Monitor,
  PauseCircle,
  PlayCircle,
  Settings2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Paragraph, Text } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { InputNumber } from '@/components/ui/InputNumber'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { ConfirmModal } from '@/components/ui/Modal'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { ConnectionStatsPanel } from '@/components/ConnectionStatsPanel'
import { DanmakuLayer } from '@/components/DanmakuLayer'
import { AnnotationLayer } from '@/components/AnnotationLayer'

interface SharePageProps {
  className?: string
  style?: React.CSSProperties
}

interface SignalPayload<T> {
  from: string
  data: T
}

interface ApproveJoinResponse {
  success: boolean
  message?: string
}

interface CloseRoomResponse {
  success: boolean
  message?: string
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

const FRAME_RATE_OPTIONS = [
  { label: '30 fps', value: 30 },
  { label: '60 fps', value: 60 },
  { label: '90 fps', value: 90 },
  { label: '120 fps', value: 120 },
  { label: '144 fps', value: 144 },
  { label: '240 fps', value: 240 },
]

function SharePage({ className, style }: SharePageProps) {
  const { roomId } = useParams<{ roomId?: string }>()
  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const setMode = useRoomStore((state) => state.setMode)
  const currentRoomId = roomId ?? ''
  const [closing, setClosing] = useState(false)
  const [isSharing, setIsSharing] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [connectionCount, setConnectionCount] = useState(0)
  const [viewerIds, setViewerIds] = useState<string[]>([])
  const [confirmClose, setConfirmClose] = useState(false)

  const [frameRate, setFrameRate] = useState<number>(30)
  const [maxBitrateMbps, setMaxBitrateMbps] = useState<number>(8)
  const [shareSystemAudio, setShareSystemAudio] = useState(false)
  const [shareMicrophone, setShareMicrophone] = useState(false)
  const [statsPeerConnection, setStatsPeerConnection] =
    useState<RTCPeerConnection | null>(null)

  const localStreamRef = useRef<MediaStream | null>(null)
  const [localStreamState, setLocalStreamState] = useState<MediaStream | null>(
    null
  )
  const micStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const readyViewerIdsRef = useRef<Set<string>>(new Set())

  const updateConnectionCount = useCallback(() => {
    setConnectionCount(peerConnectionsRef.current.size)
  }, [])

  const cleanupConnections = useCallback(() => {
    peerConnectionsRef.current.forEach((pc) => {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
    })
    peerConnectionsRef.current.clear()
    readyViewerIdsRef.current.clear()
    setStatsPeerConnection(null)
    updateConnectionCount()
  }, [updateConnectionCount])

  const stopLocalStream = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    setLocalStreamState(null)
    micStreamRef.current?.getTracks().forEach((track) => track.stop())
    micStreamRef.current = null
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
  }, [])

  const createPeerConnection = useCallback(
    (viewerSocketId: string) => {
      const stream = localStreamRef.current
      if (!stream) {
        message.warning('尚未开始屏幕共享')
        return null
      }

      if (peerConnectionsRef.current.has(viewerSocketId)) {
        return peerConnectionsRef.current.get(viewerSocketId) ?? null
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      peerConnectionsRef.current.set(viewerSocketId, pc)
      setStatsPeerConnection((prev) => prev ?? pc)
      updateConnectionCount()

      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream)
      })

      const micStream = micStreamRef.current
      if (micStream) {
        micStream.getAudioTracks().forEach((track) => {
          pc.addTrack(track, micStream)
        })
      }

      // 配置编码器：优先保持帧率、设置最大帧率与码率，使视频流更像直播推流
      const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (videoSender) {
        try {
          const params = videoSender.getParameters()
          if (!params.encodings) params.encodings = [{}]
          params.encodings[0].maxBitrate = maxBitrateMbps * 1000 * 1000
          params.encodings[0].maxFramerate = frameRate
          params.degradationPreference = 'maintain-framerate'
          void videoSender.setParameters(params)
        } catch (err) {
          console.warn('[SharePage] set sender parameters error:', err)
        }
      }

      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit('signal-ice-candidate', {
            to: viewerSocketId,
            data: event.candidate,
          })
        }
      }

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'closed' ||
          pc.connectionState === 'disconnected'
        ) {
          console.log(
            `[SharePage] connection state for ${viewerSocketId}:`,
            pc.connectionState
          )
        }
      }

      return pc
    },
    [socket, updateConnectionCount, maxBitrateMbps, frameRate]
  )

  const createAndSendOffer = useCallback(
    async (viewerSocketId: string) => {
      const pc = createPeerConnection(viewerSocketId)
      if (!pc || !socket) return

      // 避免在 signalingState 非 stable 时重复创建 offer
      if (pc.signalingState !== 'stable') {
        console.log(
          '[SharePage] skip offer, pc not stable:',
          pc.signalingState
        )
        return
      }

      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        socket.emit('signal-offer', {
          to: viewerSocketId,
          data: offer,
        })
      } catch (err) {
        console.error('[SharePage] create offer error:', err)
        message.error('创建 WebRTC 连接失败')
      }
    },
    [socket, createPeerConnection]
  )

  const handleStartSharing = async () => {
    try {
      const useTestStream =
        new URLSearchParams(window.location.search).get('testStream') === 'true'

      let stream: MediaStream
      if (useTestStream) {
        message.info('测试模式：使用摄像头画面代替屏幕共享')
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            frameRate: { ideal: frameRate, max: frameRate },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: shareSystemAudio,
        })
      } else {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            // 优先保持目标帧率；部分浏览器/显卡可能仍限制为 30/60，获取后再 applyConstraints 尽量逼近
            frameRate: { ideal: frameRate, max: frameRate },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: shareSystemAudio,
        })
      }

      if (shareMicrophone) {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          })
          micStreamRef.current = micStream
        } catch (err) {
          console.error('[SharePage] getUserMedia mic error:', err)
          message.warning('无法获取麦克风权限，将仅共享屏幕')
        }
      }

      localStreamRef.current = stream
      setLocalStreamState(stream)
      setIsSharing(true)
      setIsPaused(false)

      // 尝试将视频轨道设为运动/高帧率模式，并应用目标帧率
      stream.getVideoTracks().forEach((track) => {
        track.contentHint = 'motion'
        try {
          void track.applyConstraints({
            frameRate: { ideal: frameRate, max: frameRate },
          })
        } catch (err) {
          console.warn('[SharePage] applyConstraints frameRate error:', err)
        }
      })

      stream.getVideoTracks().forEach((track) => {
        console.log(
          '[SharePage] video track:',
          track.label,
          'enabled:',
          track.enabled,
          'muted:',
          track.muted
        )
        track.addEventListener('unmute', () => {
          console.log('[SharePage] video track unmuted')
        })
        track.addEventListener('mute', () => {
          console.warn('[SharePage] video track muted')
        })
      })

      // 为已加入且已就绪的观看者立即创建并发送 offer
      readyViewerIdsRef.current.forEach((viewerSocketId) => {
        void createAndSendOffer(viewerSocketId)
      })

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopLocalStream()
        cleanupConnections()
        setIsSharing(false)
        setIsPaused(false)
        if (socket) {
          socket.emit('close-room', (response: CloseRoomResponse) => {
            if (response.success) {
              message.success('房间已关闭')
              navigate('/', { replace: true })
            } else {
              message.error(response.message ?? '关闭房间失败')
            }
          })
        }
      })
    } catch (err) {
      console.error('[SharePage] getDisplayMedia error:', err)
      message.error('无法获取屏幕共享权限')
    }
  }

  const handlePauseSharing = useCallback(() => {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = false
    })
    setIsPaused(true)
  }, [])

  const handleResumeSharing = useCallback(() => {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = true
    })
    setIsPaused(false)
  }, [])

  const handleCloseRoom = useCallback(() => {
    if (!socket) return
    setClosing(true)
    stopLocalStream()
    cleanupConnections()
    setIsSharing(false)
    setIsPaused(false)
    socket.emit('close-room', (response: CloseRoomResponse) => {
      setClosing(false)
      if (response.success) {
        message.success('房间已关闭')
        navigate('/', { replace: true })
      } else {
        message.error(response.message ?? '关闭房间失败')
      }
    })
  }, [socket, stopLocalStream, cleanupConnections, navigate])

  const handleClearAnnotations = useCallback(() => {
    if (!socket || !currentRoomId) return
    socket.emit(
      'clear-annotations',
      { roomId: currentRoomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success) {
          message.error(response.message ?? '清空批注失败')
        }
      }
    )
  }, [socket, currentRoomId])

  useEffect(() => {
    if (!socket) return

    const handleJoinRequest = (data: { viewerSocketId: string }) => {
      // 移除确认弹窗，自动允许观看者加入
      if (!socket) return
      socket.emit(
        'approve-join',
        { viewerSocketId: data.viewerSocketId },
        (response: ApproveJoinResponse) => {
          if (!response.success) {
            message.error(response.message ?? '允许加入失败')
          }
        }
      )
    }

    const handleSignalAnswer = async (
      data: SignalPayload<RTCSessionDescriptionInit>
    ) => {
      const pc = peerConnectionsRef.current.get(data.from)
      if (!pc) return
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.data))
      } catch (err) {
        console.error('[SharePage] set remote description error:', err)
        message.error('处理远端应答失败')
      }
    }

    const handleSignalIceCandidate = async (
      data: SignalPayload<RTCIceCandidateInit>
    ) => {
      const pc = peerConnectionsRef.current.get(data.from)
      if (!pc) return
      try {
        await pc.addIceCandidate(new RTCIceCandidate(data.data))
      } catch (err) {
        console.error('[SharePage] add ice candidate error:', err)
        message.error('处理网络候选失败')
      }
    }

    const handleRoomClosed = (data: { roomId: string }) => {
      message.warning(`房间 ${data.roomId} 已关闭`)
      setClosing(true)
      stopLocalStream()
      cleanupConnections()
      setIsSharing(false)
      setIsPaused(false)
      setViewerIds([])
      setTimeout(() => navigate('/', { replace: true }), 1500)
    }

    const handleRoomModeChanged = (data: {
      mode: 'screen-share' | 'watch-together'
    }) => {
      setMode(data.mode)
      if (data.mode === 'watch-together') {
        stopLocalStream()
        cleanupConnections()
        setIsSharing(false)
        setIsPaused(false)
      }
    }

    const handleViewerJoined = (data: { viewerSocketId: string }) => {
      message.success('有新的观看者加入房间')
      setViewerIds((prev) =>
        prev.includes(data.viewerSocketId)
          ? prev
          : [...prev, data.viewerSocketId]
      )
    }

    const handleViewerReady = (data: { from: string }) => {
      const viewerSocketId = data.from
      console.log('[SharePage] viewer ready:', viewerSocketId)
      readyViewerIdsRef.current.add(viewerSocketId)
      // 观看端已创建 RTCPeerConnection，此时发送 offer 才不会被丢弃
      if (localStreamRef.current) {
        void createAndSendOffer(viewerSocketId)
      }
    }

    const handleViewerLeft = (data: { viewerSocketId: string }) => {
      const pc = peerConnectionsRef.current.get(data.viewerSocketId)
      if (pc) {
        pc.close()
        peerConnectionsRef.current.delete(data.viewerSocketId)
        updateConnectionCount()
        const nextPc = peerConnectionsRef.current.values().next().value as
          | RTCPeerConnection
          | undefined
        setStatsPeerConnection((prev) =>
          prev === pc ? (nextPc ?? null) : prev
        )
      }
      readyViewerIdsRef.current.delete(data.viewerSocketId)
      setViewerIds((prev) => prev.filter((id) => id !== data.viewerSocketId))
    }

    socket.on('join-request', handleJoinRequest)
    socket.on('signal-answer', handleSignalAnswer)
    socket.on('signal-ice-candidate', handleSignalIceCandidate)
    socket.on('room-closed', handleRoomClosed)
    socket.on('room-mode-changed', handleRoomModeChanged)
    socket.on('viewer-joined', handleViewerJoined)
    socket.on('viewer-ready', handleViewerReady)
    socket.on('viewer-left', handleViewerLeft)

    return () => {
      socket.off('join-request', handleJoinRequest)
      socket.off('signal-answer', handleSignalAnswer)
      socket.off('signal-ice-candidate', handleSignalIceCandidate)
      socket.off('room-closed', handleRoomClosed)
      socket.off('room-mode-changed', handleRoomModeChanged)
      socket.off('viewer-joined', handleViewerJoined)
      socket.off('viewer-ready', handleViewerReady)
      socket.off('viewer-left', handleViewerLeft)
    }
  }, [
    socket,
    navigate,
    createAndSendOffer,
    stopLocalStream,
    cleanupConnections,
    updateConnectionCount,
    setMode,
  ])

  useEffect(() => {
    const video = localVideoRef.current
    const stream = localStreamState
    if (!video || !stream) return

    video.srcObject = stream
    video
      .play()
      .catch((err) =>
        console.error('[SharePage] local video play error:', err)
      )
  }, [localStreamState])

  useEffect(() => {
    return () => {
      stopLocalStream()
      cleanupConnections()
      setViewerIds([])
    }
  }, [stopLocalStream, cleanupConnections])

  const handleCopy = () => {
    const url = `${window.location.origin}/room/${currentRoomId}`
    navigator.clipboard.writeText(url).then(() => {
      message.success('观看链接已复制')
    })
  }

  const mediaSettingsCard = (
    <Card className="w-full max-w-md text-left">
      <Space direction="vertical" className="w-full" size="sm">
        <Space align="center" size="sm">
          <Settings2 className="h-4 w-4 text-[var(--md-sys-color-on-surface-variant)]" />
          <Text className="font-medium">媒体设置</Text>
        </Space>
        <div className="text-left">
          <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
            帧率
          </label>
          <Select
            options={FRAME_RATE_OPTIONS}
            value={String(frameRate)}
            onChange={(value) => setFrameRate(Number(value))}
            disabled={isSharing}
          />
        </div>
        <div className="text-left">
          <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
            最大码率（Mbps）
          </label>
          <InputNumber
            min={0.5}
            max={50}
            step={0.5}
            value={maxBitrateMbps}
            onChange={(value) =>
              setMaxBitrateMbps(value === undefined ? 8 : value)
            }
            disabled={isSharing}
          />
        </div>
        <Switch
          label="共享系统音频"
          checked={shareSystemAudio}
          onChange={(e) => setShareSystemAudio(e.target.checked)}
          disabled={isSharing}
        />
        <Switch
          label="共享麦克风"
          checked={shareMicrophone}
          onChange={(e) => setShareMicrophone(e.target.checked)}
          disabled={isSharing}
        />
        {isSharing && (
          <Paragraph type="secondary" className="m-0 text-xs">
            共享期间无法修改媒体设置，请先结束共享。
          </Paragraph>
        )}
      </Space>
    </Card>
  )

  if (!currentRoomId) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center p-6',
          className
        )}
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
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-contain"
            style={{ opacity: isPaused ? 0.6 : 1 }}
          />
          <DanmakuLayer socket={socket} />
          <AnnotationLayer
            socket={socket}
            roomId={currentRoomId}
            readOnly
          />
          {isPaused && (
            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
              <Paragraph className="m-0 text-white">
                共享已暂停，观众画面将冻结
              </Paragraph>
            </div>
          )}

          {/* 底部控制栏 */}
          <div
            className="absolute bottom-0 left-0 right-0 z-20 p-3"
            style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
          >
            <Space className="w-full" wrap>
              {isPaused ? (
                <Button
                  variant="primary"
                  icon={<PlayCircle className="h-5 w-5" />}
                  onClick={handleResumeSharing}
                >
                  恢复共享
                </Button>
              ) : (
                <Button
                  icon={<PauseCircle className="h-5 w-5" />}
                  onClick={handlePauseSharing}
                >
                  暂停共享
                </Button>
              )}
              <Button
                variant="secondary"
                icon={<Copy className="h-5 w-5" />}
                onClick={handleCopy}
              >
                复制观看链接
              </Button>
              <Button variant="ghost" onClick={handleClearAnnotations}>
                清空批注
              </Button>
              <Button
                variant="danger"
                icon={<Power className="h-5 w-5" />}
                loading={closing}
                onClick={() => setConfirmClose(true)}
              >
                结束共享
              </Button>
            </Space>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Tag color={connected ? 'success' : 'default'}>
                {connected ? '已连接' : '未连接'}
              </Tag>
              <Tag color="primary">共享中</Tag>
              {isPaused && <Tag color="warning">已暂停</Tag>}
              {!isPaused && <Tag color="cyan">传输中</Tag>}
              <Tag color="purple">
                在线观众：{viewerIds.length} / {connectionCount} 连接
              </Tag>
            </div>
            <ConnectionStatsPanel pc={statsPeerConnection} mode="server" />
          </div>
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
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
          {mediaSettingsCard}
          <Button
            variant="primary"
            icon={<Monitor className="h-5 w-5" />}
            onClick={handleStartSharing}
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
