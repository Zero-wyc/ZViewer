/**
 * 房主侧共享的 React 包装（Piik 链路）。
 *
 * 与 `useShareHost` 同形：采集、预览、控制栏、统计都还留在页面，这里只把
 * 「采集出来的流交给谁」换成了 `PiikShareSession`。
 *
 * 已知差距（切默认之前要补）：
 * - 没有自动降档（旧实现按观众反馈逐级降分辨率）
 * - 没有编码参数覆盖检测（`parameterOverride` 恒为 null）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RESOLUTION_DIMENSIONS } from '../screen-sharing/constants'
import { HostAudio } from '../screen-sharing/core/audio-mix'
import { captureCamera, captureDisplay } from '../screen-sharing/core/capture'
import { profileFromSettings } from '../screen-sharing/core/quality'
import type { PeerQualityView } from '../screen-sharing/core/peer-quality'
import type { WebrtcShareMediaSettings } from '../screen-sharing/utils/mediaSettingsStorage'
import { PiikShareSession } from './session.ts'

export interface UsePiikShareHostOptions {
  roomId: string
  videoRef?: { current: HTMLVideoElement | null }
  videoVersion?: number
  onStreamEnded?: () => void
}

export interface UsePiikShareHostResult {
  sharing: boolean
  paused: boolean
  peerCount: number
  viewerCount: number
  peerQualities: PeerQualityView[]
  autoDowngrade: null
  statsPeerConnection: RTCPeerConnection | null
  sharingMode: 'direct' | 'relay'
  parameterOverride: string[] | null
  audioAvailable: boolean
  microphoneEnabled: boolean
  error: string | null
  previewStream: MediaStream | null
  start: (settings: WebrtcShareMediaSettings) => Promise<boolean>
  stop: () => void
  setPaused: (paused: boolean) => void
  setMicrophone: (enabled: boolean) => Promise<void>
  applyProfile: (settings: WebrtcShareMediaSettings) => Promise<boolean>
  switchResolution: (settings: WebrtcShareMediaSettings) => Promise<boolean>
  switchCaptureSource: (settings: WebrtcShareMediaSettings) => Promise<boolean>
}

function profileOf(settings: WebrtcShareMediaSettings) {
  return profileFromSettings({
    frameRate: settings.frameRate,
    maxBitrateMbps: settings.maxBitrateMbps,
    resolution: RESOLUTION_DIMENSIONS[settings.resolutionPreset],
    maxAudioBitrate: settings.maxAudioBitrate,
    degradationPreference: settings.degradationPreference,
  })
}

export function usePiikShareHost(
  options: UsePiikShareHostOptions
): UsePiikShareHostResult {
  const { roomId, videoRef, videoVersion = 0, onStreamEnded } = options
  const sessionRef = useRef<PiikShareSession | null>(null)
  /** 系统声 + 麦克风的混音图。输出轨在整个共享期间不变，换源只改输入。 */
  const audioRef = useRef<HostAudio | null>(null)
  const [sharing, setSharing] = useState(false)
  const [paused, setPaused] = useState(false)
  const [peerCount, setPeerCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [audioAvailable, setAudioAvailable] = useState(false)
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const onStreamEndedRef = useRef(onStreamEnded)
  useEffect(() => {
    onStreamEndedRef.current = onStreamEnded
  }, [onStreamEnded])

  // 预览绑定 + 用户从浏览器 UI 停止共享的兜底。
  useEffect(() => {
    if (!videoRef) return
    const video = videoRef.current
    if (!video) return
    video.srcObject = previewStream
    if (!previewStream) return
    const track = previewStream.getVideoTracks()[0]
    if (!track) return
    const handleEnded = () => onStreamEndedRef.current?.()
    track.addEventListener('ended', handleEnded)
    return () => {
      track.removeEventListener('ended', handleEnded)
      video.srcObject = null
    }
  }, [previewStream, videoRef, videoVersion])

  const start = useCallback(
    async (settings: WebrtcShareMediaSettings): Promise<boolean> => {
      if (!roomId) return false
      setError(null)
      let stream: MediaStream
      try {
        const profile = profileOf(settings)
        stream =
          settings.captureSource === 'camera'
            ? await captureCamera(profile, {
                deviceId: settings.cameraDeviceId,
              })
            : await captureDisplay(profile, {
                systemAudio: settings.shareSystemAudio,
              })
      } catch (captureError) {
        console.warn('[share] capture failed:', captureError)
        setError('CAPTURE_FAILED')
        return false
      }
      // 采集流先过混音图：观众端只该看到一条音轨，系统声与麦克风在房主
      // 这边合成，否则音量、静音、换设备三处都要在观众端重复处理。
      audioRef.current?.dispose()
      const audio = new HostAudio(
        stream,
        setAudioAvailable,
        setMicrophoneEnabled
      )
      const mixed = await audio.start()
      audioRef.current = audio
      setPreviewStream(mixed)

      if (sessionRef.current) sessionRef.current.stop()
      const session = new PiikShareSession(roomId, {
        onStatus: () => {},
        onStream: () => {},
        onStateChange: () => setPeerCount(session.edgeCount),
        onError: (message) => setError(message),
        onSharingStarted: () => setSharing(true),
        onHostStatus: (status) => setPaused(status.paused),
        onSharingStopped: () => setSharing(false),
        onRoomClosed: () => {
          setSharing(false)
          setError('房间已关闭')
        },
      })
      sessionRef.current = session
      try {
        await session.start(mixed)
      } catch (startError) {
        console.warn('[share] piik start failed:', startError)
        setError(
          startError instanceof Error ? startError.message : 'START_FAILED'
        )
        return false
      }
      setSharing(true)
      if (settings.shareMicrophone) {
        await audio.setMicrophone(true, {
          deviceId: '',
          volume: 1,
          voiceProcessing: true,
        })
      }
      return true
    },
    [roomId]
  )

  const stop = useCallback(() => {
    sessionRef.current?.stop()
    sessionRef.current = null
    audioRef.current?.dispose()
    audioRef.current = null
    setMicrophoneEnabled(false)
    setAudioAvailable(false)
    setSharing(false)
    setPaused(false)
    setPreviewStream(null)
    setPeerCount(0)
  }, [])

  const setPausedAction = useCallback((next: boolean) => {
    sessionRef.current?.setPaused(next)
    setPaused(next)
  }, [])

  /** 换源：重新采集后走 `replaceTrack`，观众端不重协商。 */
  const recapture = useCallback(
    async (settings: WebrtcShareMediaSettings): Promise<boolean> => {
      const session = sessionRef.current
      if (!session) return false
      try {
        const profile = profileOf(settings)
        const stream =
          settings.captureSource === 'camera'
            ? await captureCamera(profile, {
                deviceId: settings.cameraDeviceId,
              })
            : await captureDisplay(profile, {
                systemAudio: settings.shareSystemAudio,
              })
        await session.replaceStream(stream)
        setPreviewStream(stream)
        return true
      } catch (captureError) {
        console.warn('[share] recapture failed:', captureError)
        return false
      }
    },
    []
  )

  const switchCaptureSource = useCallback(
    (settings: WebrtcShareMediaSettings) => recapture(settings),
    [recapture]
  )
  const switchResolution = useCallback(
    (settings: WebrtcShareMediaSettings) => recapture(settings),
    [recapture]
  )

  /**
   * 帧率/码率热更新。
   *
   * Piik 链路没有降档反馈环，这里只能把新码率写到发送端参数上；
   * 浏览器不保证照办，所以恒返回 true（界面不该因此弹失败）。
   */
  const applyProfile = useCallback(
    async (settings: WebrtcShareMediaSettings): Promise<boolean> => {
      const session = sessionRef.current
      if (!session) return false
      await session.applyEncoding({
        maxBitrate: Math.round(settings.maxBitrateMbps * 1_000_000),
        frameRate: settings.frameRate,
      })
      return true
    },
    []
  )

  const setMicrophone = useCallback(async (enabled: boolean) => {
    const audio = audioRef.current
    if (!audio) return
    try {
      await audio.setMicrophone(enabled, {
        deviceId: '',
        volume: 1,
        voiceProcessing: true,
      })
      setMicrophoneEnabled(enabled)
    } catch (micError) {
      console.warn('[share] microphone unavailable:', micError)
      setMicrophoneEnabled(false)
    }
  }, [])

  return {
    sharing,
    paused,
    peerCount,
    viewerCount: peerCount,
    peerQualities: [],
    autoDowngrade: null,
    statsPeerConnection: null,
    sharingMode: 'direct',
    parameterOverride: null,
    audioAvailable,
    microphoneEnabled,
    error,
    previewStream,
    start,
    stop,
    setPaused: setPausedAction,
    setMicrophone,
    applyProfile,
    switchResolution,
    switchCaptureSource,
  }
}
