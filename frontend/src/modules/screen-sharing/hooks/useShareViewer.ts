/**
 * 观众侧共享会话的 React 包装。
 *
 * 与旧实现的关键差别：连接不再由页面主动建立（`createPc`），而是由服务端
 * 下发的候选驱动。页面只负责把远端流绑到 video 元素，以及暴露一个「重试」
 * 动作给恢复预算耗尽时使用。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import {
  ShareViewerSession,
  type ViewerSessionState,
} from '../core/viewer-session'

export interface UseShareViewerOptions {
  socket: Socket | null
  roomId: string
  iceServers: RTCIceServer[]
  /** NAT 端口预测的 survey 目的地（恰好两个才启用）。 */
  natPredictionStunUrls?: readonly string[]
  /** 本地 video 元素（用可变 ref 包一层，便于直接绑定 srcObject）。 */
  videoRef?: { current: HTMLVideoElement | null }
  /** 自动播放被浏览器拦截时回调（由页面决定是否展示「点击开启声音」）。 */
  onAutoplayBlocked?: () => void
  /**
   * video 元素挂载版本号。远端流可能先于 video 元素到达（回调 ref 挂载晚于
   * effect），带上它才能在元素就位后补一次绑定。
   */
  videoVersion?: number
}

export interface UseShareViewerResult {
  /** 底层连接，仅供统计面板使用。 */
  pc: RTCPeerConnection | null
  /** 远端流（观众端音量控制要拿它的音轨）。 */
  remoteStream: MediaStream | null
  hasRemoteStream: boolean
  hasRemoteAudio: boolean
  connectionState: RTCPeerConnectionState
  state: ViewerSessionState
  /** 媒体走向：经服务端中继，还是与房主直连（供统计面板标注）。 */
  sharingMode: 'direct' | 'relay'
  /** 恢复预算耗尽后的手动重试。 */
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

export function useShareViewer(
  options: UseShareViewerOptions
): UseShareViewerResult {
  const {
    socket,
    roomId,
    iceServers,
    natPredictionStunUrls,
    videoRef,
    onAutoplayBlocked,
    videoVersion = 0,
  } = options
  const sessionRef = useRef<ShareViewerSession | null>(null)
  const [state, setState] = useState<ViewerSessionState>(INITIAL_STATE)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [connectionState, setConnectionState] =
    useState<RTCPeerConnectionState>('new')
  const [pc, setPc] = useState<RTCPeerConnection | null>(null)
  const onAutoplayBlockedRef = useRef(onAutoplayBlocked)
  useEffect(() => {
    onAutoplayBlockedRef.current = onAutoplayBlocked
  }, [onAutoplayBlocked])

  useEffect(() => {
    if (!socket || !roomId) return
    const session = new ShareViewerSession({
      socket,
      roomId,
      iceServers,
      natPredictionStunUrls,
      // 树形拓扑要用它区分「这条边我收」和「这条边我转发」。
      selfPeerId: socket.id,
      onStateChange: setState,
      onStream: (stream) => setRemoteStream(stream),
      onPeerUpdate: (snapshot) => {
        setConnectionState(snapshot.connectionState)
        setPc(session.peerConnection)
      },
    })
    sessionRef.current = session
    session.hello()
    return () => {
      session.dispose()
      sessionRef.current = null
      setRemoteStream(null)
      setPc(null)
      setConnectionState('new')
    }
  }, [socket, roomId, iceServers, natPredictionStunUrls])

  // 远端流绑定。共享结束时**不清 srcObject**：观众要能看到最后一帧，
  // 彻底清零会让画面瞬间变黑，比「暂停中」更难理解。
  useEffect(() => {
    if (!videoRef) return
    const video = videoRef.current
    if (!video) return
    if (remoteStream && video.srcObject !== remoteStream) {
      video.srcObject = remoteStream
    }
    if (!remoteStream) return
    void video.play().catch((error: unknown) => {
      const name =
        typeof error === 'object' && error !== null && 'name' in error
          ? (error as { name?: string }).name
          : undefined
      // AbortError 是 pause()/load() 打断 play()，不是播放失败。
      if (name === 'AbortError') return
      if (name === 'NotAllowedError') {
        // 自动播放被拦：先静音播放保证有画面，再提示用户点击开声音。
        video.muted = true
        void video.play().catch(() => undefined)
        onAutoplayBlockedRef.current?.()
      }
    })
  }, [remoteStream, videoRef, videoVersion])

  /** 恢复预算耗尽后的手动重试：没有连接时退化成重新取快照。 */
  const retry = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    if (!session.retry()) session.hello()
  }, [])

  return {
    pc,
    remoteStream,
    hasRemoteStream: remoteStream !== null,
    hasRemoteAudio: (remoteStream?.getAudioTracks().length ?? 0) > 0,
    connectionState,
    state,
    sharingMode: state.relay ? 'relay' : 'direct',
    retry,
  }
}
