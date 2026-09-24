import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { ICE_SERVERS } from '../constants'
import type {
  SignalPayload,
  ViewerEventPayload,
  ViewerReadyPayload,
} from '../types'

/**
 * 根据目标帧率计算推荐最低码率（bps）。
 *
 * 码率不足是 60fps 无法维持的首要原因：编码器在带宽受限时会主动降帧
 * 来维持单帧画质。degradationPreference='maintain-resolution' 让编码器
 * 在受限时优先降帧率而非降分辨率（屏幕共享以清晰度优先），但仍需保证
 * 最低码率阈值。
 *
 * 参考值（1080p）：
 * - 15fps: 4 Mbps
 * - 30fps: 8 Mbps
 * - 45fps: 12 Mbps
 * - 60fps: 16 Mbps
 */
function computeRecommendedBitrate(frameRate: number): number {
  // 线性公式：0.267 Mbps/fps * frameRate，最低 2 Mbps
  const mbps = Math.max(2, frameRate * 0.267)
  return Math.round(mbps * 1000 * 1000)
}

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
  // 本地统计 PC：房主开始共享后即使没有观众也提供 outbound-rtp 统计
  // 无观众时 SharingStatusPanel 的 pc 不为 null，可显示帧率/分辨率/码率等
  const [localStatsPc, setLocalStatsPc] = useState<RTCPeerConnection | null>(
    null
  )
  const [viewerIds, setViewerIds] = useState<string[]>([])

  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const readyViewerIdsRef = useRef<Set<string>>(new Set())
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(
    new Map()
  )
  const localStatsPcRef = useRef<RTCPeerConnection | null>(null)

  const updateConnectionCount = useCallback(() => {
    setConnectionCount(peerConnectionsRef.current.size)
  }, [])

  // 本地统计 PC：房主开始共享后立即创建，无需观众连接即可提供 outbound-rtp 统计
  // 编码器在 track 加入 sender 后即开始工作，pc.getStats() 可获取帧率/分辨率/码率
  // 有观众连接后 statsPeerConnection 切换为观众 PC（含 RTT/丢包等完整统计）
  // 所有观众离开后回退到本地统计 PC，保持面板数据不中断
  useEffect(() => {
    if (!localStream) {
      // stream 清空时清理本地统计 PC
      if (localStatsPcRef.current) {
        localStatsPcRef.current.close()
        localStatsPcRef.current = null
        setLocalStatsPc(null)
      }
      return
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    localStatsPcRef.current = pc

    // 添加视频 track 到 sender，触发编码器工作
    const videoTrack = localStream.getVideoTracks()[0]
    if (videoTrack) {
      pc.addTrack(videoTrack, localStream)
    }
    // 添加音频 track（系统音频）
    localStream.getAudioTracks().forEach((track) => {
      pc.addTrack(track, localStream)
    })

    setLocalStatsPc(pc)
    console.log('[useHostPeerConnections] local stats PC created')

    return () => {
      pc.close()
      if (localStatsPcRef.current === pc) {
        localStatsPcRef.current = null
        setLocalStatsPc(null)
      }
    }
  }, [localStream])

  const createPeerConnection = useCallback(
    async (viewerSocketId: string) => {
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

      // 使用 addTransceiver 替代 addTrack，以便设置 codec 偏好
      // 优先使用 H.264（硬件加速，高帧率下性能更稳定），避免 VP8 在 60fps 下 CPU 开销过大
      const videoTrack = localStream.getVideoTracks()[0]
      if (videoTrack) {
        const transceiver = pc.addTransceiver(videoTrack, {
          streams: [localStream],
          direction: 'sendonly',
        })
        // 设置 codec 偏好：H.264 优先（高帧率硬件编码性能最佳），VP9 次之，VP8 最后
        try {
          const caps = RTCRtpSender.getCapabilities('video')
          if (caps && caps.codecs.length > 0) {
            const preferredCodecs = caps.codecs
              .filter((c) => {
                const lower = c.mimeType.toLowerCase()
                // 优先 H.264 高帧率硬件编码；VP9 作为备选（屏幕内容编码工具）
                return lower === 'video/h264' || lower === 'video/vp9'
              })
              .sort((a, b) => {
                // H.264 排最前
                const aH264 = a.mimeType.toLowerCase() === 'video/h264'
                const bH264 = b.mimeType.toLowerCase() === 'video/h264'
                if (aH264 && !bH264) return -1
                if (!aH264 && bH264) return 1
                return 0
              })
            // 将未被选中的 codec 追加到末尾，保持兼容性
            const otherCodecs = caps.codecs.filter(
              (c) =>
                c.mimeType.toLowerCase() !== 'video/h264' &&
                c.mimeType.toLowerCase() !== 'video/vp9'
            )
            transceiver.setCodecPreferences([
              ...preferredCodecs,
              ...otherCodecs,
            ])
          }
        } catch (err) {
          console.warn(
            '[useHostPeerConnections] setCodecPreferences error:',
            err
          )
        }
      }

      // 音频 track 使用 addTrack
      localStream.getAudioTracks().forEach((track) => {
        pc.addTrack(track, localStream)
      })

      if (micStream) {
        micStream.getAudioTracks().forEach((track) => {
          pc.addTrack(track, micStream)
        })
      }

      // 配置编码器：根据帧率自动调整最低码率，避免码率不足导致编码器降帧
      // 参考 WebRTC 官方推荐码率：
      // - 1080p 30fps: 6-10 Mbps
      // - 1080p 60fps: 14-20 Mbps
      const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (videoSender) {
        try {
          const params = videoSender.getParameters()
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}]
          }
          // 根据帧率计算推荐最低码率，用户设置值低于推荐值时自动提升
          const recommendedMinBitrate = computeRecommendedBitrate(frameRate)
          const userBitrate = maxBitrateMbps * 1000 * 1000
          params.encodings[0].maxBitrate = Math.max(
            userBitrate,
            recommendedMinBitrate
          )
          params.encodings[0].maxFramerate = frameRate
          // 显式钉死初始缩放系数为 1（Firefox 46+ 支持），不给浏览器
          // "开局即降采样"的空间；动态自适应仍由 degradationPreference 决定
          params.encodings[0].scaleResolutionDownBy = 1
          // maintain-resolution: 带宽/编码算力不足时降帧率、保持分辨率。
          //
          // 修复 Firefox 720p 问题：此前用 maintain-framerate，Firefox
          // (138 起实装 setParameters 的该参数)会在带宽或编码压力下按
          // libwebrtc 1.5× 步进降分辨率——1920x1080 一步降到 1280x720 并
          // 因带宽估计迟滞长期保持。改为 maintain-resolution 后编码器
          // 只降帧率不降分辨率，对"一起看电影"场景清晰度优先更合理。
          // （Firefox <138 忽略该参数退回 balanced，当前发行版均已 >=138）
          params.degradationPreference = 'maintain-resolution'
          await videoSender.setParameters(params)
          console.log(
            '[useHostPeerConnections] sender params set:',
            'maxBitrate=',
            params.encodings[0].maxBitrate,
            'maxFramerate=',
            params.encodings[0].maxFramerate,
            'user=',
            userBitrate,
            'recommendedMin=',
            recommendedMinBitrate
          )
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
      const pc = await createPeerConnection(viewerSocketId)
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
        // 观众离开后：切换到下一个观众 PC，或回退到本地统计 PC
        setStatsPeerConnection((prev) =>
          prev === pc ? (nextPc ?? localStatsPcRef.current) : prev
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
    // 清理本地统计 PC
    if (localStatsPcRef.current) {
      localStatsPcRef.current.close()
      localStatsPcRef.current = null
      setLocalStatsPc(null)
    }
    setStatsPeerConnection(null)
    setConnectionCount(0)
  }, [])

  // 优先使用观众 PC（含 RTT/丢包等完整统计），无观众时回退到本地统计 PC
  // 这样房主开始共享后即使没有观众，SharingStatusPanel 也能显示帧率/分辨率/码率
  const effectiveStatsPc = statsPeerConnection ?? localStatsPc

  return {
    connectionCount,
    statsPeerConnection: effectiveStatsPc,
    viewerIds,
    handleSignalAnswer,
    handleSignalIceCandidate,
    handleViewerReady,
    handleViewerJoined,
    handleViewerLeft,
    cleanup,
  }
}
