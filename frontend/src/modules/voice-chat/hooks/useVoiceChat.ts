/**
 * 语音聊天 Hook（LiveKit 版，v7 全量重写）。
 *
 * 实时音频由独立 LiveKit 服务（SFU）承载，本 Hook 只做三件事：
 * 1. 加入：向后端要 AccessToken → room.connect → 发布麦克风轨
 * 2. 收听：TrackSubscribed 后把远端轨挂到每成员一个 <audio> 上，
 *    播放端缓冲/丢包补偿由 LiveKit(浏览器 WebRTC) 原生承担
 * 3. 管理：禁言/踢出走后端 REST（权限在服务端校验）
 *
 * 麦克风处理链沿用最小实现：48kHz AudioContext 上 micGain（输入音量）
 * 分流到 产流轨 / 反送直连输出 / 电平分析器。
 *
 * 自闭麦 = track.enabled（本地静音帧，无服务端请求）；管理员禁言由
 * LiveKit 服务器侧 mute + participant metadata 双通道强制，客户端无法绕过。
 *
 * 依赖：LiveKit 服务需运行（docker-compose 内置 livekit 服务；
 * 本地开发可 `livekit-server --dev`），后端需配置
 * LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Room, RoomEvent, Track, AudioPresets } from 'livekit-client'
import type { RemoteParticipant, RemoteTrack } from 'livekit-client'
import { apiFetch } from '@/lib/api'
import { message } from '@/components/ui/message'

export interface VoiceMember {
  /** LiveKit participant identity（后端签发：user:{userId} / guest:{random}） */
  id: string
  username: string
}

export interface UseVoiceChatOptions {
  roomId: string | undefined
  username?: string
}

export function useVoiceChat({ roomId, username }: UseVoiceChatOptions) {
  const [joined, setJoined] = useState(false)
  const [joining, setJoining] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [members, setMembers] = useState<VoiceMember[]>([])
  const [globalVolume, setGlobalVolumeState] = useState(1)
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map())
  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map())
  const [voiceMutedIds, setVoiceMutedIds] = useState<Set<string>>(new Set())
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [micVolume, setMicVolumeState] = useState(1)

  const [selfId, setSelfId] = useState<string | null>(null)
  const roomRef = useRef<Room | null>(null)
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  const captureCtxRef = useRef<AudioContext | null>(null)
  const micGainRef = useRef<GainNode | null>(null)
  const monitorAudioRef = useRef<HTMLAudioElement | null>(null)
  const monitorGainRef = useRef<GainNode | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const levelsCtxRef = useRef<AudioContext | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)
  /** 成员 id → 播放/分析状态 */
  const remoteRef = useRef<
    Map<
      string,
      {
        audio: HTMLAudioElement
        stream: MediaStream
        analyser: AnalyserNode | null
      }
    >
  >(new Map())
  const globalVolumeRef = useRef(1)
  const peerVolumesRef = useRef<Map<string, number>>(new Map())

  // ==================== 播放与音量 ====================

  const applyVolume = useCallback((id: string) => {
    const entry = remoteRef.current.get(id)
    if (!entry) return
    entry.audio.volume = Math.max(
      0,
      Math.min(
        1,
        (peerVolumesRef.current.get(id) ?? 1) * globalVolumeRef.current
      )
    )
  }, [])

  /** 远端轨挂 <audio>：LiveKit 不直接出声，须元素承载（重订阅不重复建） */
  const attachRemote = useCallback(
    (participant: RemoteParticipant, remoteTrack: RemoteTrack) => {
      const id = participant.identity
      let entry = remoteRef.current.get(id)
      if (!entry) {
        const stream = new MediaStream()
        const audio = document.createElement('audio')
        audio.autoplay = true
        audio.dataset.voiceMember = id
        audio.style.display = 'none'
        document.body.appendChild(audio)
        let analyser: AnalyserNode | null = null
        try {
          if (!levelsCtxRef.current) levelsCtxRef.current = new AudioContext()
          const source = levelsCtxRef.current.createMediaStreamSource(stream)
          analyser = levelsCtxRef.current.createAnalyser()
          analyser.fftSize = 256
          analyser.smoothingTimeConstant = 0.6
          source.connect(analyser) // 仅观测，音频由 <audio> 播放
        } catch {
          /* 电平分析失败不影响收听 */
        }
        entry = { audio, stream, analyser }
        remoteRef.current.set(id, entry)
        applyVolume(id)
      }
      entry.stream.addTrack(remoteTrack.mediaStreamTrack)
      entry.audio.srcObject = entry.stream
      void entry.audio.play().catch(() => {})
    },
    [applyVolume]
  )

  const cleanupRemote = useCallback((id: string) => {
    const entry = remoteRef.current.get(id)
    if (!entry) return
    remoteRef.current.delete(id)
    entry.audio.pause()
    entry.audio.srcObject = null
    entry.audio.remove()
  }, [])

  // ==================== 成员/禁言状态刷新 ====================

  /** 成员表 + 管理员禁言标记（participant.metadata = {"adminMuted":true}） */
  const refreshMembers = useCallback((room: Room): Set<string> => {
    const list: VoiceMember[] = [
      {
        id: room.localParticipant.identity,
        username: room.localParticipant.name || '我',
      },
    ]
    room.remoteParticipants.forEach((p) =>
      list.push({ id: p.identity, username: p.name || '成员' })
    )
    setMembers(list)
    const muted = new Set<string>()
    const isAdminMuted = (meta: string | undefined) => {
      try {
        return JSON.parse(meta ?? '{}')?.adminMuted === true
      } catch {
        return false
      }
    }
    if (isAdminMuted(room.localParticipant.metadata))
      muted.add(room.localParticipant.identity)
    room.remoteParticipants.forEach((p) => {
      if (isAdminMuted(p.metadata)) muted.add(p.identity)
    })
    setVoiceMutedIds(muted)
    return muted
  }, [])

  // ==================== 加入 / 离开 ====================

  /** 释放全部本地媒体资源（幂等） */
  const teardown = useCallback(() => {
    micTrackRef.current = null
    for (const id of Array.from(remoteRef.current.keys())) cleanupRemote(id)
    try {
      void roomRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    roomRef.current = null
    captureCtxRef.current?.close().catch(() => {})
    captureCtxRef.current = null
    micGainRef.current = null
    monitorGainRef.current = null
    localAnalyserRef.current = null
    if (monitorAudioRef.current) {
      monitorAudioRef.current.pause()
      monitorAudioRef.current.srcObject = null
      monitorAudioRef.current.remove()
      monitorAudioRef.current = null
    }
    setAudioLevels(new Map())
  }, [cleanupRemote])

  const leave = useCallback(() => {
    roomRef.current?.disconnect()
    teardown()
    setJoined(false)
    setMembers([])
    setVoiceMutedIds(new Set())
    setMonitorEnabled(false)
  }, [teardown])

  const join = useCallback(async () => {
    const currentRoomId = roomId
    if (!currentRoomId || joining || joined) return
    setJoining(true)
    try {
      // 1. 后端签发 LiveKit 接入凭证（鉴权在服务端完成）
      const res = await apiFetch('/api/voice/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: currentRoomId, username }),
      })
      const data = (await res.json()) as {
        success: boolean
        url?: string
        token?: string
        message?: string
      }
      if (!data.success || !data.url || !data.token) {
        throw new Error(data.message ?? '获取语音凭证失败')
      }

      // 2. 采集链：单声道 + AEC/NS/AGC，micGain 控制输入音量。
      //    注意：不强制 AudioContext sampleRate——强制 48k 会在硬件速率
      //    不同的声卡（典型如 44.1k 设备/蓝牙 HFP）上造成采集→上下文
      //    的双重重采样，反送/发布出现周期性 underrun 卡顿。LiveKit
      //    对采集速率无要求，用硬件默认速率即可。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        } as MediaTrackConstraints,
      })
      localStreamRef.current = stream
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const micGain = ctx.createGain()
      micGain.gain.value = micVolume
      source.connect(micGain)
      // 产流目的地：发布给 LiveKit 的轨
      const produceDest = ctx.createMediaStreamDestination()
      micGain.connect(produceDest)
      // 反送备用通路（Firefox 专用，见 monitorEnabled 同步 effect）：
      // Firefox 媒体元素播放实时 MediaStream 有缓冲积压缺陷会卡顿，
      // 改走上下文直连输出。Chrome 保持元素路径（工作正常）。
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

      // 3. 连接 LiveKit 房间（断线重连由 SDK 原生处理）
      const room = new Room()
      roomRef.current = room

      const track = produceDest.stream.getAudioTracks()[0]
      track.enabled = micEnabled

      room
        .on(
          RoomEvent.TrackSubscribed,
          (remoteTrack: RemoteTrack, _pub, participant: RemoteParticipant) => {
            attachRemote(participant, remoteTrack)
          }
        )
        .on(
          RoomEvent.TrackUnsubscribed,
          (remoteTrack: RemoteTrack, _pub, participant: RemoteParticipant) => {
            const entry = remoteRef.current.get(participant.identity)
            if (entry) entry.stream.removeTrack(remoteTrack.mediaStreamTrack)
          }
        )
        .on(RoomEvent.ParticipantConnected, () => refreshMembers(room))
        .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
          cleanupRemote(p.identity)
          refreshMembers(room)
        })
        .on(
          RoomEvent.ParticipantMetadataChanged,
          (_meta: string, p?: RemoteParticipant) => {
            const muted = refreshMembers(room)
            // 自己被解禁时自动恢复麦克风；被禁言时立即静音
            const isSelf = !p || p.identity === room.localParticipant.identity
            if (isSelf) {
              const isAdminMuted = muted.has(room.localParticipant.identity)
              track.enabled = !isAdminMuted && micEnabled
              setMicEnabled(!isAdminMuted && micEnabled)
              if (isAdminMuted) message.warning('您已被管理员语音禁言')
              else message.success('语音禁言已解除')
            }
          }
        )
        .on(RoomEvent.Disconnected, () => {
          // 服务器踢出/房间关闭：SDK 已断开，仅复位 UI
          setJoined(false)
          setMembers([])
        })

      await room.connect(data.url, data.token)
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        // 高音质发布档：SDK 默认按语音会议档（~24-32kbps+DTX）编码，
        // 听感发闷。music 档为 48kbps 全带宽 Opus；关闭 DTX 避免静音
        // 段落切换时的音质劣化感；保留 RED 冗余抗丢包
        audioPreset: AudioPresets.music,
        dtx: false,
        red: true,
      })
      setSelfId(room.localParticipant.identity)
      micTrackRef.current = track
      refreshMembers(room)

      setJoined(true)
      setMicEnabled(track.enabled)
    } catch (err) {
      console.error('[voice] join error:', err)
      message.error(err instanceof Error ? err.message : '加入语音聊天失败')
      teardown()
    } finally {
      setJoining(false)
    }
  }, [
    attachRemote,
    cleanupRemote,
    joining,
    joined,
    micEnabled,
    micVolume,
    refreshMembers,
    roomId,
    teardown,
    username,
  ])

  // ==================== 控制方法 ====================

  const toggleMic = useCallback(() => {
    const track = micTrackRef.current
    if (!track) return
    // 管理员禁言（metadata 标记）期间禁止开麦
    const room = roomRef.current
    let adminMuted = false
    try {
      adminMuted =
        JSON.parse(room?.localParticipant.metadata ?? '{}')?.adminMuted === true
    } catch {
      /* ignore */
    }
    if (adminMuted) {
      message.warning('您已被管理员语音禁言')
      return
    }
    track.enabled = !track.enabled
    setMicEnabled(track.enabled)
  }, [])

  const toggleMonitor = useCallback(() => {
    setMonitorEnabled((prev) => !prev)
  }, [])

  // 反送按浏览器分派：
  // - Chromium：原始 gUM 流经 <audio> 元素播放（单一采集时钟，工作正常）
  // - Firefox：元素播放实时 MediaStream 有缓冲积压缺陷（周期性卡顿），
  //   改走 AudioContext 直连输出（monitorGain 门控，位于 micGain 下游，
  //   输入音量同样生效）
  const isFirefox = /firefox/i.test(navigator.userAgent)
  useEffect(() => {
    const on = joined && monitorEnabled
    if (isFirefox) {
      if (monitorGainRef.current) monitorGainRef.current.gain.value = on ? 1 : 0
      monitorAudioRef.current?.pause()
      return
    }
    if (!on) {
      monitorAudioRef.current?.pause()
      return
    }
    const stream = localStreamRef.current
    if (!stream) return
    if (!monitorAudioRef.current) {
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.dataset.voiceMonitor = 'self'
      audio.style.display = 'none'
      document.body.appendChild(audio)
      monitorAudioRef.current = audio
    }
    const audio = monitorAudioRef.current
    if (audio.srcObject !== stream) audio.srcObject = stream
    audio.volume = micVolume
    void audio.play().catch(() => {})
  }, [joined, monitorEnabled, micVolume, isFirefox])

  const setGlobalVolume = useCallback(
    (value: number) => {
      const clamped = Math.max(0, Math.min(1, value))
      setGlobalVolumeState(clamped)
      globalVolumeRef.current = clamped
      for (const id of Array.from(remoteRef.current.keys())) applyVolume(id)
    },
    [applyVolume]
  )

  const setPeerVolume = useCallback((id: string, value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setPeerVolumes((prev) => new Map(prev).set(id, clamped))
    peerVolumesRef.current.set(id, clamped)
    const entry = remoteRef.current.get(id)
    if (entry)
      entry.audio.volume = Math.max(
        0,
        Math.min(1, clamped * globalVolumeRef.current)
      )
  }, [])

  const setMicVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setMicVolumeState(clamped)
    if (micGainRef.current) micGainRef.current.gain.value = clamped
    if (monitorAudioRef.current) monitorAudioRef.current.volume = clamped
  }, [])

  // ==================== 管理操作（REST，权限在服务端校验） ====================

  const muteVoiceMember = useCallback(
    async (id: string, muted: boolean) => {
      const res = await apiFetch('/api/voice/mute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, identity: id, muted }),
      })
      return (await res.json()) as { success: boolean; message?: string }
    },
    [roomId]
  )

  const kickVoiceMember = useCallback(
    async (id: string) => {
      const res = await apiFetch('/api/voice/kick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, identity: id }),
      })
      return (await res.json()) as { success: boolean; message?: string }
    },
    [roomId]
  )

  // ==================== 电平检测 ====================

  useEffect(() => {
    if (!joined) return
    const read = (a: AnalyserNode | null): number => {
      if (!a) return 0
      const data = new Uint8Array(a.frequencyBinCount)
      a.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      return Math.min(1, Math.sqrt(sum / data.length) * 4)
    }
    const timer = setInterval(() => {
      const next = new Map<string, number>()
      next.set('self', read(localAnalyserRef.current))
      for (const [id, entry] of remoteRef.current)
        next.set(id, read(entry.analyser))
      setAudioLevels(next)
    }, 200)
    return () => clearInterval(timer)
  }, [joined])

  // 卸载兜底（AudioContext.close 二次关闭走 Promise 拒绝，须显式 catch）
  useEffect(() => {
    return () => {
      try {
        void roomRef.current?.disconnect()
      } catch {
        /* ignore */
      }
      captureCtxRef.current?.close().catch(() => {})
      captureCtxRef.current = null
      levelsCtxRef.current?.close().catch(() => {})
      levelsCtxRef.current = null
    }
  }, [])

  return {
    joined,
    joining,
    micEnabled,
    /** 自己的成员 id（LiveKit identity），面板用它判定“我” */
    selfId,
    members,
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
