/**
 * 房主侧共享的 React 包装（Piik 链路）。
 *
 * 与 `useShareHost` 同形：采集、预览、控制栏、统计都还留在页面，这里只把
 * 「采集出来的流交给谁」换成了 `PiikShareSession`。
 *
 * 编码自适应也在这一层：每 2 秒采一次每条出边的编码健康，连续两个窗口
 * 编不动就降一档（`ShareHealthMonitor`），降档只改发送参数、不重采集。
 * 每次下发参数都回读，浏览器没照办的部分进 `parameterOverride`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RESOLUTION_DIMENSIONS } from '../screen-sharing/constants'
import { HostAudio } from '../screen-sharing/core/audio-mix'
import { captureCamera, captureDisplay } from '../screen-sharing/core/capture'
import { nextLowerProfile } from '../screen-sharing/core/encoder-health'
import type { AutoDowngradeNotice } from '../screen-sharing/core/host-session'
import {
  profileFromSettings,
  type QualityProfile,
  type VideoSenderParameterReadback,
} from '../screen-sharing/core/quality'
import type { PeerQualityView } from '../screen-sharing/core/peer-quality'
import type { WebrtcShareMediaSettings } from '../screen-sharing/utils/mediaSettingsStorage'
import { ShareHealthMonitor } from './health.ts'
import { PiikShareSession } from './session.ts'
import { t } from '@/i18n'

/** 采样周期。与旧链路的 HostPeer 一致：2s 一次，两个窗口≈4s 得出降档结论。 */
const HEALTH_SAMPLE_INTERVAL_MS = 2_000

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
  autoDowngrade: AutoDowngradeNotice | null
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

/** 两份「浏览器没照办」的列表是否相同；相同就保持原引用，别白触发渲染。 */
function sameKeys(left: string[] | null, right: string[] | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return (
    left.length === right.length && left.every((key, i) => key === right[i])
  )
}

export function usePiikShareHost(
  options: UsePiikShareHostOptions
): UsePiikShareHostResult {
  const { roomId, videoRef, videoVersion = 0, onStreamEnded } = options
  const sessionRef = useRef<PiikShareSession | null>(null)
  /** 系统声 + 麦克风的混音图。输出轨在整个共享期间不变，换源只改输入。 */
  const audioRef = useRef<HostAudio | null>(null)
  /** 当前档位：用户改档与自动降档都以它为准。 */
  const profileRef = useRef<QualityProfile | null>(null)
  const monitorRef = useRef<ShareHealthMonitor | null>(null)
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [sharing, setSharing] = useState(false)
  const [paused, setPaused] = useState(false)
  const [peerCount, setPeerCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [audioAvailable, setAudioAvailable] = useState(false)
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false)
  const [autoDowngrade, setAutoDowngrade] =
    useState<AutoDowngradeNotice | null>(null)
  const [parameterOverride, setParameterOverride] = useState<string[] | null>(
    null
  )
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

  const stopHealthLoop = useCallback(() => {
    if (healthTimerRef.current !== null) clearInterval(healthTimerRef.current)
    healthTimerRef.current = null
    monitorRef.current = null
  }, [])

  // 组件卸载（或路由切走）时把定时器收掉：它每 2 秒会 getStats 一次，
  // 留着会对着已经关掉的连接空转。
  useEffect(() => stopHealthLoop, [stopHealthLoop])

  /** 把每条边的回读并成一份参数名列表；浏览器全都照办时置回 null。 */
  const recordOverrides = useCallback(
    (readbacks: VideoSenderParameterReadback[]) => {
      const keys = new Set<string>()
      for (const readback of readbacks)
        for (const key of readback.mismatches) keys.add(String(key))
      const next = keys.size > 0 ? [...keys].sort() : null
      setParameterOverride((current) =>
        sameKeys(current, next) ? current : next
      )
    },
    []
  )

  /** 下发档位并把回读记进 state。 */
  const applyEncoding = useCallback(
    async (profile: QualityProfile) => {
      const session = sessionRef.current
      if (!session) return
      recordOverrides(await session.applyEncoding(profile))
    },
    [recordOverrides]
  )

  /**
   * 采一轮出边健康，够饿就降一档。
   *
   * 只改发送参数（含 `scaleResolutionDownBy`），不重新采集：共享屏幕重开会
   * 再弹一次画面选择器，观众端也要黑一帧，代价远高于糊一点。降一档之后
   * 该代际的额度就用完了（`ShareHealthMonitor` 自己把关），继续观察但没有
   * 第二次——再降就该让用户自己去调档位了。
   */
  const sampleHealth = useCallback(async () => {
    const session = sessionRef.current
    const monitor = monitorRef.current
    const profile = profileRef.current
    if (!session || !monitor || !profile || monitor.exhausted) return
    const samples = await session.healthSamples()
    if (samples.length === 0) return
    if (!monitor.observe(samples, profile.maxFramerate)) return
    const lower = nextLowerProfile(profile)
    if (!lower) return
    profileRef.current = lower
    await applyEncoding(lower)
    if (lower.resolution) {
      setAutoDowngrade({
        width: lower.resolution.width,
        height: lower.resolution.height,
        frameRate: lower.maxFramerate,
      })
    }
  }, [applyEncoding])

  const startHealthLoop = useCallback(() => {
    stopHealthLoop()
    monitorRef.current = new ShareHealthMonitor()
    healthTimerRef.current = setInterval(() => {
      void sampleHealth()
    }, HEALTH_SAMPLE_INTERVAL_MS)
  }, [sampleHealth, stopHealthLoop])

  const start = useCallback(
    async (settings: WebrtcShareMediaSettings): Promise<boolean> => {
      if (!roomId) return false
      setError(null)
      // 上一代的采样先停：采集期间它没有出边，跑着只是空转。
      stopHealthLoop()
      const profile = profileOf(settings)
      let stream: MediaStream
      try {
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
          setError(t('房间已关闭'))
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
      profileRef.current = profile
      setAutoDowngrade(null)
      setParameterOverride(null)
      startHealthLoop()
      if (settings.shareMicrophone) {
        await audio.setMicrophone(true, {
          deviceId: '',
          volume: 1,
          voiceProcessing: true,
        })
      }
      return true
    },
    [roomId, startHealthLoop, stopHealthLoop]
  )

  const stop = useCallback(() => {
    stopHealthLoop()
    sessionRef.current?.stop()
    sessionRef.current = null
    audioRef.current?.dispose()
    audioRef.current = null
    profileRef.current = null
    setMicrophoneEnabled(false)
    setAudioAvailable(false)
    setSharing(false)
    setPaused(false)
    setPreviewStream(null)
    setPeerCount(0)
    setAutoDowngrade(null)
    setParameterOverride(null)
  }, [stopHealthLoop])

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
        profileRef.current = profile
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
   * 用户改档后，自动降档的基线跟着走（否则下一次判定还在拿旧目标帧率比）。
   * 浏览器不保证照办，但那是 `parameterOverride` 的事——界面不该因此弹失败，
   * 所以恒返回 true。
   */
  const applyProfile = useCallback(
    async (settings: WebrtcShareMediaSettings): Promise<boolean> => {
      const session = sessionRef.current
      if (!session) return false
      const profile = profileOf(settings)
      profileRef.current = profile
      await applyEncoding(profile)
      return true
    },
    [applyEncoding]
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
    autoDowngrade,
    statsPeerConnection: null,
    sharingMode: 'direct',
    parameterOverride,
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
