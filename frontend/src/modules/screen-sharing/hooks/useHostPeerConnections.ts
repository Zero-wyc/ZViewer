import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { ICE_SERVERS } from '../constants'
import type {
  SignalPayload,
  ViewerEventPayload,
  ViewerReadyPayload,
} from '../types'

interface UseHostPeerConnectionsOptions {
  socket: Socket | null
  /** 本地 MediaStream（来自 useLocalMediaStream） */
  localStream: MediaStream | null
  /** 麦克风 MediaStream（可选，来自 useLocalMediaStream） */
  micStream: MediaStream | null
  /** 帧率配置（用于 sender 参数） */
  frameRate: number
  /** 最大码率 Mbps（用于 sender 参数） */
  maxBitrateMbps: number
  /** 观众加入通知（用于 UI 显示） */
  onViewerJoined?: (data: ViewerEventPayload) => void
  /** 观众离开通知（用于 UI 显示） */
  onViewerLeft?: (data: ViewerEventPayload) => void
}

interface UseHostPeerConnectionsResult {
  /** 当前活跃的 PeerConnection 数量 */
  connectionCount: number
  /** 当前用于统计的 PeerConnection（取第一个） */
  statsPeerConnection: RTCPeerConnection | null
  /** 当前在线观众 socket id 列表 */
  viewerIds: string[]
  /** 处理观众 signal-answer 事件 */
  handleSignalAnswer: (data: SignalPayload<RTCSessionDescriptionInit>) => void
  /** 处理观众 signal-ice-candidate 事件 */
  handleSignalIceCandidate: (data: SignalPayload<RTCIceCandidateInit>) => void
  /** 处理观众 viewer-ready 事件（发送 offer） */
  handleViewerReady: (data: ViewerReadyPayload) => void
  /** 处理观众 viewer-joined 事件（仅记录） */
  handleViewerJoined: (data: ViewerEventPayload) => void
  /** 处理观众 viewer-left 事件（清理 PC） */
  handleViewerLeft: (data: ViewerEventPayload) => void
  /** 清理所有 PC（停止共享时调用） */
  cleanup: () => void
}

/**
 * 房主端多 viewer PeerConnection 管理 hook。
 *
 * 负责：
 * - 为每个 viewer 创建/复用 RTCPeerConnection
 * - 处理信令 answer / ice-candidate / viewer-ready / viewer-joined / viewer-left
 * - 维护 connectionCount / statsPeerConnection / viewerIds 响应式状态
 * - 提供 cleanup 在停止共享或房间关闭时统一关闭所有 PC
 *
 * 不负责：getDisplayMedia（由 useLocalMediaStream 处理）、socket 事件订阅
 * （由 useSignalingChannel 处理）。
 */
export function useHostPeerConnections(
  options: UseHostPeerConnectionsOptions
): UseHostPeerConnectionsResult {
  const {
    socket,
    localStream,
    micStream,
    frameRate,
    maxBitrateMbps,
    onViewerJoined,
    onViewerLeft,
  } = options

  const [connectionCount, setConnectionCount] = useState(0)
  const [statsPeerConnection, setStatsPeerConnection] =
    useState<RTCPeerConnection | null>(null)
  const [viewerIds, setViewerIds] = useState<string[]>([])

  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const readyViewerIdsRef = useRef<Set<string>>(new Set())
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(
    new Map()
  )

  const updateConnectionCount = useCallback(() => {
    setConnectionCount(peerConnectionsRef.current.size)
  }, [])

  const createPeerConnection = useCallback(
    (viewerSocketId: string) => {
      if (!localStream) {
        message.warning('尚未开始屏幕共享')
        return null
      }

      if (peerConnectionsRef.current.has(viewerSocketId)) {
        const existing = peerConnectionsRef.current.get(viewerSocketId)
        if (
          existing &&
          existing.connectionState !== 'closed' &&
          existing.signalingState !== 'closed'
        ) {
          return existing
        }
        existing?.close()
        peerConnectionsRef.current.delete(viewerSocketId)
        pendingIceCandidatesRef.current.delete(viewerSocketId)
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      peerConnectionsRef.current.set(viewerSocketId, pc)
      setStatsPeerConnection((prev) => prev ?? pc)
      updateConnectionCount()

      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream)
      })

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
          console.warn(
            '[useHostPeerConnections] set sender parameters error:',
            err
          )
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
        console.log(
          `[useHostPeerConnections] connection state for ${viewerSocketId}:`,
          pc.connectionState
        )
      }

      return pc
    },
    [
      localStream,
      micStream,
      socket,
      frameRate,
      maxBitrateMbps,
      updateConnectionCount,
    ]
  )

  const createAndSendOffer = useCallback(
    async (viewerSocketId: string) => {
      const pc = createPeerConnection(viewerSocketId)
      if (!pc || !socket) return

      // 避免在 signalingState 非 stable 时重复创建 offer
      if (pc.signalingState !== 'stable') {
        console.log(
          '[useHostPeerConnections] skip offer, pc not stable:',
          pc.signalingState
        )
        return
      }

      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        console.log('[useHostPeerConnections] sending offer to', viewerSocketId)
        socket.emit('signal-offer', {
          to: viewerSocketId,
          data: offer,
        })
      } catch (err) {
        console.error('[useHostPeerConnections] create offer error:', err)
        message.error('创建 WebRTC 连接失败')
      }
    },
    [socket, createPeerConnection]
  )

  const handleViewerReady = useCallback(
    (data: ViewerReadyPayload) => {
      const viewerSocketId = data.from
      console.log('[useHostPeerConnections] viewer ready:', viewerSocketId)
      readyViewerIdsRef.current.add(viewerSocketId)
      // 观看端已创建 RTCPeerConnection，此时发送 offer 才不会被丢弃
      if (localStream) {
        void createAndSendOffer(viewerSocketId)
      }
    },
    [localStream, createAndSendOffer]
  )

  // 房主开始共享（localStream 由 null 变为非 null）时，给所有已 ready 但尚未建立 PC 的观众补发 offer。
  // 观众可能在房主开始共享前就 join-approved 并 emit viewer-ready，此时 localStream 为 null 导致 offer 未发送。
  useEffect(() => {
    if (!localStream) return
    for (const viewerSocketId of readyViewerIdsRef.current) {
      if (!peerConnectionsRef.current.has(viewerSocketId)) {
        console.log(
          '[useHostPeerConnections] resend offer to ready viewer after stream start:',
          viewerSocketId
        )
        void createAndSendOffer(viewerSocketId)
      }
    }
  }, [localStream, createAndSendOffer])

  const handleViewerJoined = useCallback(
    (data: ViewerEventPayload) => {
      message.success('有新的观看者加入房间')
      setViewerIds((prev) =>
        prev.includes(data.viewerSocketId)
          ? prev
          : [...prev, data.viewerSocketId]
      )
      onViewerJoined?.(data)
    },
    [onViewerJoined]
  )

  const handleViewerLeft = useCallback(
    (data: ViewerEventPayload) => {
      const pc = peerConnectionsRef.current.get(data.viewerSocketId)
      if (pc) {
        pc.close()
        peerConnectionsRef.current.delete(data.viewerSocketId)
        updateConnectionCount()
        const nextPc = peerConnectionsRef.current.values().next().value as
          RTCPeerConnection | undefined
        setStatsPeerConnection((prev) =>
          prev === pc ? (nextPc ?? null) : prev
        )
      }
      readyViewerIdsRef.current.delete(data.viewerSocketId)
      pendingIceCandidatesRef.current.delete(data.viewerSocketId)
      setViewerIds((prev) => prev.filter((id) => id !== data.viewerSocketId))
      onViewerLeft?.(data)
    },
    [onViewerLeft, updateConnectionCount]
  )

  const handleSignalAnswer = useCallback(
    async (data: SignalPayload<RTCSessionDescriptionInit>) => {
      const pc = peerConnectionsRef.current.get(data.from)
      if (!pc) return
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.data))
        console.log(
          '[useHostPeerConnections] answer set, processing queued candidates'
        )
        const pending = pendingIceCandidatesRef.current.get(data.from) ?? []
        pendingIceCandidatesRef.current.delete(data.from)
        for (const candidate of pending) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate))
          } catch (candidateErr) {
            console.error(
              '[useHostPeerConnections] add queued ice candidate error:',
              candidateErr
            )
          }
        }
      } catch (err) {
        console.error(
          '[useHostPeerConnections] set remote description error:',
          err
        )
        message.error('处理远端应答失败')
      }
    },
    []
  )

  const handleSignalIceCandidate = useCallback(
    async (data: SignalPayload<RTCIceCandidateInit>) => {
      const pc = peerConnectionsRef.current.get(data.from)
      if (!pc) return
      try {
        if (!pc.remoteDescription) {
          console.log(
            '[useHostPeerConnections] queuing ice candidate for',
            data.from,
            'until remote description is set'
          )
          const pending = pendingIceCandidatesRef.current.get(data.from) ?? []
          pending.push(data.data)
          pendingIceCandidatesRef.current.set(data.from, pending)
          return
        }
        await pc.addIceCandidate(new RTCIceCandidate(data.data))
      } catch (err) {
        console.error('[useHostPeerConnections] add ice candidate error:', err)
        message.error('处理网络候选失败')
      }
    },
    []
  )

  const cleanup = useCallback(() => {
    peerConnectionsRef.current.forEach((pc) => {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
    })
    peerConnectionsRef.current.clear()
    readyViewerIdsRef.current.clear()
    pendingIceCandidatesRef.current.clear()
    setStatsPeerConnection(null)
    setConnectionCount(0)
  }, [])

  return {
    connectionCount,
    statsPeerConnection,
    viewerIds,
    handleSignalAnswer,
    handleSignalIceCandidate,
    handleViewerReady,
    handleViewerJoined,
    handleViewerLeft,
    cleanup,
  }
}
