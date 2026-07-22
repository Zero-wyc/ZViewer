import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { ICE_SERVERS } from '../constants'
import type { SignalPayload } from '../types'

interface UseViewerPeerConnectionOptions {
  socket: Socket | null
  roomId: string | undefined
  /** video 元素 ref（调用方提供，用于自动绑定 srcObject） */
  videoRef: RefObject<HTMLVideoElement | null>
  /** 当 track 进入时通知调用方（用于 UI 状态更新） */
  onTrackReady?: (params: {
    mergedStream: MediaStream
    hasVideo: boolean
    hasAudio: boolean
  }) => void
  /**
   * 外部传入的 video 元素挂载版本号（每次 video 元素从 null 变为有值时自增）。
   * 用于在 video 元素挂载后触发 stream 重新绑定，避免 mode 切换时 video 元素挂载晚于
   * ontrack 触发导致 stream 永远绑不上 video 的问题。
   */
  videoMountedVersion?: number
}

interface UseViewerPeerConnectionResult {
  /** 当前 PC */
  pc: RTCPeerConnection | null
  /** 合并后的 MediaStream（含视频+音频） */
  mergedStream: MediaStream | null
  /** 是否已收到远端视频 */
  hasRemoteStream: boolean
  /** 是否已收到远端音频 */
  hasRemoteAudio: boolean
  /** PC 连接状态 */
  connectionState: RTCPeerConnectionState
  /** 用于触发 video 元素重新绑定（srcObject 变化时自增） */
  videoVersion: number
  /** 创建 PC（在 join-approved 后调用） */
  create: () => void
  /** 清理 PC（在 room-closed / room-mode-changed 时调用） */
  cleanup: () => void
  /** 处理房主 signal-offer 事件 */
  handleSignalOffer: (data: SignalPayload<RTCSessionDescriptionInit>) => void
  /** 处理房主 signal-ice-candidate 事件 */
  handleSignalIceCandidate: (data: SignalPayload<RTCIceCandidateInit>) => void
  /** 处理房主 sharer-ready 事件（重建 PC 并重发 viewer-ready） */
  handleSharerReady: () => void
}

/**
 * 观众端单 PeerConnection 管理 hook。
 *
 * 负责：
 * - 创建/清理 RTCPeerConnection（与房主 1v1）
 * - 合并房主发送的视频/音频 track 到一个 MediaStream，避免麦克风 track 替换屏幕视频 stream
 * - 自动绑定 video.srcObject 并尝试播放（处理 NotAllowedError 时静音重试）
 * - 处理 signal-offer / signal-ice-candidate 信令
 *
 * 不负责：request-join / join-approved（由 useJoinRoom 处理）、socket.on 订阅
 * （由 useSignalingChannel 处理）、room-mode-changed 处理（由调用方在回调中处理）、
 * video.muted / isMuted 状态（由调用方通过 videoRef 控制）。
 */
export function useViewerPeerConnection(
  options: UseViewerPeerConnectionOptions
): UseViewerPeerConnectionResult {
  const { socket, roomId, videoRef, onTrackReady, videoMountedVersion } =
    options

  const [pc, setPc] = useState<RTCPeerConnection | null>(null)
  const [mergedStream, setMergedStream] = useState<MediaStream | null>(null)
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [hasRemoteAudio, setHasRemoteAudio] = useState(false)
  const [connectionState, setConnectionState] =
    useState<RTCPeerConnectionState>('new')
  const [videoVersion, setVideoVersion] = useState(0)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const mergedStreamRef = useRef<MediaStream | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const sharerSocketIdRef = useRef<string | null>(null)
  const autoplayAttemptedRef = useRef(false)
  const isCreatingPcRef = useRef(false)
  const processingOfferRef = useRef(false)
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([])

  // 用 ref 持有最新的 onTrackReady，避免 create 函数依赖变化导致重建
  const onTrackReadyRef = useRef(onTrackReady)
  useEffect(() => {
    onTrackReadyRef.current = onTrackReady
  }, [onTrackReady])

  const cleanup = useCallback(() => {
    const currentPc = pcRef.current
    if (currentPc) {
      currentPc.onicecandidate = null
      currentPc.ontrack = null
      currentPc.onconnectionstatechange = null
      currentPc.close()
      pcRef.current = null
    }
    sharerSocketIdRef.current = null
    remoteStreamRef.current = null
    mergedStreamRef.current?.getTracks().forEach((track) => track.stop())
    mergedStreamRef.current = null
    autoplayAttemptedRef.current = false
    processingOfferRef.current = false
    isCreatingPcRef.current = false
    pendingIceCandidatesRef.current = []
    setConnectionState('closed')
    setHasRemoteStream(false)
    setMergedStream(null)
    setHasRemoteAudio(false)
    setPc(null)
  }, [])

  const create = useCallback(() => {
    if (isCreatingPcRef.current) {
      console.log(
        '[useViewerPeerConnection] PC creation already in progress, skip'
      )
      return
    }
    if (pcRef.current) {
      console.log('[useViewerPeerConnection] PC already exists, skip')
      return
    }
    isCreatingPcRef.current = true

    cleanup()

    const newPc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcRef.current = newPc
    setPc(newPc)
    setConnectionState(newPc.connectionState)

    const stream = new MediaStream()
    mergedStreamRef.current = stream
    remoteStreamRef.current = stream

    newPc.ontrack = (event) => {
      const incomingTrack = event.track
      if (!incomingTrack) return

      // 将不同 stream 的 track 合并到一个 MediaStream，避免麦克风 track 替换掉屏幕视频 stream 导致黑屏
      if (!stream.getTrackById(incomingTrack.id)) {
        stream.addTrack(incomingTrack)
        console.log(
          '[useViewerPeerConnection] added remote track:',
          incomingTrack.kind,
          incomingTrack.label
        )
      }

      setMergedStream(stream)
      const hasVideo = stream.getVideoTracks().length > 0
      const hasAudio = stream.getAudioTracks().some((track) => track.enabled)
      setHasRemoteStream(
        stream.getVideoTracks().some((track) => !track.muted) || hasVideo
      )
      setHasRemoteAudio(hasAudio)
      autoplayAttemptedRef.current = false

      // 立即将合并后的流绑定到 video 元素
      const video = videoRef.current
      if (video && video.srcObject !== stream) {
        video.srcObject = stream
        void video.play().catch((err: Error) => {
          console.error('[useViewerPeerConnection] direct play error:', err)
          if (err.name === 'NotAllowedError') {
            video.muted = true
            void video.play().catch((retryErr: Error) => {
              console.error(
                '[useViewerPeerConnection] muted direct play error:',
                retryErr
              )
            })
          }
        })
      }

      if (incomingTrack.kind === 'video') {
        console.log(
          '[useViewerPeerConnection] remote video track:',
          incomingTrack.label,
          'enabled:',
          incomingTrack.enabled,
          'muted:',
          incomingTrack.muted
        )
        incomingTrack.addEventListener('unmute', () => {
          console.log('[useViewerPeerConnection] remote video track unmuted')
          setHasRemoteStream(true)
          setVideoVersion((v) => v + 1)
          const v2 = videoRef.current
          if (v2 && v2.srcObject !== stream) {
            v2.srcObject = stream
          }
          if (v2) {
            autoplayAttemptedRef.current = false
            void v2.play().catch((err: Error) => {
              console.error('[useViewerPeerConnection] unmute play error:', err)
            })
          }
        })
        incomingTrack.addEventListener('mute', () => {
          console.warn('[useViewerPeerConnection] remote video track muted')
        })
      }

      onTrackReadyRef.current?.({ mergedStream: stream, hasVideo, hasAudio })
    }

    newPc.onicecandidate = (event) => {
      if (event.candidate && socket && sharerSocketIdRef.current) {
        socket.emit('signal-ice-candidate', {
          to: sharerSocketIdRef.current,
          data: event.candidate,
        })
      }
    }

    newPc.onconnectionstatechange = () => {
      setConnectionState(newPc.connectionState)
    }

    // 通知共享端：观看端 RTCPeerConnection 已就绪，可以发送 offer
    if (roomId) {
      console.log(
        '[useViewerPeerConnection] emit viewer-ready for room:',
        roomId
      )
      socket?.emit('viewer-ready', { roomId })
    }

    isCreatingPcRef.current = false
  }, [socket, cleanup, roomId, videoRef])

  const handleSignalOffer = useCallback(
    async (data: SignalPayload<RTCSessionDescriptionInit>) => {
      sharerSocketIdRef.current = data.from
      const currentPc = pcRef.current
      if (!currentPc) {
        message.error('WebRTC 连接尚未创建')
        return
      }

      // 避免并发处理多个 offer 导致 SDP 状态混乱
      if (processingOfferRef.current) {
        console.log(
          '[useViewerPeerConnection] already processing offer, skip duplicate'
        )
        return
      }
      processingOfferRef.current = true

      try {
        console.log(
          '[useViewerPeerConnection] handle offer, state:',
          currentPc.signalingState
        )
        if (currentPc.signalingState === 'have-remote-offer') {
          console.log(
            '[useViewerPeerConnection] already have remote offer, skip'
          )
          processingOfferRef.current = false
          return
        }
        if (currentPc.signalingState !== 'stable') {
          console.log(
            '[useViewerPeerConnection] skip offer in state:',
            currentPc.signalingState
          )
          processingOfferRef.current = false
          return
        }

        await currentPc.setRemoteDescription(
          new RTCSessionDescription(data.data)
        )
        console.log(
          '[useViewerPeerConnection] after setRemoteDescription, state:',
          currentPc.signalingState
        )

        // 处理在 setRemoteDescription 之前到达的 ICE candidate
        const pending = pendingIceCandidatesRef.current
        pendingIceCandidatesRef.current = []
        for (const candidate of pending) {
          try {
            await currentPc.addIceCandidate(new RTCIceCandidate(candidate))
          } catch (candidateErr) {
            console.error(
              '[useViewerPeerConnection] add queued ice candidate error:',
              candidateErr
            )
          }
        }

        const answer = await currentPc.createAnswer()
        console.log('[useViewerPeerConnection] created answer')
        await currentPc.setLocalDescription(answer)
        console.log(
          '[useViewerPeerConnection] after setLocalDescription, state:',
          currentPc.signalingState
        )
        console.log('[useViewerPeerConnection] sending answer to', data.from)
        socket?.emit('signal-answer', {
          to: data.from,
          data: answer,
        })
      } catch (err) {
        console.error('[useViewerPeerConnection] handle offer error:', err)
        message.error('处理共享端连接请求失败')
      } finally {
        processingOfferRef.current = false
      }
    },
    [socket]
  )

  const handleSignalIceCandidate = useCallback(
    async (data: SignalPayload<RTCIceCandidateInit>) => {
      const currentPc = pcRef.current
      if (!currentPc) return
      try {
        if (!currentPc.remoteDescription) {
          console.log(
            '[useViewerPeerConnection] queuing ice candidate until remote description is set'
          )
          pendingIceCandidatesRef.current.push(data.data)
          return
        }
        await currentPc.addIceCandidate(new RTCIceCandidate(data.data))
      } catch (err) {
        console.error('[useViewerPeerConnection] add ice candidate error:', err)
        message.error('处理网络候选失败')
      }
    },
    []
  )

  // 房主开始共享时广播 sharer-ready，观众收到后重建 PC 并重发 viewer-ready。
  // 解决观众先加入等待、房主后开始共享时信令流程断链的问题。
  // 如果 PC 已连接则忽略，避免重复重建导致画面闪烁。
  const handleSharerReady = useCallback(() => {
    const currentPc = pcRef.current
    if (currentPc && currentPc.connectionState === 'connected') {
      console.log(
        '[useViewerPeerConnection] already connected, skip sharer-ready'
      )
      return
    }
    console.log(
      '[useViewerPeerConnection] sharer-ready received, recreate PC and re-send viewer-ready'
    )
    cleanup()
    create()
  }, [cleanup, create])

  // video 元素自动绑定 srcObject 并尝试播放（mergedStream / videoVersion / videoMountedVersion 变化时触发）
  // videoMountedVersion 用于在 video 元素挂载后触发重新绑定，避免 mode 切换时 video 元素挂载晚于
  // ontrack 触发导致 stream 永远绑不上 video 的问题。
  useEffect(() => {
    const video = videoRef.current
    const stream = mergedStream
    if (!video || !stream) return

    // 仅当 video.srcObject 与 stream 不一致时才重新绑定，避免重复触发
    if (video.srcObject === stream) return

    video.srcObject = stream
    autoplayAttemptedRef.current = false

    const attemptPlay = () => {
      if (!video || autoplayAttemptedRef.current) return
      autoplayAttemptedRef.current = true
      video
        .play()
        .then(() => {
          console.log('[useViewerPeerConnection] remote video playing')
        })
        .catch((err: Error) => {
          console.error('[useViewerPeerConnection] autoplay error:', err)
          if (err.name === 'NotAllowedError') {
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
        console.log(
          '[useViewerPeerConnection] remote video track unmuted, retry play'
        )
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
      unmuteHandlers.forEach((cleanupFn) => cleanupFn())
    }
  }, [mergedStream, videoVersion, videoMountedVersion, videoRef])

  // 卸载时清理 PC 与 stream 资源
  useEffect(() => {
    // 在 effect body 中捕获 ref 值，避免 cleanup 运行时 ref 已变化
    const videoElement = videoRef.current
    return () => {
      remoteStreamRef.current?.getTracks().forEach((track) => track.stop())
      remoteStreamRef.current = null
      if (videoElement) {
        videoElement.srcObject = null
      }
      cleanup()
    }
  }, [cleanup, videoRef])

  return {
    pc,
    mergedStream,
    hasRemoteStream,
    hasRemoteAudio,
    connectionState,
    videoVersion,
    create,
    cleanup,
    handleSignalOffer,
    handleSignalIceCandidate,
    handleSharerReady,
  }
}
