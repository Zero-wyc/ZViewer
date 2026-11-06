/**
 * 房主侧共享的 React 包装（Piik 链路）。
 *
 * 采集、预览、控制栏都留在页面，这里只负责「采集出来的流怎么发出去」：
 * 交给 `PiikShareSession`，由它连 `/signal` 并按 Piik 的候选建边。
 *
 * 编码自适应也在这一层：每 2 秒采一次每条出边的编码健康，连续两个窗口
 * 编不动就降一档（`ShareHealthMonitor`），降档只改发送参数、不重采集。
 * 每次下发参数都回读，浏览器没照办的部分进 `parameterOverride`。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RESOLUTION_DIMENSIONS } from '../screen-sharing/constants'
import { HostAudio } from '../screen-sharing/core/audio-mix'
import {
  applyVideoCaptureProfile,
  captureCamera,
  captureDisplay,
} from '../screen-sharing/core/capture'
import { nextLowerProfile } from '../screen-sharing/core/encoder-health'
import type { AutoDowngradeNotice } from '../screen-sharing/core/view-state'
import type { ShareEdgeStats } from '../screen-sharing/core/edge-stats'
import {
  profileFromSettings,
  qualityNeedsCaptureUpdate,
  type QualityProfile,
  type VideoSenderParameterReadback,
} from '../screen-sharing/core/quality'
import type { WebrtcShareMediaSettings } from '../screen-sharing/utils/mediaSettingsStorage'
import { ShareHealthMonitor } from './health.ts'
import { PiikShareSession } from './session.ts'
import { usePiikShareStats } from './usePiikShareStats.ts'
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
  /** 每条观众连接的用量，统计面板直接消费。 */
  edges: ShareEdgeStats[]
  autoDowngrade: AutoDowngradeNotice | null
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

  /**
   * 当前采集流（含视频轨）。
   *
   * 用它给「帧率热更新」下发采集约束：sent 出去的轨与预览轨是同一条
   * （`HostAudio.output()` 直接复用采集流的 video track），所以改这里的
   * 约束等于同时改采集与发送。
   */
  const previewStreamRef = useRef<MediaStream | null>(null)
  useEffect(() => {
    previewStreamRef.current = previewStream
  }, [previewStream])

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
   * 帧率/画面偏好/音频码率热更新。
   *
   * 帧率必须**同时**下发到采集轨：采集阶段的 `frameRate` 是硬上限，开局按
   * 30fps 采集之后只改编码器 `maxFramerate`，源本身还是 30 帧——界面写着
   * 144fps、发出去的还是 30。这里按 `qualityNeedsCaptureUpdate` 判定，只在
   * 帧率/分辨率真变了时重下发采集约束（`applyConstraints`，不重开采集器、
   * 不弹画面选择器）。分辨率走 `switchResolution` 的重采集路径，不在这里做。
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
      const previous = profileRef.current
      profileRef.current = profile
      await applyEncoding(profile)
      if (!previous || qualityNeedsCaptureUpdate(previous, profile)) {
        const track = previewStreamRef.current?.getVideoTracks()[0]
        if (track) {
          try {
            await applyVideoCaptureProfile(track, profile)
          } catch (captureError) {
            // 采集器不接受新帧率（源只有 30fps、或超了设备能力）：画面继续，
            // 只是发不出目标帧率。`房间状态` 的实测采集帧率会露出真实值。
            console.warn('[share] capture profile update failed:', captureError)
          }
        }
      }
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

  // 共享中才轮询：没开播时会话要么不存在，要么已经停了，取到的只会是空表。
  const edges = usePiikShareStats(sessionRef, sharing)

  return {
    sharing,
    paused,
    peerCount,
    viewerCount: peerCount,
    edges,
    autoDowngrade,
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
