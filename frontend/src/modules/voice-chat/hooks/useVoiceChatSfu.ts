/**
 * 语音聊天 Hook（mediasoup SFU 传输版，v6 传输层重写）。
 *
 * 接口与 useVoiceChat（WebSocket 中转版）完全一致，VoiceChatPanel
 * 无需改动即可切换；旧版保留用于回退（改一行 import）。
 *
 * 传输层：
 * - 上行：getUserMedia → AudioContext 处理链（micGain 音量 / 监听 /
 *   电平分析）→ MediaStreamDestination → mediasoup sendTransport.produce
 *   （WebRTC UDP，浏览器拥塞控制）
 * - 下行：recvTransport.consume → 每成员 `<audio srcObject>`，播放侧的
 *   抖动缓冲与丢包补偿由浏览器 NetEQ 原生承担（取代自研 PLC 管线，
 *   根治 TCP 队头阻塞导致的秒级 gap）
 * - 自闭麦：track.enabled = false（浏览器发送静音帧，不触发任何服务端
 *   请求；不改用 producer.pause——其 resume 请求无法被服务器拒绝，
 *   会让管理员禁言失效）。管理员禁言仍由服务器 producer.pause 强制。
 * - 延迟指标：consumer.getStats() 的 jitterBufferDelay（播放侧抖动
 *   缓冲延迟，真实反映听感延迟）
 *
 * 业务语义与旧版一致：voice-join/leave/mute/kick 事件、成员表（UI 以
 * 主连接 socketId 为键）、禁言集合同步、被踢处理、断线自动重加入。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Device } from 'mediasoup-client'
import type { Transport, Producer, Consumer } from 'mediasoup-client/types'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { getVoiceInstanceId } from '../lib/multiInstance'
import type {
  UseVoiceChatOptions,
  UseVoiceChatResult,
  VoiceMember,
} from './useVoiceChat'

// 类型透传：面板从本模块导入，保持接口来源单一
export type { UseVoiceChatOptions, UseVoiceChatResult, VoiceMember }

const LEVELS_INTERVAL_MS = 200
const LATENCY_INTERVAL_MS = 3000

/** 应答包装：socket.io ack → Promise */
function emitAck<T>(
  socket: Socket,
  event: string,
  payload: unknown
): Promise<T> {
  return new Promise<T>((resolve) => {
    socket.emit(event, payload, (res: T) => resolve(res))
  })
}

interface SfuConsumerEntry {
  consumer: Consumer
  /** 生产者归属成员的主连接 socketId（UI 成员键） */
  memberSocketId: string
  stream: MediaStream
  audio: HTMLAudioElement
  analyser: AnalyserNode | null
}

export function useVoiceChatSfu({
  socket,
  roomId,
  username,
}: UseVoiceChatOptions): UseVoiceChatResult {
  // ==================== UI 状态（与旧版同构） ====================
  const [joined, setJoined] = useState(false)
  const [joining, setJoining] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [members, setMembers] = useState<VoiceMember[]>([])
  const [globalVolume, setGlobalVolumeState] = useState(1)
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map())
  const [peerLatencies, setPeerLatencies] = useState<Map<string, number>>(
    new Map()
  )
  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map())
  const [voiceMutedBySocket, setVoiceMutedBySocket] = useState<Set<string>>(
    new Set()
  )
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [micVolume, setMicVolumeState] = useState(1)

  // ==================== refs ====================
  const socketRef = useRef<Socket | null>(socket)
  const roomIdRef = useRef<string | undefined>(roomId)
  const usernameRef = useRef<string | undefined>(username)
  const joinedRef = useRef(false)
  const joiningRef = useRef(false)
  const micEnabledRef = useRef(true)
  const selfMutedRef = useRef(false)
  const micVolumeRef = useRef(1)
  const globalVolumeRef = useRef(1)
  const peerVolumesRef = useRef<Map<string, number>>(new Map())
  const monitorEnabledRef = useRef(false)

  const deviceRef = useRef<Device | null>(null)
  const sendTransportRef = useRef<Transport | null>(null)
  const recvTransportRef = useRef<Transport | null>(null)
  const producerRef = useRef<Producer | null>(null)
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  /** socketId → 远端播放/分析状态 */
  const remoteRef = useRef<Map<string, SfuConsumerEntry>>(new Map())
  const captureCtxRef = useRef<AudioContext | null>(null)
  const levelsCtxRef = useRef<AudioContext | null>(null)
  const micGainRef = useRef<GainNode | null>(null)
  const monitorGainRef = useRef<GainNode | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    socketRef.current = socket
    roomIdRef.current = roomId
    usernameRef.current = username
  }, [socket, roomId, username])

  // ==================== 音频工具 ====================

  const applyRemoteVolume = useCallback((memberSocketId: string) => {
    const entry = remoteRef.current.get(memberSocketId)
    if (!entry) return
    const peer = peerVolumesRef.current.get(memberSocketId) ?? 1
    const v = Math.max(0, Math.min(1, peer * globalVolumeRef.current))
    entry.audio.volume = v
  }, [])

  const readLevel = (analyser: AnalyserNode | null): number => {
    if (!analyser) return 0
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    return Math.min(1, rms * 4)
  }

  // ==================== 远端播放链路 ====================

  /** 为远端轨创建播放/分析链路（<audio> + 电平 analyser），返回条目 */
  const attachRemoteAudio = useCallback(
    (memberSocketId: string, track: MediaStreamTrack): SfuConsumerEntry => {
      // 同成员已有链路：复用，仅替换轨（重连场景）
      const existing = remoteRef.current.get(memberSocketId)
      if (existing) {
        existing.stream.addTrack(track)
        existing.audio.srcObject = existing.stream
        void existing.audio.play().catch(() => {})
        return existing
      }

      const stream = new MediaStream([track])
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.dataset.voiceMember = memberSocketId
      audio.style.display = 'none'
      audio.srcObject = stream
      document.body.appendChild(audio)

      let analyser: AnalyserNode | null = null
      if (!levelsCtxRef.current) {
        levelsCtxRef.current = new AudioContext()
      }
      try {
        const source = levelsCtxRef.current.createMediaStreamSource(stream)
        analyser = levelsCtxRef.current.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.6
        source.connect(analyser)
        // 不连 destination：音频由 <audio> 元素播放，analyser 仅观测
      } catch (err) {
        console.warn('[voice-sfu] analyser 创建失败:', err)
      }

      const entry: SfuConsumerEntry = {
        consumer: null as unknown as Consumer,
        memberSocketId,
        stream,
        audio,
        analyser,
      }
      applyRemoteVolume(memberSocketId)
      remoteRef.current.set(memberSocketId, entry)
      return entry
    },
    [applyRemoteVolume]
  )

  /** 清理某成员的远端播放链路 */
  const cleanupRemoteAudio = useCallback((memberSocketId: string) => {
    const entry = remoteRef.current.get(memberSocketId)
    if (!entry) return
    remoteRef.current.delete(memberSocketId)
    try {
      entry.audio.pause()
      entry.audio.srcObject = null
      entry.audio.remove()
    } catch {
      /* ignore */
    }
    if (entry.consumer && !entry.consumer.closed) {
      try {
        entry.consumer.close()
      } catch {
        /* ignore */
      }
    }
  }, [])

  /**
   * 消费指定上行轨：走服务器信令创建 consumer → 本地 Transport 挂载 →
   * 建 <audio> 播放链路 → 通知服务器 resume。
   */
  const consumeProducer = useCallback(
    async (roomId: string, producerId: string, producerSocketId: string) => {
      const currentSocket = socketRef.current
      const device = deviceRef.current
      const recvTransport = recvTransportRef.current
      if (!currentSocket || !device || !recvTransport) return
      const res = await emitAck<{
        success: boolean
        consumerId?: string
        producerId?: string
        kind?: string
        rtpParameters?: unknown
        producerMemberKey?: string
        message?: string
      }>(currentSocket, 'voice-sfu-consume', {
        roomId,
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      })
      if (!res.success || !res.consumerId || !res.rtpParameters) return

      const consumer = await recvTransport.consume({
        id: res.consumerId,
        producerId: res.producerId ?? producerId,
        kind: (res.kind ?? 'audio') as 'audio' | 'video',
        rtpParameters: res.rtpParameters as never,
        appData: { memberSocketId: producerSocketId },
      })
      const entry = attachRemoteAudio(producerSocketId, consumer.track)
      entry.consumer = consumer
      consumer.on('transportclose', () => {
        cleanupRemoteAudio(producerSocketId)
      })
      // 远端轨就绪后显式恢复（服务器侧 consumer 初始 paused）
      void emitAck(currentSocket, 'voice-sfu-resume-consumer', {
        roomId,
        consumerId: consumer.id,
      })
    },
    [attachRemoteAudio, cleanupRemoteAudio]
  )

  // ==================== 采集链路 ====================

  /**
   * 建立麦克风处理链：48kHz AudioContext 上 micGain（输入音量）分流到
   * produce 目的地 / 监听目的地 / 电平分析器。与旧版同构。
   */
  const setupCapture = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48_000,
      } as MediaTrackConstraints,
    })
    localStreamRef.current = stream

    const captureCtx = new AudioContext({ sampleRate: 48_000 })
    const source = captureCtx.createMediaStreamSource(stream)
    const micGain = captureCtx.createGain()
    micGain.gain.value = micVolumeRef.current
    source.connect(micGain)

    // 产流目的地：mediasoup produce 该轨（经 micGain，输入音量生效）
    const produceDest = captureCtx.createMediaStreamDestination()
    micGain.connect(produceDest)

    // 监听（反送）：monitorGain 独立控制开关，直连 captureCtx.destination。
    // 不走 MediaStreamDestination + <audio> 元素——元素播放时钟与实时
    // MediaStream 不同步，自听会出现周期性卡顿；直连同上下文硬件时钟
    // 输出零缓冲、零卡顿（音量跟随系统输出设备）。
    const monitorGain = captureCtx.createGain()
    monitorGain.gain.value = monitorEnabledRef.current ? 1 : 0
    micGain.connect(monitorGain)
    monitorGain.connect(captureCtx.destination)

    // 本地电平分析
    const analyser = captureCtx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    micGain.connect(analyser)

    await captureCtx.resume()
    captureCtxRef.current = captureCtx
    micGainRef.current = micGain
    monitorGainRef.current = monitorGain
    localAnalyserRef.current = analyser
    return produceDest.stream.getAudioTracks()[0]
  }, [])

  const teardownCapture = useCallback(() => {
    for (const track of localStreamRef.current?.getTracks() ?? []) {
      track.stop()
    }
    localStreamRef.current = null
    try {
      void captureCtxRef.current?.close()
    } catch {
      /* ignore */
    }
    captureCtxRef.current = null
    micGainRef.current = null
    monitorGainRef.current = null
    localAnalyserRef.current = null
  }, [])

  // ==================== 加入 / 离开 ====================

  /** 清理全部媒体资源（leave / join 失败共用） */
  const cleanupMedia = useCallback(() => {
    for (const socketId of Array.from(remoteRef.current.keys())) {
      cleanupRemoteAudio(socketId)
    }
    try {
      producerRef.current?.close()
    } catch {
      /* ignore */
    }
    producerRef.current = null
    try {
      sendTransportRef.current?.close()
    } catch {
      /* ignore */
    }
    try {
      recvTransportRef.current?.close()
    } catch {
      /* ignore */
    }
    sendTransportRef.current = null
    recvTransportRef.current = null
    deviceRef.current = null
    teardownCapture()
    setAudioLevels(new Map())
    setPeerLatencies(new Map())
  }, [cleanupRemoteAudio, teardownCapture])

  const leave = useCallback(() => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (currentSocket && currentRoomId) {
      currentSocket.emit('voice-leave', { roomId: currentRoomId })
    }
    joinedRef.current = false
    selfMutedRef.current = false
    setJoined(false)
    setMembers([])
    setVoiceMutedBySocket(new Set())
    setMonitorEnabled(false)
    monitorEnabledRef.current = false
    cleanupMedia()
  }, [cleanupMedia])

  const join = useCallback(async () => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (!currentSocket || !currentRoomId) {
      message.error('未连接到房间')
      return
    }
    if (joinedRef.current || joiningRef.current) return

    joiningRef.current = true
    setJoining(true)
    try {
      // 1. 采集链路（麦克风约束与旧版一致）
      const micTrack = await setupCapture()

      // 2. voice-join：业务成员登记 + SFU Router 能力下发
      const response = await emitAck<
        | {
            success: true
            members: VoiceMember[]
            selfMuted?: boolean
            mediaToken: string
            sfuRtpCapabilities?: unknown
          }
        | { success: false; message: string }
      >(currentSocket, 'voice-join', {
        roomId: currentRoomId,
        username: usernameRef.current,
        instanceId: getVoiceInstanceId(),
      })

      if ('message' in response) {
        message.error(response.message ?? '加入语音聊天失败')
        teardownCapture()
        return
      }
      if (!response.sfuRtpCapabilities) {
        message.error('语音服务未就绪（服务器未启用 SFU 传输）')
        teardownCapture()
        return
      }

      setJoined(true)
      joinedRef.current = true

      // 3. Device + 双 Transport
      const device = new Device()
      await device.load({
        routerRtpCapabilities: response.sfuRtpCapabilities as never,
      })
      deviceRef.current = device

      const createRes = await emitAck<{
        success: boolean
        sendTransport?: {
          id: string
          iceParameters: unknown
          iceCandidates: unknown
          dtlsParameters: unknown
        }
        recvTransport?: {
          id: string
          iceParameters: unknown
          iceCandidates: unknown
          dtlsParameters: unknown
        }
        message?: string
      }>(currentSocket, 'voice-sfu-create-transport', { roomId: currentRoomId })
      if (
        !createRes.success ||
        !createRes.sendTransport ||
        !createRes.recvTransport
      ) {
        throw new Error(createRes.message ?? '创建语音传输失败')
      }

      const sendTransport = device.createSendTransport(
        createRes.sendTransport as never
      )
      const recvTransport = device.createRecvTransport(
        createRes.recvTransport as never
      )
      sendTransportRef.current = sendTransport
      recvTransportRef.current = recvTransport

      // 'connect'：mediasoup-client 首次使用 transport 时触发，经信令
      // 完成服务端 DTLS 连接
      const wireConnect = (transport: Transport, which: 'send' | 'recv') => {
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          void emitAck(currentSocket, 'voice-sfu-connect-transport', {
            roomId: currentRoomId,
            which,
            dtlsParameters,
          })
            .then((res: { success: boolean; message?: string }) => {
              if (res.success) callback()
              else errback(new Error(res.message ?? 'DTLS 连接失败'))
            })
            .catch((err) =>
              errback(err instanceof Error ? err : new Error(String(err)))
            )
        })
      }
      wireConnect(sendTransport, 'send')
      wireConnect(recvTransport, 'recv')

      // 'produce'：mediasoup-client produce 时经信令在服务器创建 Producer，
      // 应答回带同房间其他成员的现有轨列表（新成员一次往返拿到全部信息）
      let existingProducers: Array<{
        producerId: string
        memberKey: string
        username: string
        socketId: string
      }> = []
      sendTransport.on(
        'produce',
        (
          { rtpParameters }: { rtpParameters: unknown },
          callback: (response: { id: string }) => void,
          errback: (error: Error) => void
        ) => {
          void emitAck<{
            success: boolean
            producerId?: string
            existingProducers?: Array<{
              producerId: string
              memberKey: string
              username: string
              socketId: string
            }>
            message?: string
          }>(currentSocket, 'voice-sfu-produce', {
            roomId: currentRoomId,
            rtpParameters,
          })
            .then((res) => {
              if (res.success && res.producerId) {
                existingProducers = res.existingProducers ?? []
                callback({ id: res.producerId })
              } else {
                errback(new Error(res.message ?? '发布音频轨失败'))
              }
            })
            .catch((err) =>
              errback(err instanceof Error ? err : new Error(String(err)))
            )
        }
      )

      // 4. 上行 produce 麦克风轨
      const producer = await sendTransport.produce({
        track: micTrack,
        appData: { memberSocketId: currentSocket.id ?? '' },
      })
      producerRef.current = producer
      // 加入时已被管理员禁言：轨保持 enabled，服务器侧 producer 已暂停
      selfMutedRef.current = response.selfMuted === true
      micEnabledRef.current = true
      setMicEnabled(true)

      // 5. 成员列表与禁言标记初始化（self 条目 userId=-1 与旧版一致）
      const currentSocketId = currentSocket.id
      const initialMembers: VoiceMember[] = [...response.members]
      if (currentSocketId) {
        initialMembers.unshift({
          socketId: currentSocketId,
          userId: -1,
          username: usernameRef.current,
        })
      }
      setMembers(initialMembers)
      const mutedIds = response.members
        .filter((m) => m.muted)
        .map((m) => m.socketId)
      if (response.selfMuted && currentSocketId) {
        mutedIds.push(currentSocketId)
      }
      setVoiceMutedBySocket(new Set(mutedIds))

      // 6. 消费既有成员的音频轨（produce 应答中带回）
      for (const p of existingProducers) {
        if (p.socketId === currentSocketId) continue
        try {
          await consumeProducer(currentRoomId, p.producerId, p.socketId)
        } catch (err) {
          console.warn('[voice-sfu] consume existing producer failed:', err)
        }
      }
    } catch (err) {
      console.error('[voice-sfu] join error:', err)
      message.error(err instanceof Error ? err.message : '加入语音聊天失败')
      cleanupMedia()
      joinedRef.current = false
      setJoined(false)
    } finally {
      joiningRef.current = false
      setJoining(false)
    }
  }, [cleanupMedia, setupCapture, teardownCapture, consumeProducer])

  // ==================== 事件监听 ====================

  // 新成员产生上行轨：消费之
  useEffect(() => {
    if (!socket) return
    const handleNewProducer = (payload: {
      roomId: string
      producerId: string
      memberKey: string
      username?: string
      socketId: string
    }) => {
      if (!joinedRef.current) return
      if (!payload.socketId || payload.socketId === socket.id) return
      void consumeProducer(payload.roomId, payload.producerId, payload.socketId)
    }
    socket.on('voice-sfu-new-producer', handleNewProducer)
    return () => {
      socket.off('voice-sfu-new-producer', handleNewProducer)
    }
  }, [socket, consumeProducer])
  // consumeProducer 为稳定 useCallback（依赖链均为空数组 useCallback），
  // 显式纳入依赖满足 exhaustive-deps

  // 成员加入/离开（业务层，与旧版一致）
  useEffect(() => {
    if (!socket) return
    const handleUserJoined = (payload: {
      socketId: string
      userId?: number
      username?: string
    }) => {
      if (payload.socketId === socket.id) return
      setMembers((prev) => {
        if (prev.some((m) => m.socketId === payload.socketId)) return prev
        return [
          ...prev,
          {
            socketId: payload.socketId,
            userId: payload.userId ?? 0,
            username: payload.username,
          },
        ]
      })
    }
    const handleUserLeft = (payload: { socketId: string }) => {
      setMembers((prev) => prev.filter((m) => m.socketId !== payload.socketId))
      cleanupRemoteAudio(payload.socketId)
    }
    socket.on('voice-user-joined', handleUserJoined)
    socket.on('voice-user-left', handleUserLeft)
    return () => {
      socket.off('voice-user-joined', handleUserJoined)
      socket.off('voice-user-left', handleUserLeft)
    }
  }, [socket, cleanupRemoteAudio])

  // 禁言状态同步（业务层，与旧版一致）
  useEffect(() => {
    if (!socket) return
    const handleMutedChanged = (payload: {
      socketId: string
      userId: number
      username?: string
      muted: boolean
    }) => {
      if (!payload || typeof payload.socketId !== 'string') return
      setVoiceMutedBySocket((prev) => {
        const next = new Set(prev)
        if (payload.muted) next.add(payload.socketId)
        else next.delete(payload.socketId)
        return next
      })
      if (payload.socketId === socket.id) {
        selfMutedRef.current = payload.muted
        if (payload.muted) message.warning('您已被管理员语音禁言')
        else message.success('语音禁言已解除')
      }
    }
    socket.on('voice-muted-changed', handleMutedChanged)
    return () => {
      socket.off('voice-muted-changed', handleMutedChanged)
    }
  }, [socket])

  // 被踢出语音
  useEffect(() => {
    if (!socket) return
    const handleKicked = () => {
      message.error('您已被管理员移出语音')
      joinedRef.current = false
      setJoined(false)
      setMembers([])
      setVoiceMutedBySocket(new Set())
      cleanupMedia()
    }
    socket.on('voice-kicked', handleKicked)
    return () => {
      socket.off('voice-kicked', handleKicked)
    }
  }, [socket, cleanupMedia])

  // 断线重连：SFU 侧旧 transport 已随成员条目移除关闭，必须全量重建
  //（leave + join，麦克风重新采集；重加入被拒如踢出冷却则提示并留在离开态）
  useEffect(() => {
    if (!socket) return
    const handleReconnect = () => {
      if (!joinedRef.current) return
      joinedRef.current = false
      cleanupMedia()
      void join().then(() => {
        if (joinedRef.current) message.info('语音已重新连接')
      })
    }
    socket.on('connect', handleReconnect)
    return () => {
      socket.off('connect', handleReconnect)
    }
  }, [socket, cleanupMedia, join])

  // ==================== 控制方法 ====================

  const leaveFn = useCallback(() => {
    leave()
  }, [leave])

  const toggleMic = useCallback(() => {
    // 管理员禁言期间不允许开麦（服务器侧 producer 已暂停，轨保持关闭）
    if (selfMutedRef.current) {
      message.warning('您已被管理员语音禁言')
      return
    }
    setMicEnabled((prev) => {
      const next = !prev
      micEnabledRef.current = next
      // track.enabled 切换：浏览器发送静音帧（保持 AGC/AEC 管线活跃），
      // 不触发任何服务端请求，管理员禁言无法被客户端绕过
      const track = micTrackRef.current
      if (track) track.enabled = next
      return next
    })
  }, [])

  const toggleMonitor = useCallback(() => {
    setMonitorEnabled((prev) => {
      const next = !prev
      monitorEnabledRef.current = next
      if (monitorGainRef.current) {
        monitorGainRef.current.gain.value = next ? 1 : 0
      }
      return next
    })
  }, [])

  // 反送开关即时生效由 toggleMonitor 直接写 monitorGain（同上下文直连
  // 输出，无元素、无缓冲，切开关零延迟）

  const setGlobalVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setGlobalVolumeState(clamped)
    globalVolumeRef.current = clamped
    for (const socketId of Array.from(remoteRef.current.keys())) {
      const entry = remoteRef.current.get(socketId)
      if (!entry) continue
      const peer = peerVolumesRef.current.get(socketId) ?? 1
      entry.audio.volume = Math.max(0, Math.min(1, peer * clamped))
    }
  }, [])

  const setPeerVolume = useCallback((memberSocketId: string, value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setPeerVolumes((prev) => {
      const next = new Map(prev)
      next.set(memberSocketId, clamped)
      return next
    })
    peerVolumesRef.current.set(memberSocketId, clamped)
    const entry = remoteRef.current.get(memberSocketId)
    if (entry) {
      entry.audio.volume = Math.max(
        0,
        Math.min(1, clamped * globalVolumeRef.current)
      )
    }
  }, [])

  const setMicVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setMicVolumeState(clamped)
    micVolumeRef.current = clamped
    if (micGainRef.current) {
      micGainRef.current.gain.value = clamped
    }
  }, [])

  const muteVoiceMember = useCallback(
    (memberSocketId: string, muted: boolean) => {
      const currentSocket = socketRef.current
      const currentRoomId = roomIdRef.current
      if (!currentSocket || !currentRoomId) {
        return Promise.resolve({ success: false, message: '未连接' })
      }
      return new Promise<{ success: boolean; message?: string }>((resolve) => {
        currentSocket.emit(
          'voice-mute',
          { roomId: currentRoomId, socketId: memberSocketId, muted },
          (res: { success: boolean; message?: string }) => resolve(res)
        )
      })
    },
    []
  )

  const kickVoiceMember = useCallback((memberSocketId: string) => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (!currentSocket || !currentRoomId) {
      return Promise.resolve({ success: false, message: '未连接' })
    }
    return new Promise<{ success: boolean; message?: string }>((resolve) => {
      currentSocket.emit(
        'voice-kick',
        { roomId: currentRoomId, socketId: memberSocketId },
        (res: { success: boolean; message?: string }) => resolve(res)
      )
    })
  }, [])

  // ==================== 电平 / 延迟检测 ====================

  useEffect(() => {
    if (!joined) return
    const timer = setInterval(() => {
      const next = new Map<string, number>()
      next.set('self', readLevel(localAnalyserRef.current))
      for (const [socketId, entry] of remoteRef.current) {
        next.set(socketId, readLevel(entry.analyser))
      }
      setAudioLevels(next)
    }, LEVELS_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [joined])

  // 播放侧延迟：consumer.getStats() 的 jitterBufferDelay 均值（NetEQ 实际
  // 缓冲延迟，真实反映听感），每 3s 采样一次
  useEffect(() => {
    if (!joined) return
    const timer = setInterval(() => {
      const recv = recvTransportRef.current
      if (!recv) return
      void recv.getStats().then((stats) => {
        const next = new Map<string, number>()
        for (const entry of remoteRef.current.values()) {
          if (!entry.consumer) continue
          const stat = stats.get(entry.consumer.id)
          if (!stat) continue
          const s = stat as {
            jitterBufferDelay?: number
            jitterBufferEmittedCount?: number
          }
          if (
            typeof s.jitterBufferDelay === 'number' &&
            typeof s.jitterBufferEmittedCount === 'number' &&
            s.jitterBufferEmittedCount > 0
          ) {
            next.set(
              entry.memberSocketId,
              Math.round(
                (s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000
              )
            )
          }
        }
        setPeerLatencies(next)
      })
    }, LATENCY_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [joined])

  // 卸载兜底：离开页面时清理（socket disconnect 事件可能不触发）。
  // remoteRef 为跨渲染稳定 ref，cleanup 时读取其当前值是刻意行为
  useEffect(() => {
    return () => {
      const currentSocket = socketRef.current
      const currentRoomId = roomIdRef.current
      if (currentSocket && currentRoomId && joinedRef.current) {
        currentSocket.emit('voice-leave', { roomId: currentRoomId })
      }
      joinedRef.current = false
      // eslint-disable-next-line react-hooks/exhaustive-deps
      for (const socketId of Array.from(remoteRef.current.keys())) {
        cleanupRemoteAudio(socketId)
      }
      try {
        producerRef.current?.close()
      } catch {
        /* ignore */
      }
      try {
        sendTransportRef.current?.close()
      } catch {
        /* ignore */
      }
      try {
        recvTransportRef.current?.close()
      } catch {
        /* ignore */
      }
      try {
        void captureCtxRef.current?.close()
      } catch {
        /* ignore */
      }
      try {
        void levelsCtxRef.current?.close()
      } catch {
        /* ignore */
      }
    }
  }, [cleanupRemoteAudio])

  return {
    joined,
    joining,
    micEnabled,
    members,
    globalVolume,
    peerVolumes,
    peerLatencies,
    join,
    leave: leaveFn,
    toggleMic,
    setGlobalVolume,
    setPeerVolume,
    monitorEnabled,
    toggleMonitor,
    micVolume,
    setMicVolume,
    audioLevels,
    muteVoiceMember,
    kickVoiceMember,
    voiceMutedBySocket,
  }
}
