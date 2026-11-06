/**
 * 语音聊天（Piik 版）。
 *
 * 与自建 SFU 版的对外形状完全一致（`VoiceChatController`），面板不需要知道
 * 当前跑的是哪条实现。
 *
 * 拓扑：Piik 的 `signal.Server` 把「谁连谁、发什么、收什么」算好下发
 * （`room-voice-state.connections`），本层只按这份授权建 RTCPeerConnection。
 * 中间节点要替上下游转发音频，所以一条连接上可能同时有多个收发槽位——这
 * 与 SFU 版「一条连接收全部」是两种模型，不能复用同一段协商代码。
 *
 * 三条与 SFU 版不同、且错了只会「没声音」的约束：
 *  1. **房主是树根**：房主没有进语音时，服务端会让其他人收到 `not-enabled`。
 *  2. **发起方由服务端指定**：`parentPeerId === 自己` 时才 offer，否则等对方
 *     offer；需要重排时发 `renegotiate` 请求，服务端再让另一方发。
 *  3. **转发的源是「已收到的轨」**：中间节点把上游的 track 原样挂到下游的
 *     sender 上，不从麦克风复制。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from '@/components/ui/message'
import { t } from '@/i18n'
import { VoiceEndpoint } from './endpoint'
import { PiikSignal, type SignalStatus } from './signal'
import {
  publicationOwner,
  type PiikServerMessage,
  type PiikVoiceSignal,
  type PiikVoiceState,
} from './protocol'
import type {
  UseVoiceChatOptions,
  VoiceChatController,
  VoiceMember,
  VoiceTransport,
} from '../voice-chat/types'

/** 媒体通道建立失败判定窗口：超过仍未连通即提示，不再傻等。 */
const MEDIA_WATCHDOG_TIMEOUT_MS = 10_000

interface RemoteAudio {
  stream: MediaStream
  audio: HTMLAudioElement
  analyser: AnalyserNode | null
}

export function usePiikVoice({
  roomId,
  username,
  enabled = true,
}: UseVoiceChatOptions & { enabled?: boolean }): VoiceChatController {
  const [joined, setJoined] = useState(false)
  const [joining, setJoining] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [members, setMembers] = useState<VoiceMember[]>([])
  const [globalVolume, setGlobalVolumeState] = useState(1)
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map())
  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map())
  const [voiceMutedIds] = useState<Set<string>>(new Set())
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [micVolume, setMicVolumeState] = useState(1)
  const [transport, setTransport] = useState<VoiceTransport | null>(null)
  const [mediaConnected, setMediaConnected] = useState(false)
  const [selfId, setSelfId] = useState<string | null>(null)

  const signalRef = useRef<PiikSignal | null>(null)
  const endpointRef = useRef<VoiceEndpoint | null>(null)
  const stateRef = useRef<PiikVoiceState | null>(null)
  const peerIdRef = useRef('')
  const publishedRef = useRef(false)

  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const captureCtxRef = useRef<AudioContext | null>(null)
  const micGainRef = useRef<GainNode | null>(null)
  const monitorGainRef = useRef<GainNode | null>(null)
  const levelsCtxRef = useRef<AudioContext | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)
  const remoteRef = useRef<Map<string, RemoteAudio>>(new Map())

  const globalVolumeRef = useRef(1)
  const peerVolumesRef = useRef<Map<string, number>>(new Map())
  const micVolumeRef = useRef(1)
  const micEnabledRef = useRef(true)
  const monitorEnabledRef = useRef(false)

  // 同一时刻只允许一轮 reconcile：两轮交错会在同一条连接上重复 createOffer。
  const reconcileTailRef = useRef<Promise<void>>(Promise.resolve())
  const reconcileQueuedRef = useRef(false)

  // ==================== 播放与音量 ====================

  const applyVolume = useCallback((peerID: string) => {
    const entry = remoteRef.current.get(peerID)
    if (!entry) return
    entry.audio.volume = Math.max(
      0,
      Math.min(
        1,
        (peerVolumesRef.current.get(peerID) ?? 1) * globalVolumeRef.current
      )
    )
  }, [])

  const detachRemote = useCallback((peerID: string) => {
    const entry = remoteRef.current.get(peerID)
    if (!entry) return
    remoteRef.current.delete(peerID)
    entry.audio.pause()
    entry.audio.srcObject = null
    entry.audio.remove()
  }, [])

  const attachRemote = useCallback(
    (peerID: string, track: MediaStreamTrack) => {
      let entry = remoteRef.current.get(peerID)
      if (!entry) {
        const stream = new MediaStream()
        const audio = document.createElement('audio')
        audio.autoplay = true
        audio.dataset.piikVoiceMember = peerID
        audio.style.display = 'none'
        document.body.appendChild(audio)
        let analyser: AnalyserNode | null = null
        try {
          if (!levelsCtxRef.current) levelsCtxRef.current = new AudioContext()
          const source = levelsCtxRef.current.createMediaStreamSource(stream)
          analyser = levelsCtxRef.current.createAnalyser()
          analyser.fftSize = 256
          analyser.smoothingTimeConstant = 0.6
          source.connect(analyser)
        } catch {
          /* 电平分析失败不影响收听 */
        }
        entry = { stream, audio, analyser }
        remoteRef.current.set(peerID, entry)
        applyVolume(peerID)
      }
      if (!entry.stream.getTracks().includes(track))
        entry.stream.addTrack(track)
      entry.audio.srcObject = entry.stream
      void entry.audio.play().catch(() => {})
    },
    [applyVolume]
  )

  // ==================== 媒体采集 ====================

  const releaseCapture = useCallback(() => {
    micTrackRef.current = null
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    captureCtxRef.current?.close().catch(() => {})
    captureCtxRef.current = null
    micGainRef.current = null
    monitorGainRef.current = null
    localAnalyserRef.current = null
  }, [])

  /** 采一条带增益与反送通路的麦克风流。 */
  const startCapture = useCallback(async (): Promise<MediaStreamTrack> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      } as MediaTrackConstraints,
    })
    localStreamRef.current = stream
    // 不强制采样率：硬件是 44.1k（蓝牙 HFP 尤其常见）时，强制 48k 会造成
    // 采集→上下文双重重采样，反送与上行都会周期性卡顿。
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const micGain = ctx.createGain()
    micGain.gain.value = micVolumeRef.current
    source.connect(micGain)
    const produceDest = ctx.createMediaStreamDestination()
    micGain.connect(produceDest)
    const monitorGain = ctx.createGain()
    monitorGain.gain.value = 0
    micGain.connect(monitorGain)
    monitorGain.connect(ctx.destination)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    micGain.connect(analyser)
    await ctx.resume()
    captureCtxRef.current = ctx
    micGainRef.current = micGain
    monitorGainRef.current = monitorGain
    localAnalyserRef.current = analyser
    const track = produceDest.stream.getAudioTracks()[0]
    track.enabled = micEnabledRef.current
    return track
  }, [])

  // ==================== 状态推进 ====================

  /** 某个 publication 的音轨从哪里取：自己发的从麦克风，别人的从已收到的。 */
  const sourceTrack = useCallback(
    (publicationId: string): MediaStreamTrack | undefined => {
      const owner = publicationOwner(stateRef.current, publicationId)
      if (!owner) return undefined
      if (owner === peerIdRef.current) {
        const me = stateRef.current?.members.find(
          (member) => member.peerId === peerIdRef.current
        )
        if (!me?.publicationId || me.publicationId !== publicationId)
          return undefined
        return micTrackRef.current ?? undefined
      }
      const received = remoteRef.current.get(owner)
      const track = received?.stream.getAudioTracks()[0]
      return track?.readyState === 'live' ? track : undefined
    },
    []
  )

  const scheduleReconcile = useCallback(() => {
    if (reconcileQueuedRef.current) return
    reconcileQueuedRef.current = true
    reconcileTailRef.current = reconcileTailRef.current.then(async () => {
      reconcileQueuedRef.current = false
      const endpoint = endpointRef.current
      if (!endpoint) return
      await endpoint.reconcile(sourceTrack)
      setMediaConnected(endpoint.connected)
    })
  }, [sourceTrack])

  const applyState = useCallback(
    (state: PiikVoiceState) => {
      stateRef.current = state
      const peerID = peerIdRef.current
      setMembers(
        state.members.map((member) => ({
          id: member.peerId,
          username:
            member.peerId === peerID ? (username ?? t('我')) : member.peerId,
        }))
      )

      // 服务端认了我的 join 但还没有 publication：补一次 publish。
      const me = state.members.find((member) => member.peerId === peerID)
      if (
        state.enabled &&
        me?.joined &&
        !me.publicationId &&
        !publishedRef.current
      ) {
        publishedRef.current = true
        signalRef.current?.send({
          type: 'room-voice-command',
          command: { action: 'publish' },
        })
      }
      if (!me?.joined) publishedRef.current = false

      endpointRef.current?.setState(state, peerID)
      scheduleReconcile()
    },
    [scheduleReconcile, username]
  )

  const handleMessage = useCallback(
    (raw: PiikServerMessage) => {
      switch (raw.type) {
        case 'room-voice-state':
          applyState(raw as PiikVoiceState)
          return
        case 'room-voice-signal':
          void endpointRef.current?.receive(raw as PiikVoiceSignal)
          return
        case 'room-voice-error': {
          const code = (raw as { code?: string }).code
          if (code === 'not-enabled') {
            message.warning(t('房主还没有进入语音'))
            return
          }
          if (code === 'connection-unavailable') {
            message.warning(t('语音连接未能建立，正在重试'))
            return
          }
          message.error(t('语音操作未被允许'))
          return
        }
        case 'room-closed':
          message.warning(t('房间已关闭'))
          return
        case 'error':
          message.error(
            String((raw as { message?: string }).message ?? t('语音连接失败'))
          )
          return
        default:
          return
      }
    },
    [applyState]
  )

  const teardown = useCallback(() => {
    endpointRef.current?.close()
    endpointRef.current = null
    stateRef.current = null
    peerIdRef.current = ''
    publishedRef.current = false
    setMediaConnected(false)
    setTransport(null)
    for (const peerID of [...remoteRef.current.keys()]) detachRemote(peerID)
  }, [detachRemote])

  const leave = useCallback(() => {
    signalRef.current?.send({
      type: 'room-voice-command',
      command: { action: 'leave' },
    })
    signalRef.current?.stop()
    signalRef.current = null
    teardown()
    releaseCapture()
    setJoined(false)
    setMediaConnected(false)
    setMembers([])
    setSelfId(null)
    setMonitorEnabled(false)
    monitorEnabledRef.current = false
    setGlobalVolumeState(1)
    setPeerVolumes(new Map())
    peerVolumesRef.current = new Map()
    setAudioLevels(new Map())
  }, [releaseCapture, teardown])

  const join = useCallback(async () => {
    if (!enabled || !roomId || joining || joined) return
    setJoining(true)
    try {
      // 先在用户手势里拿麦克风：晚一步拿会被浏览器判成非手势请求。
      const track = await startCapture()
      micTrackRef.current = track

      const endpoint = new VoiceEndpoint(
        { iceServers: [] },
        {
          signal: (payload) => signalRef.current?.send(payload) ?? false,
          report: (connectionId, transportState) =>
            signalRef.current?.send({
              type: 'room-voice-transport',
              connectionId,
              state: transportState,
            }),
          onTrack: (publicationId, remoteTrack) => {
            const owner = publicationOwner(stateRef.current, publicationId)
            if (owner) attachRemote(owner, remoteTrack)
          },
          onTrackRemoved: (publicationId) => {
            const owner = publicationOwner(stateRef.current, publicationId)
            if (owner) detachRemote(owner)
          },
          onChange: () => scheduleReconcile(),
        }
      )
      endpointRef.current = endpoint

      const signal = new PiikSignal(roomId, {
        onStatus: (status: SignalStatus) => {
          if (status === 'open') {
            const authenticated = signal.authenticated
            if (authenticated) {
              peerIdRef.current = authenticated.peerId
              setSelfId(authenticated.peerId)
              endpoint.setIceConfig(
                authenticated.iceConfig ?? { iceServers: [] }
              )
            }
            // 订阅语音：带 deafened 让服务端回传他人的收听状态，
            // 带 bitrate 让服务端下发当前码率上限。
            signal.send({
              type: 'subscribe-room-voice',
              deafened: false,
              bitrate: true,
            })
            signal.send({
              type: 'room-voice-command',
              command: { action: 'join' },
            })
          }
          if (status === 'reconnecting')
            message.warning(t('语音连接已断开，正在重连...'), {
              duration: 4000,
            })
        },
        onMessage: handleMessage,
        onFatal: (_code, text) => {
          message.error(text)
          leave()
        },
      })
      signalRef.current = signal
      await signal.start()
      setJoined(true)
      setMicEnabled(track.enabled)
    } catch (error) {
      console.error('[piik-voice] join error:', error)
      message.error(
        error instanceof Error ? error.message : t('加入语音聊天失败')
      )
      releaseCapture()
      teardown()
    } finally {
      setJoining(false)
    }
  }, [
    attachRemote,
    detachRemote,
    enabled,
    handleMessage,
    joined,
    joining,
    leave,
    releaseCapture,
    roomId,
    scheduleReconcile,
    startCapture,
    teardown,
  ])

  // ==================== 控制方法 ====================

  const toggleMic = useCallback(() => {
    const track = micTrackRef.current
    if (!track) return
    track.enabled = !track.enabled
    micEnabledRef.current = track.enabled
    setMicEnabled(track.enabled)
  }, [])

  const toggleMonitor = useCallback(() => {
    const gain = monitorGainRef.current
    if (!gain) return
    const next = !monitorEnabled
    gain.gain.value = next ? micVolumeRef.current : 0
    monitorEnabledRef.current = next
    setMonitorEnabled(next)
  }, [monitorEnabled])

  const setGlobalVolume = useCallback(
    (value: number) => {
      globalVolumeRef.current = value
      setGlobalVolumeState(value)
      for (const peerID of remoteRef.current.keys()) applyVolume(peerID)
    },
    [applyVolume]
  )

  const setPeerVolume = useCallback(
    (id: string, value: number) => {
      peerVolumesRef.current.set(id, value)
      setPeerVolumes(new Map(peerVolumesRef.current))
      applyVolume(id)
    },
    [applyVolume]
  )

  const setMicVolume = useCallback((value: number) => {
    micVolumeRef.current = value
    setMicVolumeState(value)
    if (micGainRef.current) micGainRef.current.gain.value = value
    if (monitorGainRef.current && monitorEnabledRef.current) {
      monitorGainRef.current.gain.value = value
    }
  }, [])

  /**
   * 禁言他人：Piik 的语音命令只能作用于本人，服务端没有「代他人静音」的
   * 动作。这里退化成「我本地不听他」——对本人无声、对其他成员不可见。
   */
  const muteVoiceMember = useCallback(
    async (id: string, muted: boolean) => {
      peerVolumesRef.current.set(id, muted ? 0 : 1)
      setPeerVolumes(new Map(peerVolumesRef.current))
      applyVolume(id)
      return {
        success: true,
        message: muted ? t('已在本地静音该成员') : undefined,
      }
    },
    [applyVolume]
  )

  /** 移出语音：Piik 没有房主踢人的协议动作。 */
  const kickVoiceMember = useCallback(async () => {
    return { success: false, message: t('Piik 语音不支持由房主移出成员') }
  }, [])

  // ==================== 电平与传输 ====================

  useEffect(() => {
    if (!joined) return
    const read = (analyser: AnalyserNode | null): number => {
      if (!analyser) return 0
      const data = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let index = 0; index < data.length; index += 1) {
        const value = (data[index] - 128) / 128
        sum += value * value
      }
      return Math.min(1, Math.sqrt(sum / data.length) * 4)
    }
    const timer = window.setInterval(() => {
      const next = new Map<string, number>()
      next.set('self', read(localAnalyserRef.current))
      for (const [peerID, entry] of remoteRef.current)
        next.set(peerID, read(entry.analyser))
      setAudioLevels(next)
    }, 200)
    return () => window.clearInterval(timer)
  }, [joined])

  useEffect(() => {
    if (!joined) return
    let cancelled = false
    const run = async () => {
      const protocol = await endpointRef.current?.transportProtocol()
      if (!cancelled && protocol) setTransport(protocol)
    }
    const timer = window.setTimeout(() => void run(), 2500)
    const interval = window.setInterval(() => void run(), 15000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [joined])

  // 加入后 10 秒还没连上任何一条边就提示：树上可能没有可用上游。
  useEffect(() => {
    if (!joined) return
    const timer = window.setTimeout(() => {
      if (!endpointRef.current?.connected) {
        message.warning(t('媒体通道未建立，请检查网络（可尝试关闭代理/VPN）'), {
          duration: 8000,
        })
      }
    }, MEDIA_WATCHDOG_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [joined])

  // 卸载兜底：AudioContext.close 二次关闭会走 Promise 拒绝，须显式 catch。
  useEffect(() => {
    // 捕获当时的集合：cleanup 运行时 ref 可能已经指向新的一批成员。
    const remote = remoteRef
    return () => {
      signalRef.current?.stop()
      signalRef.current = null
      endpointRef.current?.close()
      endpointRef.current = null
      captureCtxRef.current?.close().catch(() => {})
      captureCtxRef.current = null
      levelsCtxRef.current?.close().catch(() => {})
      levelsCtxRef.current = null
      for (const peerID of [...remote.current.keys()]) detachRemote(peerID)
    }
  }, [detachRemote])

  return {
    joined,
    joining,
    micEnabled,
    mediaConnected,
    selfId,
    members,
    transport,
    globalVolume,
    peerVolumes,
    micVolume,
    monitorEnabled,
    audioLevels,
    voiceMutedIds,
    join,
    leave,
    toggleMic,
    toggleMonitor,
    setGlobalVolume,
    setPeerVolume,
    setMicVolume,
    muteVoiceMember,
    kickVoiceMember,
  }
}
