import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'

export type P2PStatus = 'idle' | 'connecting' | 'connected' | 'failed'

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
const ICE_TIMEOUT_MS = 10000

interface SignalEnvelope<T> {
  from: string
  data: T
}

interface P2PSignalPayload {
  __p2pTunnel: true
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

interface UseP2PTunnelParams {
  socket: Socket | null
  roomId: string
  localStream?: MediaStream | null
  role: 'sender' | 'receiver'
  remotePeerId?: string | null
  onStatusChange?: (status: P2PStatus, didFallback: boolean) => void
}

interface UseP2PTunnelResult {
  enableP2P: () => Promise<void>
  disableP2P: () => void
  p2pEnabled: boolean
  p2pPC: RTCPeerConnection | null
  p2pStatus: P2PStatus
}

function isP2PSignal(data: unknown): data is P2PSignalPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    '__p2pTunnel' in data &&
    (data as { __p2pTunnel: unknown }).__p2pTunnel === true
  )
}

export function useP2PTunnel({
  socket,
  roomId,
  localStream,
  role,
  remotePeerId,
  onStatusChange,
}: UseP2PTunnelParams): UseP2PTunnelResult {
  const [p2pEnabled, setP2pEnabled] = useState(false)
  const [p2pStatus, setP2pStatus] = useState<P2PStatus>('idle')
  const [p2pPC, setP2pPC] = useState<RTCPeerConnection | null>(null)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const remotePeerIdRef = useRef<string | null>(remotePeerId ?? null)
  const iceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onStatusChangeRef = useRef(onStatusChange)
  const pendingOfferRef = useRef<{
    from: string
    sdp: RTCSessionDescriptionInit
  } | null>(null)
  const roomIdRef = useRef(roomId)

  useEffect(() => {
    roomIdRef.current = roomId
  }, [roomId])

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  }, [onStatusChange])

  useEffect(() => {
    remotePeerIdRef.current = remotePeerId ?? null
  }, [remotePeerId])

  const updateStatus = useCallback((next: P2PStatus, didFallback = false) => {
    setP2pStatus(next)
    onStatusChangeRef.current?.(next, didFallback)
  }, [])

  const clearIceTimeout = useCallback(() => {
    if (iceTimeoutRef.current) {
      clearTimeout(iceTimeoutRef.current)
      iceTimeoutRef.current = null
    }
  }, [])

  const closePC = useCallback(() => {
    clearIceTimeout()
    const pc = pcRef.current
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.oniceconnectionstatechange = null
      try {
        pc.close()
      } catch {
        // ignore close errors
      }
      pcRef.current = null
      setP2pPC(null)
    }
    pendingOfferRef.current = null
  }, [clearIceTimeout])

  const disableP2P = useCallback(() => {
    closePC()
    setP2pEnabled(false)
    updateStatus('idle')
  }, [closePC, updateStatus])

  const handleIceConnectionStateChange = useCallback(() => {
    const pc = pcRef.current
    if (!pc) return
    const state = pc.iceConnectionState
    if (state === 'connected' || state === 'completed') {
      clearIceTimeout()
      updateStatus('connected')
    } else if (
      state === 'failed' ||
      state === 'disconnected' ||
      state === 'closed'
    ) {
      updateStatus('failed', true)
      closePC()
      setP2pEnabled(false)
    }
  }, [clearIceTimeout, updateStatus, closePC])

  // 监听 P2P 信令事件（通过 __p2pTunnel 标记区分服务器中转信令）
  useEffect(() => {
    if (!socket) return

    const handleSignalOffer = async (envelope: SignalEnvelope<unknown>) => {
      if (!isP2PSignal(envelope.data) || !envelope.data.sdp) return
      if (role !== 'receiver') return
      remotePeerIdRef.current = envelope.from

      const pc = pcRef.current
      if (!pc) {
        // PC 尚未创建：缓存 offer，等 enableP2P 后处理
        pendingOfferRef.current = {
          from: envelope.from,
          sdp: envelope.data.sdp,
        }
        return
      }

      try {
        if (pc.signalingState !== 'stable') {
          return
        }
        await pc.setRemoteDescription(
          new RTCSessionDescription(envelope.data.sdp)
        )
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        socket.emit('signal-answer', {
          to: envelope.from,
          data: {
            __p2pTunnel: true as const,
            sdp: answer,
          },
        })
      } catch (err) {
        console.error('[useP2PTunnel] handle offer error:', err)
        updateStatus('failed', true)
        closePC()
        setP2pEnabled(false)
      }
    }

    const handleSignalAnswer = async (envelope: SignalEnvelope<unknown>) => {
      if (!isP2PSignal(envelope.data) || !envelope.data.sdp) return
      if (role !== 'sender') return

      const pc = pcRef.current
      if (!pc) return

      try {
        await pc.setRemoteDescription(
          new RTCSessionDescription(envelope.data.sdp)
        )
      } catch (err) {
        console.error('[useP2PTunnel] handle answer error:', err)
        updateStatus('failed', true)
        closePC()
        setP2pEnabled(false)
      }
    }

    const handleSignalIceCandidate = async (
      envelope: SignalEnvelope<unknown>
    ) => {
      if (!isP2PSignal(envelope.data) || !envelope.data.candidate) return
      const pc = pcRef.current
      if (!pc) return
      try {
        await pc.addIceCandidate(new RTCIceCandidate(envelope.data.candidate))
      } catch (err) {
        console.warn('[useP2PTunnel] add ice candidate error:', err)
      }
    }

    socket.on('signal-offer', handleSignalOffer)
    socket.on('signal-answer', handleSignalAnswer)
    socket.on('signal-ice-candidate', handleSignalIceCandidate)

    return () => {
      socket.off('signal-offer', handleSignalOffer)
      socket.off('signal-answer', handleSignalAnswer)
      socket.off('signal-ice-candidate', handleSignalIceCandidate)
    }
  }, [socket, role, updateStatus, closePC])

  const applyPendingOffer = useCallback(
    async (pc: RTCPeerConnection) => {
      const pending = pendingOfferRef.current
      if (!pending || !socket) return
      pendingOfferRef.current = null
      try {
        if (pc.signalingState === 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(pending.sdp))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          socket.emit('signal-answer', {
            to: pending.from,
            data: {
              __p2pTunnel: true as const,
              sdp: answer,
            },
          })
        }
      } catch (err) {
        console.error('[useP2PTunnel] apply pending offer error:', err)
        updateStatus('failed', true)
        closePC()
        setP2pEnabled(false)
      }
    },
    [socket, updateStatus, closePC]
  )

  const enableP2P = useCallback(async () => {
    if (!socket) {
      console.warn('[useP2PTunnel] socket not ready')
      return
    }
    if (pcRef.current) return

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcRef.current = pc
    setP2pPC(pc)

    if (role === 'sender' && localStream) {
      localStream.getTracks().forEach((track) => {
        pc.addTrack(track, localStream)
      })
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && remotePeerIdRef.current) {
        socket.emit('signal-ice-candidate', {
          to: remotePeerIdRef.current,
          data: {
            __p2pTunnel: true as const,
            candidate: event.candidate.toJSON(),
          },
        })
      }
    }

    pc.oniceconnectionstatechange = handleIceConnectionStateChange

    updateStatus('connecting')

    iceTimeoutRef.current = setTimeout(() => {
      const currentPc = pcRef.current
      if (!currentPc) return
      const iceState = currentPc.iceConnectionState
      if (iceState !== 'connected' && iceState !== 'completed') {
        console.warn('[useP2PTunnel] ICE timeout, falling back to relay')
        updateStatus('failed', true)
        closePC()
        setP2pEnabled(false)
      }
    }, ICE_TIMEOUT_MS)

    setP2pEnabled(true)

    if (role === 'sender') {
      if (!remotePeerIdRef.current) {
        console.warn(
          '[useP2PTunnel] remotePeerId not set, cannot initiate offer'
        )
        updateStatus('failed', true)
        closePC()
        setP2pEnabled(false)
        return
      }

      try {
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        socket.emit('signal-offer', {
          to: remotePeerIdRef.current,
          data: {
            __p2pTunnel: true as const,
            sdp: offer,
          },
        })
      } catch (err) {
        console.error('[useP2PTunnel] create offer error:', err)
        updateStatus('failed', true)
        closePC()
        setP2pEnabled(false)
      }
    } else {
      // receiver: 处理可能在 enableP2P 之前到达的 offer
      await applyPendingOffer(pc)
    }
  }, [
    socket,
    role,
    localStream,
    updateStatus,
    closePC,
    handleIceConnectionStateChange,
    applyPendingOffer,
  ])

  // 卸载时清理
  useEffect(() => {
    return () => {
      closePC()
    }
  }, [closePC])

  return {
    enableP2P,
    disableP2P,
    p2pEnabled,
    p2pPC,
    p2pStatus,
  }
}

export default useP2PTunnel
