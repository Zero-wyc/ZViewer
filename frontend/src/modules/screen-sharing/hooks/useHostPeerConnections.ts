import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { ICE_SERVERS } from '../constants'
import type {
  SignalPayload,
  ViewerEventPayload,
  ViewerReadyPayload,
} from '../types'
import { t } from '@/i18n'

/**
 * 对单个视频 sender 应用编码参数（码率 / 帧率上限 / 降级策略）。
 *
 * - 码率直接使用用户设置值，不再用推荐值做 Math.max 兜底（此前用户调低
 *   会被静默覆盖，导致「参数设置无效」）。推荐码率仅作为 UI 提示。
 * - degradationPreference 保持默认 balanced（显式设置等价于默认值）：
 *   带宽/编码算力不足时编码器按 libwebrtc 默认策略平滑降级（降帧率与
 *   降分辨率结合），而不是此前 'maintain-resolution' 钉死下「只能疯狂
 *   丢帧、不许降分辨率」的幻灯片式卡顿。此前钉死是为修 Firefox 按 1.5×
 *   步进降分辨率后迟滞不恢复的问题，但代价在弱网/弱机场景被放大。
 * - scaleResolutionDownBy=1 仅作初始值（Firefox 46+ 支持），钉住开局
 *   即降采样；后续动态降级由 degradationPreference 决定。
 *
 * 供建 PC 时和「共享期间参数热更新」两条路径复用。
 */
async function applyVideoSenderParams(
  sender: RTCRtpSender,
  frameRate: number,
  maxBitrateMbps: number
): Promise<void> {
  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}]
    }
    params.encodings[0].maxBitrate = Math.round(maxBitrateMbps * 1000 * 1000)
    params.encodings[0].maxFramerate = frameRate
    params.encodings[0].scaleResolutionDownBy = 1
    params.degradationPreference = 'balanced'
    await sender.setParameters(params)
  } catch (err) {
    console.warn('[useHostPeerConnections] set sender parameters error:', err)
  }
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
  /**
   * 共享中热替换视频 track（借鉴 mirotalk replaceTrack 换轨模式）：
   * 对所有活跃观众 PC 的视频 sender 执行 replaceTrack，PC 全程存活、
   * 无需重协商，观众无感。编码参数（码率/帧率/降级策略）随 sender 保留。
   */
  replaceVideoTrack: (track: MediaStreamTrack) => Promise<void>
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

  // 注意：不再创建「本地统计 PC」。此前为了让房主在无观众时也能看
  // outbound-rtp 统计，把视频 track addTrack 进了一个永不协商的
  // RTCPeerConnection——Chrome 中这就是 dummy-peer 语义，编码器会照常
  // 全速运行，等于 1080p 同时编码两份。CPU 过载时 libwebrtc 主动丢帧，
  // 真实发送的那路跟着被拖垮（低帧率 + 卡顿的首要根因）。
  // 无观众时的采集帧率改由 MediaStreamTrackProcessor 帧率计
  // （utils/frameMeter.ts）在 WebrtcSharePage 中以近零开销测得。

  const updateConnectionCount = useCallback(() => {
    setConnectionCount(peerConnectionsRef.current.size)
  }, [])

  // 共享期间参数热更新：用户在 MediaSettingsCard 修改帧率/码率时，
  // 对所有活跃观众 PC 的视频 sender 重新 setParameters，无需重启共享
  // （localStream 存在时才会有效果，创建 PC 时的初始参数同样走
  // applyVideoSenderParams，二者幂等）。
  useEffect(() => {
    if (!localStream) return
    for (const pc of peerConnectionsRef.current.values()) {
      if (pc.connectionState === 'closed' || pc.signalingState === 'closed') {
        continue
      }
      const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (videoSender) {
        void applyVideoSenderParams(videoSender, frameRate, maxBitrateMbps)
      }
    }
  }, [localStream, frameRate, maxBitrateMbps])

  const createPeerConnection = useCallback(
    async (viewerSocketId: string) => {
      if (!localStream) {
        message.warning(t('尚未开始屏幕共享'))
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

      // 配置编码器：码率/帧率/降级策略统一走 applyVideoSenderParams
      // （用户设置值直接生效，共享期间也可热更新）
      const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (videoSender) {
        await applyVideoSenderParams(videoSender, frameRate, maxBitrateMbps)
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
        message.error(t('创建 WebRTC 连接失败'))
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
      message.success(t('有新的观看者加入房间'))
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
        // 观众离开后：切换到下一个观众 PC；无观众时为 null（采集帧率
        // 由 WebrtcSharePage 的帧率计继续显示，不依赖 PC）
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
        message.error(t('处理远端应答失败'))
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
        message.error(t('处理网络候选失败'))
      }
    },
    []
  )

  // 共享中热替换视频 track：分辨率档位切换时由 WebrtcSharePage 调用。
  // replaceTrack 不触发重协商，编码参数随 sender 保留，无需重新 setParameters。
  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack) => {
    for (const [viewerSocketId, pc] of peerConnectionsRef.current) {
      if (pc.connectionState === 'closed' || pc.signalingState === 'closed') {
        continue
      }
      const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (!videoSender) continue
      try {
        await videoSender.replaceTrack(track)
        console.log(
          '[useHostPeerConnections] video track replaced for',
          viewerSocketId
        )
      } catch (err) {
        console.warn(
          '[useHostPeerConnections] replaceTrack error for',
          viewerSocketId,
          err
        )
      }
    }
  }, [])

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

  // 统计 PC 只来自真实观众连接（不再有本地统计 PC 回退）
  return {
    connectionCount,
    statsPeerConnection,
    viewerIds,
    handleSignalAnswer,
    handleSignalIceCandidate,
    handleViewerReady,
    handleViewerJoined,
    handleViewerLeft,
    replaceVideoTrack,
    cleanup,
  }
}
