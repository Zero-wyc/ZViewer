import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import type {
  SignalPayload,
  RoomClosedPayload,
  RoomModeChangedPayload,
  ViewerEventPayload,
  ViewerReadyPayload,
  JoinApprovedPayload,
  JoinRejectedPayload,
} from '../types'

interface UseSignalingChannelOptions {
  socket: Socket | null
  /** 信令事件回调（房主与观众共用，未提供的事件不订阅） */
  onSignalOffer?: (data: SignalPayload<RTCSessionDescriptionInit>) => void
  onSignalAnswer?: (data: SignalPayload<RTCSessionDescriptionInit>) => void
  onSignalIceCandidate?: (data: SignalPayload<RTCIceCandidateInit>) => void
  onViewerReady?: (data: ViewerReadyPayload) => void
  onViewerJoined?: (data: ViewerEventPayload) => void
  onViewerLeft?: (data: ViewerEventPayload) => void
  onRoomClosed?: (data: RoomClosedPayload) => void
  onRoomModeChanged?: (data: RoomModeChangedPayload) => void
  onRoomNameUpdated?: (data: { roomId: string; name: string }) => void
  /** 观众端加入流程事件 */
  onJoinApproved?: (data: JoinApprovedPayload) => void
  onJoinRejected?: (data: JoinRejectedPayload) => void
}

/**
 * 投屏信令通道 hook：集中订阅所有 Socket 事件并以回调形式派发。
 *
 * 纯副作用 hook，返回 void。所有数据通过回调传递，调用方应使用 useCallback
 * 稳定回调引用以避免不必要的重新订阅。
 */
export function useSignalingChannel(options: UseSignalingChannelOptions): void {
  const {
    socket,
    onSignalOffer,
    onSignalAnswer,
    onSignalIceCandidate,
    onViewerReady,
    onViewerJoined,
    onViewerLeft,
    onRoomClosed,
    onRoomModeChanged,
    onRoomNameUpdated,
    onJoinApproved,
    onJoinRejected,
  } = options

  useEffect(() => {
    if (!socket) return

    if (onSignalOffer) socket.on('signal-offer', onSignalOffer)
    if (onSignalAnswer) socket.on('signal-answer', onSignalAnswer)
    if (onSignalIceCandidate)
      socket.on('signal-ice-candidate', onSignalIceCandidate)
    if (onViewerReady) socket.on('viewer-ready', onViewerReady)
    if (onViewerJoined) socket.on('viewer-joined', onViewerJoined)
    if (onViewerLeft) socket.on('viewer-left', onViewerLeft)
    if (onRoomClosed) socket.on('room-closed', onRoomClosed)
    if (onRoomModeChanged) socket.on('room-mode-changed', onRoomModeChanged)
    if (onRoomNameUpdated) socket.on('room-name-updated', onRoomNameUpdated)
    if (onJoinApproved) socket.on('join-approved', onJoinApproved)
    if (onJoinRejected) socket.on('join-rejected', onJoinRejected)

    return () => {
      if (onSignalOffer) socket.off('signal-offer', onSignalOffer)
      if (onSignalAnswer) socket.off('signal-answer', onSignalAnswer)
      if (onSignalIceCandidate)
        socket.off('signal-ice-candidate', onSignalIceCandidate)
      if (onViewerReady) socket.off('viewer-ready', onViewerReady)
      if (onViewerJoined) socket.off('viewer-joined', onViewerJoined)
      if (onViewerLeft) socket.off('viewer-left', onViewerLeft)
      if (onRoomClosed) socket.off('room-closed', onRoomClosed)
      if (onRoomModeChanged) socket.off('room-mode-changed', onRoomModeChanged)
      if (onRoomNameUpdated) socket.off('room-name-updated', onRoomNameUpdated)
      if (onJoinApproved) socket.off('join-approved', onJoinApproved)
      if (onJoinRejected) socket.off('join-rejected', onJoinRejected)
    }
  }, [
    socket,
    onSignalOffer,
    onSignalAnswer,
    onSignalIceCandidate,
    onViewerReady,
    onViewerJoined,
    onViewerLeft,
    onRoomClosed,
    onRoomModeChanged,
    onRoomNameUpdated,
    onJoinApproved,
    onJoinRejected,
  ])
}
