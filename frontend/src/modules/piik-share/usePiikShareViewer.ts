/**
 * 观众侧共享的 React 包装（Piik 链路）。
 *
 * 与 `useShareViewer` 同形，页面只换 hook 不换 JSX。差别在连接由
 * `/signal` 上的 route-update 驱动：这里没有「重试建 PC」这种动作，
 * 断线后由 controller 重新分配候选，所以 `retry` 只是重连信令。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewerSessionState } from '../screen-sharing/core/viewer-session'
import { PiikShareSession } from './session.ts'

export interface UsePiikShareViewerOptions {
  roomId: string
  /** 本地 video 元素（可变 ref，便于直接绑定 srcObject）。 */
  videoRef?: { current: HTMLVideoElement | null }
  /** video 元素挂载版本号：远端流可能先于元素到达。 */
  videoVersion?: number
  /** 自动播放被浏览器拦截时回调。 */
  onAutoplayBlocked?: () => void
}

export interface UsePiikShareViewerResult {
  /** 多连接拓扑下没有「唯一 PC」；统计请用 session.stats()。 */
  pc: RTCPeerConnection | null
  remoteStream: MediaStream | null
  hasRemoteStream: boolean
  hasRemoteAudio: boolean
  connectionState: RTCPeerConnectionState
  state: ViewerSessionState
  sharingMode: 'direct' | 'relay'
  retry: () => void
}

const INITIAL_STATE: ViewerSessionState = {
  joined: false,
  sharing: false,
  paused: false,
  active: false,
  recovering: false,
  exhausted: false,
  hasVideo: false,
  relay: false,
  error: null,
}

export function usePiikShareViewer(
  options: UsePiikShareViewerOptions
): UsePiikShareViewerResult {
  const { roomId, videoRef, videoVersion = 0, onAutoplayBlocked } = options
  const sessionRef = useRef<PiikShareSession | null>(null)
  const [state, setState] = useState<ViewerSessionState>(INITIAL_STATE)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [connectionState, setConnectionState] =
    useState<RTCPeerConnectionState>('new')
  const [generation, setGeneration] = useState(0)
  const onAutoplayBlockedRef = useRef(onAutoplayBlocked)
  useEffect(() => {
    onAutoplayBlockedRef.current = onAutoplayBlocked
  }, [onAutoplayBlocked])

  useEffect(() => {
    if (!roomId) return
    let disposed = false
    const session = new PiikShareSession(roomId, {
      onStatus: (status) =>
        setState((prev) => ({
          ...prev,
          recovering: status === 'reconnecting',
        })),
      onStream: (_connectionId, stream) => {
        if (disposed) return
        setRemoteStream(stream)
        setState((prev) => ({
          ...prev,
          active: true,
          hasVideo: stream.getVideoTracks().length > 0,
        }))
      },
      onStateChange: (_connectionId, next) => {
        if (disposed) return
        setConnectionState(next)
        setState((prev) => ({
          ...prev,
          active: next === 'connected',
        }))
      },
      onHostStatus: (status) =>
        setState((prev) => ({
          ...prev,
          sharing: status.online,
          paused: status.paused,
        })),
      onSharingStopped: () =>
        setState((prev) => ({ ...prev, sharing: false, paused: false })),
      onRoomClosed: () =>
        setState((prev) => ({ ...prev, error: '房间已关闭', exhausted: true })),
      onAuthenticated: () =>
        setState((prev) => ({ ...prev, joined: true, sharing: true })),
      onError: (message) => setState((prev) => ({ ...prev, error: message })),
    })
    sessionRef.current = session
    void session.start().catch((error: unknown) => {
      if (disposed) return
      setState((prev) => ({
        ...prev,
        error: error instanceof Error ? error.message : '连接失败',
        exhausted: true,
      }))
    })
    return () => {
      disposed = true
      session.stop()
      sessionRef.current = null
      setRemoteStream(null)
    }
  }, [roomId, generation])

  // 远端流可能先于 video 元素到达，元素就位后补一次绑定。
  useEffect(() => {
    if (!videoRef) return
    const video = videoRef.current
    if (!video) return
    video.srcObject = remoteStream
    if (!remoteStream) return
    const play = video.play()
    if (play) {
      void play.catch(() => {
        // 自动播放策略：先静音重试（多数情况能过），再失败才交给页面提示。
        video.muted = true
        void video.play().catch(() => onAutoplayBlockedRef.current?.())
      })
    }
  }, [remoteStream, videoRef, videoVersion])

  const retry = useCallback(() => {
    // 断线后的重连交给信令层；这里只处理「彻底躺平」的手动重来。
    setGeneration((value) => value + 1)
  }, [])

  const tracks = remoteStream?.getTracks() ?? []
  return {
    pc: null,
    remoteStream,
    hasRemoteStream: tracks.length > 0,
    hasRemoteAudio: tracks.some((track) => track.kind === 'audio'),
    connectionState,
    state,
    sharingMode: 'direct',
    retry,
  }
}
