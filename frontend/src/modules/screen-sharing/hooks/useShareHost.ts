/**
 * 房主侧共享会话的 React 包装。
 *
 * 只做三件事：把 `ShareHostSession` 的生命周期绑到组件、把它的状态搬进
 * React state、把 UI 动作翻译成会话方法。媒体逻辑一律留在 core 里，
 * 这样单测与将来的 P3（SFU）都不必绕开 React。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { RESOLUTION_DIMENSIONS } from '../constants'
import { ShareHostSession, type HostSessionState } from '../core/host-session'
import { profileFromSettings, type QualityProfile } from '../core/quality'
import type { WebrtcShareMediaSettings } from '../utils/mediaSettingsStorage'

export interface UseShareHostOptions {
  socket: Socket | null
  roomId: string
  iceServers: RTCIceServer[]
  /** 本地预览 video 元素（可选）：自动绑定预览流。 */
  /** 本地预览 video 元素（可变 ref，便于直接绑定 srcObject）。 */
  videoRef?: { current: HTMLVideoElement | null }
  /** 采集轨被用户从浏览器 UI 停止时回调。 */
  onStreamEnded?: () => void
  /** 预览 video 元素的挂载版本号（预览流可能先于元素到达）。 */
  videoVersion?: number
}

export interface UseShareHostResult {
  sharing: boolean
  paused: boolean
  peerCount: number
  /** 快照里的观众数（不一定已经有连接）。 */
  viewerCount: number
  /** 供统计面板读数的连接（第一条发布端）。 */
  statsPeerConnection: RTCPeerConnection | null
  /** 媒体走向：经服务端 SFU 转发，还是浏览器直连。 */
  sharingMode: 'direct' | 'relay'
  audioAvailable: boolean
  microphoneEnabled: boolean
  error: string | null
  /** 本地预览流（含混好的音轨）。 */
  previewStream: MediaStream | null
  start: (settings: WebrtcShareMediaSettings) => Promise<boolean>
  stop: () => void
  setPaused: (paused: boolean) => void
  setMicrophone: (enabled: boolean) => Promise<void>
  /** 帧率/码率热更新（不重采集）。 */
  applyProfile: (settings: WebrtcShareMediaSettings) => Promise<boolean>
  /** 切换分辨率档位：传入带新档位的设置，重下发采集约束但不重协商。 */
  switchResolution: (settings: WebrtcShareMediaSettings) => Promise<boolean>
}

/** UI 设置 → 编码档位。 */
export function profileOf(settings: WebrtcShareMediaSettings): QualityProfile {
  return profileFromSettings({
    frameRate: settings.frameRate,
    maxBitrateMbps: settings.maxBitrateMbps,
    resolution: RESOLUTION_DIMENSIONS[settings.resolutionPreset],
  })
}

export function useShareHost(options: UseShareHostOptions): UseShareHostResult {
  const {
    socket,
    roomId,
    iceServers,
    videoRef,
    onStreamEnded,
    videoVersion = 0,
  } = options
  const sessionRef = useRef<ShareHostSession | null>(null)
  const [state, setState] = useState<HostSessionState>({
    sharing: false,
    paused: false,
    peers: 0,
    viewers: 0,
    relay: false,
    audioAvailable: false,
    microphoneEnabled: false,
    error: null,
  })
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [statsPeerConnection, setStatsPeerConnection] =
    useState<RTCPeerConnection | null>(null)
  const onStreamEndedRef = useRef(onStreamEnded)
  useEffect(() => {
    onStreamEndedRef.current = onStreamEnded
  }, [onStreamEnded])

  // 会话随连接/房间变化重建：换房间时必须丢掉旧连接，否则会把上一个房间
  // 的观众带进来。
  useEffect(() => {
    if (!socket || !roomId) return
    const session = new ShareHostSession({
      socket,
      roomId,
      iceServers,
      onStateChange: (next) => {
        setState(next)
        setPreviewStream(session.previewStream)
        setStatsPeerConnection(session.statsConnection())
      },
      onError: (code) => {
        setState((prev) => ({ ...prev, error: code }))
      },
    })
    sessionRef.current = session
    session.hello()
    return () => {
      session.dispose()
      sessionRef.current = null
      setPreviewStream(null)
      setStatsPeerConnection(null)
    }
  }, [socket, roomId, iceServers])

  // 预览绑定 + 用户从浏览器 UI 停止共享的兜底。
  useEffect(() => {
    if (!videoRef) return
    const video = videoRef.current
    if (!video) return
    video.srcObject = previewStream
    if (!previewStream) return
    const track = previewStream.getVideoTracks()[0]
    if (!track) return
    const handleEnded = () => {
      onStreamEndedRef.current?.()
    }
    track.addEventListener('ended', handleEnded)
    return () => {
      track.removeEventListener('ended', handleEnded)
      video.srcObject = null
    }
  }, [previewStream, videoRef, videoVersion])

  const start = useCallback(async (settings: WebrtcShareMediaSettings) => {
    const session = sessionRef.current
    if (!session) return false
    const started = await session.start({
      profile: profileOf(settings),
      shareSystemAudio: settings.shareSystemAudio,
    })
    // 麦克风要等混音图建好才能挂上去，所以放在 start 之后。
    if (started && settings.shareMicrophone) {
      await session.setMicrophone(true, {
        deviceId: '',
        volume: 1,
        voiceProcessing: true,
      })
    }
    setPreviewStream(session.previewStream)
    return started
  }, [])

  const stop = useCallback(() => {
    sessionRef.current?.stop()
    setPreviewStream(null)
  }, [])

  const setPaused = useCallback((paused: boolean) => {
    sessionRef.current?.setPaused(paused)
  }, [])

  const setMicrophone = useCallback(async (enabled: boolean) => {
    await sessionRef.current?.setMicrophone(enabled, {
      deviceId: '',
      volume: 1,
      voiceProcessing: true,
    })
  }, [])

  const applyProfile = useCallback(
    async (settings: WebrtcShareMediaSettings) => {
      const session = sessionRef.current
      if (!session) return false
      return session.updateProfile(profileOf(settings), false)
    },
    []
  )

  const switchResolution = useCallback(
    async (settings: WebrtcShareMediaSettings) => {
      const session = sessionRef.current
      if (!session) return false
      return session.updateProfile(profileOf(settings), true)
    },
    []
  )

  return {
    sharing: state.sharing,
    paused: state.paused,
    peerCount: state.peers,
    viewerCount: state.viewers,
    statsPeerConnection,
    sharingMode: state.relay ? 'relay' : 'direct',
    audioAvailable: state.audioAvailable,
    microphoneEnabled: state.microphoneEnabled,
    error: state.error,
    previewStream,
    start,
    stop,
    setPaused,
    setMicrophone,
    applyProfile,
    switchResolution,
  }
}
