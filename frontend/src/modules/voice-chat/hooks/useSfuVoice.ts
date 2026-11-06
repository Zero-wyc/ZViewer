/**
 * 语音聊天（自建 SFU 版）。
 *
 * 与 LiveKit 版的对外形状完全一致（`VoiceChatController`），面板不需要知道
 * 当前跑的是哪条实现。媒体面是服务端的 `internal/share/sfu` 语音部分，
 * 信令走 socket.io 的单一 `voice` 事件（`internal/voicertc`）。
 *
 * 拓扑：每位成员一条到服务端的 RTCPeerConnection，上行自己的麦克风、
 * 下行其他人的全部。**服务端发 offer，客户端只应答**——客户端永远不主动
 * 协商，因此不可能出现 glare。
 *
 * 依赖的三个事实（改服务端前务必确认）：
 *  1. offer 的 `tracks[]` 列出每个 m-line 的 mid 与 publicationId；其中
 *     publicationId == `voice_<自己的 socketId>` 的那条就是「我发」的 m-line。
 *  2. answer 必须原样带回 offer 的 `revision`，否则服务端判定为过期直接拒绝。
 *  3. answer 的 `tracks[]` 只能列**自己真正发**的那一条，多列会被判非法。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { t } from '@/i18n'
import {
  buildAnswerPayload,
  ownSendMid,
  peerOfPublication,
  type VoiceDescription,
} from '../lib/protocol'
import { detectTransportProtocol } from '../lib/transport'
import type {
  UseVoiceChatOptions,
  VoiceChatController,
  VoiceMember,
  VoiceTransport,
} from '../types'

/** 语音在 socket.io 上的唯一事件名，与服务端 `voicertc.Event` 一致。 */
const VOICE_EVENT = 'voice'

/** 媒体通道（ICE）建立失败判定窗口：超过仍未连通即提示，不再傻等。 */
const MEDIA_WATCHDOG_TIMEOUT_MS = 10_000

/** 暂存上限：state 到达前 / 远端描述就位前的信令，防止对端灌爆内存。 */
const MAX_PENDING_SIGNALS = 64
const MAX_PENDING_CANDIDATES = 64

/** 服务端下发的中继信令。 */
interface VoiceSignalMessage {
  t: 'voice.signal'
  roomId: string
  connectionId: string
  kind: 'description' | 'candidate'
  payload: unknown
}

/** 服务端下发的状态快照。 */
interface VoiceStateMessage {
  t: 'voice.state'
  roomId: string
  revision: number
  self: { peerId: string; connectionId: string; muted: boolean }
  members: { peerId: string; name?: string; muted: boolean }[]
}

interface VoiceMutedMessage {
  t: 'voice.muted'
  peerId: string
  muted: boolean
}

interface VoiceKickedMessage {
  t: 'voice.kicked'
  peerId: string
  reason: string
}

interface VoiceErrorMessage {
  t: 'voice.error'
  code: string
  message: string
}

type VoiceServerMessage =
  | VoiceSignalMessage
  | VoiceStateMessage
  | VoiceMutedMessage
  | VoiceKickedMessage
  | VoiceErrorMessage

export function useSfuVoice({
  roomId,
  username,
  socket,
  enabled = true,
}: UseVoiceChatOptions & {
  socket: Socket | null
  enabled?: boolean
}): VoiceChatController {
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
  const [transport, setTransport] = useState<VoiceTransport | null>(null)
  const [mediaConnected, setMediaConnected] = useState(false)
  const [selfId, setSelfId] = useState<string | null>(null)

  // socket 走 ref 是为了让 sendVoice 保持稳定引用（它被包进多个 useCallback）。
  // 赋值放进 effect：render 期写 ref 会被 react-hooks/refs 拦下，
  // 而且 render 期写入本来就不该有副作用。
  const socketRef = useRef<Socket | null>(null)
  useEffect(() => {
    socketRef.current = socket
  }, [socket])
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const connectionIdRef = useRef('')
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  const captureCtxRef = useRef<AudioContext | null>(null)
  const micGainRef = useRef<GainNode | null>(null)
  const monitorAudioRef = useRef<HTMLAudioElement | null>(null)
  const monitorGainRef = useRef<GainNode | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const levelsCtxRef = useRef<AudioContext | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)
  /** 成员 id → 播放/分析状态。 */
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
  /** mid → publicationId，来自最近一次 offer 的 tracks。 */
  const midMapRef = useRef<Map<string, string>>(new Map())
  /**
   * `voice.state` 到达之前收到的信令。
   *
   * 服务端要先算完计划才推状态，`voice.signal` 与 `voice.state` 的先后并不
   * 由客户端控制：state 还没到就没有 connectionId 可比对，直接按「不认识」
   * 丢掉的动作会把第一个 offer 一起丢掉——表现是「在语音里但永远连不上」。
   */
  const pendingSignalsRef = useRef<VoiceSignalMessage[]>([])
  /** 早于 offer 到达的 ICE 候选（服务端 trickle，客户端可能先收到候选）。 */
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([])
  /** 应答必须原样带回 offer 的 revision。 */
  const offerRevisionRef = useRef(0)
  const lastRevisionRef = useRef(0)
  /** 协商串行化：客户端只应答，但多次 re-offer 仍可能叠加。 */
  const descriptionTailRef = useRef<Promise<void>>(Promise.resolve())
  /** 用户想待在语音里（socket 重连后据此自动恢复）。 */
  const wantJoinedRef = useRef(false)
  const globalVolumeRef = useRef(1)
  const peerVolumesRef = useRef<Map<string, number>>(new Map())
  const micVolumeRef = useRef(1)
  const micEnabledRef = useRef(true)
  const selfIdRef = useRef<string | null>(null)

  // ==================== 发送 ====================

  const sendVoice = useCallback((payload: Record<string, unknown>): void => {
    const active = socketRef.current
    if (!active?.connected) return
    // 直接发对象，**不要** JSON.stringify：Socket.IO 本身就是 JSON 传输，
    // 再 stringify 一次会变成「字符串里裹着 JSON」，服务端 `DecodeClient`
    // 收到的是 string 而不是 map，整条 voice 协议会被判 INVALID_MESSAGE 丢弃
    //（实测报错：json: cannot unmarshal string into Go value of type
    // map[string]json.RawMessage）。共享信令踩过同一个坑。
    active.emit(VOICE_EVENT, payload)
  }, [])

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

  const cleanupRemote = useCallback((id: string) => {
    const entry = remoteRef.current.get(id)
    if (!entry) return
    remoteRef.current.delete(id)
    entry.audio.pause()
    entry.audio.srcObject = null
    entry.audio.remove()
  }, [])

  /** 把一条远端音轨挂到该成员专属的 <audio> 上（重订阅不重复建）。 */
  const attachRemote = useCallback(
    (id: string, track: MediaStreamTrack) => {
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
          source.connect(analyser) // 仅观测，出声由 <audio> 负责
        } catch {
          /* 电平分析失败不影响收听 */
        }
        entry = { audio, stream, analyser }
        remoteRef.current.set(id, entry)
        applyVolume(id)
      }
      if (!entry.stream.getTracks().includes(track)) {
        entry.stream.addTrack(track)
      }
      entry.audio.srcObject = entry.stream
      // 自动播放可能被拦：加入动作本身是用户手势，通常能过；失败就静默，
      // 面板上有「音量」可让用户再点一次。
      void entry.audio.play().catch(() => {})
    },
    [applyVolume]
  )

  // ==================== 媒体通道监看 ====================

  const watchdogRef = useRef<number | null>(null)

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      window.clearInterval(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const armWatchdog = useCallback(() => {
    clearWatchdog()
    const startedAt = Date.now()
    watchdogRef.current = window.setInterval(() => {
      const pc = pcRef.current
      const connected =
        !!pc &&
        (pc.connectionState === 'connected' ||
          pc.iceConnectionState === 'connected' ||
          pc.iceConnectionState === 'completed')
      if (connected) {
        clearWatchdog()
        setMediaConnected(true)
        return
      }
      if (Date.now() - startedAt > MEDIA_WATCHDOG_TIMEOUT_MS) {
        clearWatchdog()
        setMediaConnected(false)
        message.warning(t('媒体通道未建立，请检查网络（可尝试关闭代理/VPN）'), {
          duration: 8000,
        })
      }
    }, 500)
  }, [clearWatchdog])

  // ==================== 协商 ====================

  /** 依次处理应答，避免两次 offer 的 createAnswer 交错。 */
  const enqueue = useCallback((task: () => Promise<void>) => {
    descriptionTailRef.current = descriptionTailRef.current
      .then(task)
      .catch((err: unknown) => {
        console.warn('[voice] negotiation failed', err)
      })
  }, [])

  /** 把排队的候选补进已就位的远端描述。过期候选直接忽略。 */
  const flushCandidates = useCallback(async (pc: RTCPeerConnection) => {
    const candidates = pendingCandidatesRef.current.splice(0)
    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(candidate)
      } catch {
        /* 过期/重复候选不影响后续连通 */
      }
    }
  }, [])

  const answerOffer = useCallback(
    async (description: VoiceDescription) => {
      const pc = pcRef.current
      if (!pc) return
      if (pc.signalingState === 'have-local-offer') return
      if (description.revision <= lastRevisionRef.current) {
        // 迟到的旧 offer：版本比已应用的低，直接丢。
        return
      }
      // mid → publication 必须在 setRemoteDescription **之前**就位：
      // ontrack 是在 setRemoteDescription 内部触发的。
      const midMap = new Map<string, string>()
      for (const track of description.tracks) {
        midMap.set(track.mid, track.publicationId)
      }
      midMapRef.current = midMap
      offerRevisionRef.current = description.revision

      await pc.setRemoteDescription(description.sdp)
      await flushCandidates(pc)

      // 自己那条 m-line：把麦克风挂上去。必须在 createAnswer 之前，
      // 否则 answer 会把它标成不发送，服务端就永远收不到我的声音。
      const self = selfIdRef.current
      const sendMid = ownSendMid(description, self)
      const track = micTrackRef.current
      let bound = false
      if (sendMid && track) {
        const transceiver = pc
          .getTransceivers()
          .find((item) => item.mid === sendMid)
        if (transceiver?.sender) {
          track.enabled = micEnabledRef.current
          if (transceiver.sender.track !== track) {
            await transceiver.sender.replaceTrack(track)
          }
          // 兜底：万一浏览器把这条 m-line 的方向留成了 recvonly
          // （addTrack 未按预期关联），显式改成只发。
          if (transceiver.direction === 'recvonly') {
            transceiver.direction = 'sendonly'
          }
          bound = true
        }
      }

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      lastRevisionRef.current = description.revision

      sendVoice({
        t: 'voice.signal',
        roomId,
        connectionId: connectionIdRef.current,
        kind: 'description',
        payload: buildAnswerPayload({
          description,
          sdp: pc.localDescription?.sdp ?? answer.sdp,
          selfPeerID: self,
          sendMid,
          bound,
        }),
      })
    },
    [flushCandidates, roomId, sendVoice]
  )

  /** 真正把一条信令喂给 PC（connectionId 已确认过）。 */
  const dispatchSignal = useCallback(
    (incoming: VoiceSignalMessage) => {
      if (incoming.kind === 'description') {
        const description = incoming.payload as VoiceDescription
        if (!description?.sdp || description.sdp.type !== 'offer') return
        enqueue(() => answerOffer(description))
        return
      }
      const candidate = incoming.payload as RTCIceCandidateInit
      if (!candidate?.candidate) return
      const pc = pcRef.current
      if (!pc) return
      // 候选可能早于 offer 到达（服务端是 trickle）：此时 addIceCandidate 会
      // 因为没有远端描述直接抛错，而候选本身完全有效。先排队，等
      // setRemoteDescription 之后统一补——否则会整批丢掉连通性最关键的候选。
      if (!pc.remoteDescription) {
        if (pendingCandidatesRef.current.length < MAX_PENDING_CANDIDATES) {
          pendingCandidatesRef.current.push(candidate)
        }
        return
      }
      void pc.addIceCandidate(candidate).catch(() => {
        // 候选晚到/已过期很常见，不需要打扰用户。
      })
    },
    [answerOffer, enqueue]
  )

  const handleSignal = useCallback(
    (incoming: VoiceSignalMessage) => {
      // state 未到：还不知道自己的 connectionId，先存着，别把第一个 offer 丢掉。
      if (!connectionIdRef.current) {
        if (pendingSignalsRef.current.length < MAX_PENDING_SIGNALS) {
          pendingSignalsRef.current.push(incoming)
        }
        return
      }
      // 信令只认自己那条连接：拿别人的 connectionId 一律丢弃（回错误等于
      // 确认这个 id 存在）。
      if (incoming.connectionId !== connectionIdRef.current) return
      dispatchSignal(incoming)
    },
    [dispatchSignal]
  )

  // ==================== 状态与成员 ====================

  const applyState = useCallback(
    (state: VoiceStateMessage) => {
      connectionIdRef.current = state.self.connectionId
      setSelfId(state.self.peerId)
      selfIdRef.current = state.self.peerId

      // 身份坐实后，把 state 之前收到的信令补进协商队列。顺序很重要：
      // `answerOffer` 要先知道自己是谁才能认出「我发」的那条 m-line。
      const buffered = pendingSignalsRef.current.splice(0)
      for (const signal of buffered) {
        if (signal.connectionId !== state.self.connectionId) continue
        dispatchSignal(signal)
      }

      const nextMembers: VoiceMember[] = state.members.map((member) => ({
        id: member.peerId,
        username:
          member.peerId === state.self.peerId
            ? t('我')
            : member.name?.trim() || t('成员'),
      }))
      setMembers(nextMembers)

      const muted = new Set<string>()
      for (const member of state.members) {
        if (member.muted) muted.add(member.peerId)
      }
      setVoiceMutedIds(muted)

      // 强制静音期间本地麦克风必须真的关掉，否则「被静音」只是 UI 上的字。
      const selfMuted = muted.has(state.self.peerId)
      const track = micTrackRef.current
      if (track) {
        track.enabled = !selfMuted && micEnabledRef.current
      }
      if (selfMuted && micEnabledRef.current) setMicEnabled(false)
      if (!selfMuted && !micEnabledRef.current) setMicEnabled(true)

      // 离开的人：把他的播放元素收掉，否则会留一条永久静音的轨。
      const alive = new Set(state.members.map((member) => member.peerId))
      for (const id of Array.from(remoteRef.current.keys())) {
        if (!alive.has(id)) cleanupRemote(id)
      }
    },
    [cleanupRemote, dispatchSignal]
  )

  // ==================== 加入 / 离开 ====================

  const teardownMedia = useCallback(() => {
    clearWatchdog()
    pcRef.current?.close()
    pcRef.current = null
    connectionIdRef.current = ''
    midMapRef.current = new Map()
    lastRevisionRef.current = 0
    pendingSignalsRef.current = []
    pendingCandidatesRef.current = []
    for (const id of Array.from(remoteRef.current.keys())) cleanupRemote(id)
  }, [clearWatchdog, cleanupRemote])

  const releaseCapture = useCallback(() => {
    micTrackRef.current = null
    captureCtxRef.current?.close().catch(() => {})
    captureCtxRef.current = null
    micGainRef.current = null
    monitorGainRef.current = null
    localAnalyserRef.current = null
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    if (monitorAudioRef.current) {
      monitorAudioRef.current.pause()
      monitorAudioRef.current.srcObject = null
      monitorAudioRef.current.remove()
      monitorAudioRef.current = null
    }
  }, [])

  const leave = useCallback(() => {
    wantJoinedRef.current = false
    if (socketRef.current?.connected && roomId) {
      sendVoice({ t: 'voice.leave', roomId })
    }
    teardownMedia()
    releaseCapture()
    setJoined(false)
    setMediaConnected(false)
    setMembers([])
    setVoiceMutedIds(new Set())
    setMonitorEnabled(false)
    setTransport(null)
    setSelfId(null)
    selfIdRef.current = null
    setAudioLevels(new Map())
  }, [releaseCapture, roomId, sendVoice, teardownMedia])

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
    // 不强制 AudioContext 采样率：硬件是 44.1k（蓝牙 HFP 尤其常见）时，
    // 强制 48k 会造成采集→上下文双重重采样，反送和上行都会周期性卡顿。
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

  /** 建 PC 并发出 join。麦克风轨在收到 offer 后由 answerOffer 挂上。 */
  const startSession = useCallback(() => {
    const active = socketRef.current
    if (!active?.connected || !roomId || !micTrackRef.current) return
    teardownMedia()

    // iceServers 留空：媒体面就在服务端，它对端给出的是可直接连通的候选。
    // 服务端部署在 NAT 后面时由 SHARE_MEDIA_PUBLIC_IP 提供 1:1 地址。
    const pc = new RTCPeerConnection({ iceServers: [] })
    pcRef.current = pc
    // 先 addTrack 再等 offer：从远端 recvonly 的 m-line 建出来的 transceiver
    // 默认方向是 recvonly，只 replaceTrack 不会真的发送——answer 里那条 m-line
    // 会变成 inactive，服务端永远收不到声音。提前 addTrack 让浏览器在应用
    // offer 时把这条本地轨关联到可接收的 m-line 上，方向随之变成 sendonly。
    const track = micTrackRef.current
    if (track) pc.addTrack(track)

    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      sendVoice({
        t: 'voice.signal',
        roomId,
        connectionId: connectionIdRef.current,
        kind: 'candidate',
        payload: event.candidate.toJSON(),
      })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setMediaConnected(true)
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        setMediaConnected(false)
      }
    }
    pc.ontrack = (event) => {
      const mid = event.transceiver.mid
      if (!mid) return
      const publication = midMapRef.current.get(mid)
      const peer = publication ? peerOfPublication(publication) : null
      if (!peer) return
      attachRemote(peer, event.track)
    }

    sendVoice({
      t: 'voice.join',
      roomId,
      name: username ?? '',
    })
    armWatchdog()
  }, [armWatchdog, attachRemote, roomId, sendVoice, teardownMedia, username])

  const join = useCallback(async () => {
    // enabled=false 表示这条链路没被选中（当前语音由 Piik 承载）。
    if (!enabled || !roomId || joining || joined) return
    if (!socketRef.current?.connected) {
      message.error(t('实时连接未就绪，请稍后重试'))
      return
    }
    setJoining(true)
    try {
      const track = await startCapture()
      micTrackRef.current = track
      wantJoinedRef.current = true
      startSession()
      setJoined(true)
      setMicEnabled(track.enabled)
    } catch (err) {
      console.error('[voice] join error:', err)
      message.error(err instanceof Error ? err.message : t('加入语音聊天失败'))
      releaseCapture()
    } finally {
      setJoining(false)
    }
  }, [
    enabled,
    joined,
    joining,
    releaseCapture,
    roomId,
    startCapture,
    startSession,
  ])

  // ==================== socket 事件 ====================

  useEffect(() => {
    if (!socket) return

    const onMessage = (raw: unknown) => {
      // 服务端发的是 JSON **对象**（`hub.EmitTo` 直接传 Go struct）。只认字符串
      // 会把整条下行丢弃——「加入了但永远收不到 state / offer」就是这么来的。
      // 字符串分支留着兼容旧服务端/代理二次编码的形态。
      let parsed: VoiceServerMessage | null = null
      if (typeof raw === 'string') {
        try {
          parsed = JSON.parse(raw) as VoiceServerMessage
        } catch {
          return
        }
      } else if (raw !== null && typeof raw === 'object') {
        parsed = raw as VoiceServerMessage
      }
      if (!parsed || typeof parsed.t !== 'string') return
      switch (parsed.t) {
        case 'voice.state':
          applyState(parsed)
          return
        case 'voice.signal':
          handleSignal(parsed)
          return
        case 'voice.muted':
          if (parsed.peerId === selfIdRef.current) {
            if (parsed.muted) {
              message.warning(t('您已被管理员语音禁言'))
            } else {
              message.success(t('语音禁言已解除'))
            }
          }
          return
        case 'voice.kicked':
          if (parsed.peerId === selfIdRef.current) {
            message.warning(t('您已被移出语音聊天'))
            leave()
          }
          return
        case 'voice.error':
          // 语音的 `voice` 事件是即发即忘，失败只能靠这条回来。
          if (parsed.message) message.error(parsed.message)
          return
        default:
          return
      }
    }

    const onDisconnect = () => {
      // socket 断了媒体也活不了：先摘掉 PC，但保留麦克风采集，
      // 重连后直接重建会话，用户不用再授权一次。
      teardownMedia()
      setMediaConnected(false)
      if (wantJoinedRef.current) {
        message.warning(t('与服务器的连接已断开，正在重连...'), {
          duration: 5000,
        })
      }
    }

    const onConnect = () => {
      if (wantJoinedRef.current && micTrackRef.current && !pcRef.current) {
        startSession()
      }
    }

    socket.on(VOICE_EVENT, onMessage)
    socket.on('disconnect', onDisconnect)
    socket.on('connect', onConnect)
    return () => {
      socket.off(VOICE_EVENT, onMessage)
      socket.off('disconnect', onDisconnect)
      socket.off('connect', onConnect)
    }
  }, [applyState, handleSignal, leave, socket, startSession, teardownMedia])

  // ==================== 控制方法 ====================

  const toggleMic = useCallback(() => {
    if (voiceMutedIds.has(selfIdRef.current ?? '')) {
      message.warning(t('您已被管理员语音禁言'))
      return
    }
    const track = micTrackRef.current
    if (!track) return
    track.enabled = !track.enabled
    setMicEnabled(track.enabled)
    micEnabledRef.current = track.enabled
  }, [voiceMutedIds])

  const toggleMonitor = useCallback(() => {
    setMonitorEnabled((prev) => !prev)
  }, [])

  // 反送按浏览器分派（与 LiveKit 版一致）：
  // - Chromium：gUM 原始流经 <audio> 播放（单一采集时钟）
  // - Firefox：元素播放实时 MediaStream 有缓冲积压缺陷，改走上下文直连
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
    audio.volume = micVolumeRef.current
    void audio.play().catch(() => {})
  }, [joined, monitorEnabled, isFirefox])

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
    micVolumeRef.current = clamped
    if (micGainRef.current) micGainRef.current.gain.value = clamped
    if (monitorAudioRef.current) monitorAudioRef.current.volume = clamped
  }, [])

  // ==================== 管理操作 ====================

  const muteVoiceMember = useCallback(
    async (id: string, muted: boolean) => {
      if (!roomId) return { success: false, message: t('未在房间中') }
      sendVoice({ t: 'voice.mute', roomId, peerId: id, muted })
      // 权限与结果由服务端推 voice.state / voice.error 回来；
      // 面板不需要 await 一个可能永远不来的 ack。
      return { success: true }
    },
    [roomId, sendVoice]
  )

  const kickVoiceMember = useCallback(
    async (id: string) => {
      if (!roomId) return { success: false, message: t('未在房间中') }
      sendVoice({ t: 'voice.kick', roomId, peerId: id })
      return { success: true }
    },
    [roomId, sendVoice]
  )

  // ==================== 电平检测 ====================

  useEffect(() => {
    if (!joined) return
    const read = (analyser: AnalyserNode | null): number => {
      if (!analyser) return 0
      const data = new Uint8Array(analyser.frequencyBinCount)
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sum += v * v
      }
      return Math.min(1, Math.sqrt(sum / data.length) * 4)
    }
    const timer = window.setInterval(() => {
      const next = new Map<string, number>()
      next.set('self', read(localAnalyserRef.current))
      for (const [id, entry] of remoteRef.current)
        next.set(id, read(entry.analyser))
      setAudioLevels(next)
    }, 200)
    return () => window.clearInterval(timer)
  }, [joined])

  // ==================== 传输协议检测 ====================

  useEffect(() => {
    if (!joined) return
    let cancelled = false
    const run = async () => {
      const protocol = await detectTransportProtocol(pcRef.current)
      if (cancelled || !protocol) return
      setTransport(protocol)
    }
    const timer = window.setTimeout(() => void run(), 2500)
    const interval = window.setInterval(() => void run(), 15000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [joined])

  // 卸载兜底：AudioContext.close 二次关闭走 Promise 拒绝，须显式 catch。
  useEffect(() => {
    return () => {
      clearWatchdog()
      pcRef.current?.close()
      pcRef.current = null
      captureCtxRef.current?.close().catch(() => {})
      captureCtxRef.current = null
      levelsCtxRef.current?.close().catch(() => {})
      levelsCtxRef.current = null
    }
  }, [clearWatchdog])

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
