import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'

// ============================================================
// 语音聊天 — 服务器中转架构 + Opus 编码（128kbps）
//
// 1. 客户端通过 AudioWorklet 采集 PCM 音频（Float32, 48kHz, mono）
// 2. 使用 WebCodecs AudioEncoder 将 PCM 编码为 Opus（128kbps）
// 3. 通过 Socket.IO 将编码后的 Opus 数据发送到服务器
// 4. 服务器转发给房间内其他语音成员
// 5. 接收端使用 WebCodecs AudioDecoder 解码 Opus → PCM
// 6. 使用 Web Audio API 播放 PCM 数据
//
// 如果浏览器不支持 WebCodecs，自动回退到原始 PCM 传输（768kbps）。
//
// 优势：
// - 无需 NAT 穿透（不依赖 STUN/TURN）
// - 连接更稳定（不依赖 P2P 连接建立）
// - Opus 编码大幅降低带宽（768kbps → 128kbps）
// ============================================================

/** 每次 AudioWorklet 累积的样本数（20ms @ 48kHz，匹配 Opus 编码帧） */
const FRAME_SIZE = 960

/** Opus 编码比特率（128kbps） */
const OPUS_BITRATE = 128_000

/** Opus 编码采样率 */
const OPUS_SAMPLE_RATE = 48_000

/** 接收端 jitter buffer 初始延迟（秒） */
const JITTER_BUFFER_DELAY = 0.06

/** 检测浏览器是否支持 WebCodecs AudioEncoder/AudioDecoder */
const OPUS_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof (window as unknown as { AudioEncoder?: unknown }).AudioEncoder !==
    'undefined' &&
  typeof (window as unknown as { AudioDecoder?: unknown }).AudioDecoder !==
    'undefined'

export interface VoiceMember {
  /** 音频路由 key（服务器按当前连接分配） */
  socketId: string
  /** 登录用户 ID；游客为 0（身份展示与重连顶替判定由服务器完成） */
  userId: number
  /** 显示名（服务器下发：登录用户为真实用户名，游客为客户端昵称） */
  username?: string
  speaking?: boolean
}

export interface UseVoiceChatOptions {
  socket: Socket | null
  roomId: string | undefined
  username?: string
  /** 是否为房主（已废弃，保留接口兼容） */
  isHost?: boolean
}

export interface UseVoiceChatResult {
  /** 是否已加入语音聊天 */
  joined: boolean
  /** 是否正在加入中 */
  joining: boolean
  /** 本地麦克风是否启用 */
  micEnabled: boolean
  /** 当前语音成员列表（包含自己） */
  members: VoiceMember[]
  /** 全局输出音量 0~1 */
  globalVolume: number
  /** 每个远端成员对应的单独音量 0~1 */
  peerVolumes: Map<string, number>
  /** 每个远端成员对应的延迟（ms） */
  peerLatencies: Map<string, number>
  /** 加入语音聊天 */
  join: () => Promise<void>
  /** 离开语音聊天 */
  leave: () => void
  /** 切换本地麦克风开关 */
  toggleMic: () => void
  /** 设置全局输出音量 */
  setGlobalVolume: (value: number) => void
  /** 设置某个远端成员的单独音量 */
  setPeerVolume: (socketId: string, value: number) => void
  /** 本地麦克风反送（监听）是否开启 */
  monitorEnabled: boolean
  /** 切换本地麦克风反送开关 */
  toggleMonitor: () => void
  /** 本地麦克风输入音量 0~1（影响所有远端用户听到的音量） */
  micVolume: number
  /** 设置本地麦克风输入音量 */
  setMicVolume: (value: number) => void
  /** 每个成员的实时音量电平 0~1（key 为 socketId，本地为 'self'） */
  audioLevels: Map<string, number>
}

// ==================== 工具函数 ====================

/** Float32Array → Int16Array（PCM 回退模式使用） */
function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}

/** Int16Array → Float32Array（PCM 回退模式使用） */
function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000
  }
  return float32
}

/** 将 BufferSource 转换为 ArrayBuffer */
function bufferSourceToArrayBuffer(
  source: ArrayBuffer | ArrayBufferView
): ArrayBuffer {
  if (source instanceof ArrayBuffer) return source
  return source.buffer.slice(
    source.byteOffset,
    source.byteOffset + source.byteLength
  ) as ArrayBuffer
}

/** 接收端每个远端用户的播放状态 */
interface PeerPlaybackState {
  gainNode: GainNode
  analyser: AnalyserNode
  /** 下一个音频块的开始播放时间（AudioContext.currentTime 基准） */
  nextStartTime: number
  /** 播放队列长度（用于 jitter buffer 管理） */
  queueLength: number
  /** 最近一次收到数据的时间戳（用于延迟检测） */
  lastReceiveTime: number
  /** 延迟检测：发送端附带的时间戳 → 接收端计算差值 */
  lastLatency: number
  /** Opus 解码器（WebCodecs 模式下每个远端用户独立） */
  decoder?: AudioDecoder
  /** 解码器是否已配置（收到 codec description 后才为 true） */
  decoderConfigured?: boolean
}

/**
 * 语音聊天核心 hook（服务器中转模式 + Opus 编码）。
 *
 * 客户端采集 PCM → Opus 编码 → Socket.IO 发送到服务器 → 服务器转发 →
 * 接收端 Opus 解码 → Web Audio API 播放。
 */
export function useVoiceChat(options: UseVoiceChatOptions): UseVoiceChatResult {
  const { socket, roomId, username } = options

  const [joined, setJoined] = useState(false)
  const [joining, setJoining] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [members, setMembers] = useState<VoiceMember[]>([])
  const [globalVolume, setGlobalVolumeState] = useState(1)
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map())
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [micVolume, setMicVolumeState] = useState(1)
  const [peerLatencies, setPeerLatencies] = useState<Map<string, number>>(
    new Map()
  )
  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map())

  // 音频采集与处理相关 refs
  const localStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const micGainNodeRef = useRef<GainNode | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const silenceGainRef = useRef<GainNode | null>(null)

  // Opus 编码器相关 refs
  const audioEncoderRef = useRef<AudioEncoder | null>(null)
  const codecDescriptionRef = useRef<ArrayBuffer | null>(null)
  const encoderTimestampRef = useRef(0) // 微秒，单调递增

  // 接收端播放相关 refs
  const playbackContextRef = useRef<AudioContext | null>(null)
  const masterGainRef = useRef<GainNode | null>(null)
  const peerStatesRef = useRef<Map<string, PeerPlaybackState>>(new Map())

  // 音量电平分析相关 refs
  const analyserContextRef = useRef<AudioContext | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)
  const levelRafRef = useRef<number | null>(null)

  // 监听（反送）相关 refs
  const monitorStreamRef = useRef<MediaStream | null>(null)

  // 通用 refs
  const socketRef = useRef(socket)
  const roomIdRef = useRef(roomId)
  const usernameRef = useRef(username)
  const globalVolumeRef = useRef(globalVolume)
  const peerVolumesRef = useRef(peerVolumes)
  const micVolumeRef = useRef(micVolume)
  const micEnabledRef = useRef(true)
  const joinedRef = useRef(false)

  useEffect(() => {
    globalVolumeRef.current = globalVolume
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = globalVolume
    }
  }, [globalVolume])

  useEffect(() => {
    peerVolumesRef.current = peerVolumes
  }, [peerVolumes])

  useEffect(() => {
    micVolumeRef.current = micVolume
    if (micGainNodeRef.current) {
      micGainNodeRef.current.gain.value = micVolume
    }
  }, [micVolume])

  useEffect(() => {
    socketRef.current = socket
    roomIdRef.current = roomId
    usernameRef.current = username
  }, [socket, roomId, username])

  useEffect(() => {
    micEnabledRef.current = micEnabled
    // 通知 AudioWorklet 启用/禁用采集
    if (workletNodeRef.current?.port) {
      workletNodeRef.current.port.postMessage({ enabled: micEnabled })
    }
    // 同时控制本地 track
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = micEnabled
    })
  }, [micEnabled])

  useEffect(() => {
    joinedRef.current = joined
  }, [joined])

  // ==================== 音量电平检测 ====================

  const getLevelFromAnalyser = useCallback((analyser: AnalyserNode): number => {
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    return Math.min(1, rms * 2.5)
  }, [])

  const setupLocalAnalyser = useCallback(() => {
    const stream = localStreamRef.current
    if (!stream) return
    try {
      if (!analyserContextRef.current) {
        analyserContextRef.current = new AudioContext()
      }
      const ctx = analyserContextRef.current
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      localAnalyserRef.current = analyser
    } catch (err) {
      console.warn('[voice] setup local analyser error:', err)
    }
  }, [])

  const startLevelDetection = useCallback(() => {
    if (levelRafRef.current) return

    const tick = () => {
      const levels = new Map<string, number>()

      // 本地电平
      if (localAnalyserRef.current && micVolumeRef.current > 0) {
        const level = getLevelFromAnalyser(localAnalyserRef.current)
        levels.set('self', micEnabledRef.current ? level : 0)
      }

      // 远端电平
      peerStatesRef.current.forEach((state, socketId) => {
        levels.set(socketId, getLevelFromAnalyser(state.analyser))
      })

      setAudioLevels(levels)
      levelRafRef.current = requestAnimationFrame(tick)
    }

    levelRafRef.current = requestAnimationFrame(tick)
  }, [getLevelFromAnalyser])

  const stopLevelDetection = useCallback(() => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = null
    }
    setAudioLevels(new Map())
  }, [])

  // ==================== 接收端播放 ====================

  // playAudioChunk 与 ensurePeerPlayback 相互引用（解码输出 → 播放 →
  // 懒建播放链路 → 创建解码器），直接互引会触发声明前访问
  // （react-hooks v6）。以 ref 持有播放函数断开循环，解码器 output
  // 回调（异步触发，晚于 commit）经 ref 调用最新实现。
  const playAudioChunkRef = useRef<
    (socketId: string, pcmData: Float32Array, sampleRate: number) => void
  >(() => {})

  /** 为远端用户创建播放链路（含 Opus 解码器） */
  const ensurePeerPlayback = useCallback(
    (socketId: string): PeerPlaybackState | null => {
      const ctx = playbackContextRef.current
      const master = masterGainRef.current
      if (!ctx || !master) return null

      let state = peerStatesRef.current.get(socketId)
      if (state) return state

      const gainNode = ctx.createGain()
      const peerVolume = peerVolumesRef.current.get(socketId) ?? 1
      gainNode.gain.value = peerVolume

      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6

      gainNode.connect(analyser)
      analyser.connect(master)

      state = {
        gainNode,
        analyser,
        nextStartTime: 0,
        queueLength: 0,
        lastReceiveTime: 0,
        lastLatency: 0,
      }

      // Opus 模式下创建解码器
      if (OPUS_SUPPORTED) {
        try {
          const decoder = new AudioDecoder({
            output: (audioData: AudioData) => {
              const numFrames = audioData.numberOfFrames
              let float32: Float32Array

              // 根据 AudioData 格式提取 PCM 数据
              if (audioData.format === 's16-planar') {
                const int16 = new Int16Array(numFrames)
                audioData.copyTo(int16, { planeIndex: 0 })
                float32 = int16ToFloat32(int16)
              } else {
                // f32-planar 或其他格式
                float32 = new Float32Array(numFrames)
                audioData.copyTo(float32, { planeIndex: 0 })
              }

              playAudioChunkRef.current(socketId, float32, audioData.sampleRate)
              audioData.close()
            },
            error: (e: DOMException) => {
              console.error('[voice] AudioDecoder error for', socketId, e)
            },
          })
          state.decoder = decoder as unknown as AudioDecoder
          state.decoderConfigured = false
        } catch (err) {
          console.error('[voice] failed to create AudioDecoder:', err)
        }
      }

      peerStatesRef.current.set(socketId, state)
      return state
    },
    []
  )

  /** 配置远端用户的 Opus 解码器 */
  const configurePeerDecoder = useCallback(
    (socketId: string, description: ArrayBuffer | null) => {
      const state = peerStatesRef.current.get(socketId)
      if (!state || !state.decoder) return

      try {
        const config: AudioDecoderConfig = {
          codec: 'opus',
          sampleRate: OPUS_SAMPLE_RATE,
          numberOfChannels: 1,
        }
        if (description) {
          config.description = description
        }
        state.decoder.configure(config)
        state.decoderConfigured = true
      } catch (err) {
        console.error('[voice] failed to configure decoder for', socketId, err)
      }
    },
    []
  )

  /** 播放收到的 PCM 音频块 */
  const playAudioChunk = useCallback(
    (socketId: string, pcmData: Float32Array, sampleRate: number) => {
      const ctx = playbackContextRef.current
      if (!ctx) return
      const state = ensurePeerPlayback(socketId)
      if (!state) return

      state.lastReceiveTime = Date.now()

      // 创建 AudioBuffer
      const audioBuffer = ctx.createBuffer(1, pcmData.length, sampleRate)
      // 拷贝到新数组确保 ArrayBuffer 支持（TS 5.7+ 类型要求）
      const pcm = new Float32Array(pcmData)
      audioBuffer.copyToChannel(pcm, 0)

      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(state.gainNode)

      const now = ctx.currentTime
      // jitter buffer：第一个块延迟播放，后续块无缝接续
      const startTime = Math.max(now + JITTER_BUFFER_DELAY, state.nextStartTime)
      source.start(startTime)
      state.nextStartTime = startTime + audioBuffer.duration
      state.queueLength = Math.max(0, state.queueLength - 1)

      // 如果队列积压过多，重置 nextStartTime 以减少延迟
      if (state.nextStartTime - now > 0.5) {
        state.nextStartTime = now + JITTER_BUFFER_DELAY
      }
    },
    [ensurePeerPlayback]
  )

  /** 清理指定远端用户的播放状态（含解码器） */
  const cleanupPeerPlayback = useCallback((socketId: string) => {
    const state = peerStatesRef.current.get(socketId)
    if (state) {
      // 关闭解码器
      if (state.decoder) {
        try {
          state.decoder.close()
        } catch {
          // ignore
        }
      }
      try {
        state.gainNode.disconnect()
        state.analyser.disconnect()
      } catch {
        // ignore
      }
      peerStatesRef.current.delete(socketId)
    }
  }, [])

  // ==================== 音量控制 ====================

  const applyAudioVolume = useCallback((socketId: string) => {
    const state = peerStatesRef.current.get(socketId)
    if (!state) return
    const peerVolume = peerVolumesRef.current.get(socketId) ?? 1
    state.gainNode.gain.value = peerVolume
  }, [])

  // ==================== 监听（反送） ====================
  // 反送 audio 元素不存 ref（react-hooks v6 不允许在回调中修改 ref 持有的
  // DOM 值属性），以 data 标记 + DOM 查询定位，行为等价。

  const stopMonitor = useCallback(() => {
    const audioEl = document.querySelector<HTMLAudioElement>(
      'audio[data-voice-monitor="self"]'
    )
    if (audioEl) {
      audioEl.pause()
      audioEl.srcObject = null
      audioEl.remove()
    }
  }, [])

  const startMonitor = useCallback(() => {
    const stream = monitorStreamRef.current
    if (!stream) return
    let audioEl = document.querySelector<HTMLAudioElement>(
      'audio[data-voice-monitor="self"]'
    )
    if (!audioEl) {
      audioEl = document.createElement('audio')
      audioEl.autoplay = true
      audioEl.muted = false
      audioEl.dataset.voiceMonitor = 'self'
      document.body.appendChild(audioEl)
    }
    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream
    }
  }, [])

  // ==================== 清理 ====================

  const cleanupAll = useCallback(() => {
    // 清理远端播放（含解码器）
    peerStatesRef.current.forEach((_, socketId) => {
      cleanupPeerPlayback(socketId)
    })
    peerStatesRef.current.clear()

    // 停止监听
    stopMonitor()

    // 停止电平检测
    stopLevelDetection()

    // 关闭 Opus 编码器
    if (audioEncoderRef.current) {
      try {
        audioEncoderRef.current.close()
      } catch {
        // ignore
      }
      audioEncoderRef.current = null
    }
    codecDescriptionRef.current = null
    encoderTimestampRef.current = 0

    // 停止本地音频采集
    if (workletNodeRef.current) {
      try {
        workletNodeRef.current.port.postMessage({ enabled: false })
        workletNodeRef.current.disconnect()
      } catch {
        // ignore
      }
      workletNodeRef.current = null
    }
    if (silenceGainRef.current) {
      try {
        silenceGainRef.current.disconnect()
      } catch {
        // ignore
      }
      silenceGainRef.current = null
    }
    if (micGainNodeRef.current) {
      try {
        micGainNodeRef.current.disconnect()
      } catch {
        // ignore
      }
      micGainNodeRef.current = null
    }

    // 停止本地流
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    monitorStreamRef.current = null

    // 关闭采集 AudioContext
    try {
      audioContextRef.current?.close()
    } catch {
      // ignore
    }
    audioContextRef.current = null

    // 关闭播放 AudioContext
    try {
      playbackContextRef.current?.close()
    } catch {
      // ignore
    }
    playbackContextRef.current = null
    masterGainRef.current = null

    // 关闭分析 AudioContext
    localAnalyserRef.current = null
    try {
      analyserContextRef.current?.close()
    } catch {
      // ignore
    }
    analyserContextRef.current = null

    setMembers([])
    setJoined(false)
    setJoining(false)
    setMicEnabled(true)
    setMonitorEnabled(false)
    setMicVolumeState(1)
    setPeerLatencies(new Map())
    setAudioLevels(new Map())
  }, [cleanupPeerPlayback, stopMonitor, stopLevelDetection])

  // ==================== 加入/离开 ====================

  const join = useCallback(async () => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (!currentSocket || !currentRoomId) {
      message.error('未连接到房间')
      return
    }
    if (joinedRef.current || joining) return

    setJoining(true)
    try {
      // 1. 获取麦克风
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: OPUS_SAMPLE_RATE,
          sampleSize: 16,
        } as MediaTrackConstraints,
      })
      localStreamRef.current = stream

      stream.getAudioTracks().forEach((track) => {
        track.enabled = micEnabled
      })

      // 2. 创建采集 AudioContext + AudioWorklet
      const captureCtx = new AudioContext()
      await captureCtx.audioWorklet.addModule('/voice-processor.js')

      const source = captureCtx.createMediaStreamSource(stream)
      const micGain = captureCtx.createGain()
      micGain.gain.value = micVolumeRef.current

      const workletNode = new AudioWorkletNode(captureCtx, 'voice-processor', {
        processorOptions: { frameSize: FRAME_SIZE },
      })

      // 静音输出节点（AudioWorkletNode 需要连接到 destination 才能持续运行 process）
      const silenceGain = captureCtx.createGain()
      silenceGain.gain.value = 0

      // 链路：source → micGain → workletNode → silenceGain → destination
      source.connect(micGain)
      micGain.connect(workletNode)
      workletNode.connect(silenceGain)
      silenceGain.connect(captureCtx.destination)

      // 同时创建反送流（从 micGain 输出）
      const monitorDestination = captureCtx.createMediaStreamDestination()
      micGain.connect(monitorDestination)
      monitorStreamRef.current = monitorDestination.stream

      await captureCtx.resume()
      audioContextRef.current = captureCtx
      micGainNodeRef.current = micGain
      workletNodeRef.current = workletNode
      silenceGainRef.current = silenceGain

      // 3. Opus 编码器设置（WebCodecs 模式）
      if (OPUS_SUPPORTED) {
        try {
          const encoder = new AudioEncoder({
            output: (
              chunk: EncodedAudioChunk,
              metadata: EncodedAudioChunkMetadata
            ) => {
              // 处理编解码器配置（description）
              if (metadata?.decoderConfig?.description) {
                const descBuf = bufferSourceToArrayBuffer(
                  metadata.decoderConfig.description as
                    ArrayBuffer | ArrayBufferView
                )
                codecDescriptionRef.current = descBuf

                // 发送编解码器配置给房间内其他成员
                currentSocket.emit('voice-codec-config', {
                  roomId: currentRoomId,
                  description: descBuf,
                })
              }

              // 拷贝编码后的 Opus 数据
              const chunkData = new ArrayBuffer(chunk.byteLength)
              chunk.copyTo(chunkData)

              // 发送编码后的音频
              currentSocket.emit('voice-audio-data', {
                roomId: currentRoomId,
                data: chunkData,
                timestamp: Date.now(),
                mediaTs: chunk.timestamp,
                encoded: true,
              })
            },
            error: (e: DOMException) => {
              console.error('[voice] AudioEncoder error:', e)
            },
          })

          encoder.configure({
            codec: 'opus',
            sampleRate: OPUS_SAMPLE_RATE,
            numberOfChannels: 1,
            bitrate: OPUS_BITRATE,
          })

          audioEncoderRef.current = encoder
          encoderTimestampRef.current = 0
          console.log('[voice] Opus encoder configured at', OPUS_BITRATE, 'bps')
        } catch (err) {
          console.error(
            '[voice] failed to create AudioEncoder, falling back to PCM:',
            err
          )
          audioEncoderRef.current = null
        }
      }

      // 4. AudioWorklet 数据回调 → 编码/发送
      workletNode.port.onmessage = (e: MessageEvent) => {
        const arrayBuffer = e.data as ArrayBuffer
        if (!arrayBuffer || !joinedRef.current || !micEnabledRef.current) return

        const float32 = new Float32Array(arrayBuffer)

        if (OPUS_SUPPORTED && audioEncoderRef.current) {
          // Opus 模式：创建 AudioData → 编码
          try {
            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: captureCtx.sampleRate,
              numberOfFrames: float32.length,
              numberOfChannels: 1,
              timestamp: encoderTimestampRef.current,
              data: float32,
            })
            audioEncoderRef.current.encode(audioData)
            audioData.close()
            // 递增时间戳（微秒）
            encoderTimestampRef.current +=
              (float32.length / captureCtx.sampleRate) * 1_000_000
          } catch (err) {
            console.error('[voice] encode error:', err)
          }
        } else {
          // PCM 回退模式：直接发送 Int16 数据
          const int16 = float32ToInt16(float32)
          currentSocket.emit('voice-audio-data', {
            roomId: currentRoomId,
            data: int16.buffer,
            sampleRate: captureCtx.sampleRate,
            timestamp: Date.now(),
            encoded: false,
          })
        }
      }

      // 5. 创建接收端播放 AudioContext
      const playbackCtx = new AudioContext()
      const masterGain = playbackCtx.createGain()
      masterGain.gain.value = globalVolumeRef.current
      masterGain.connect(playbackCtx.destination)
      await playbackCtx.resume()
      playbackContextRef.current = playbackCtx
      masterGainRef.current = masterGain

      // 6. 发送 voice-join 到服务器
      // username 作为游客昵称兜底（登录用户服务器优先采用 token 中的用户名）
      const response = await new Promise<
        | { success: true; members: VoiceMember[] }
        | { success: false; message: string }
      >((resolve) => {
        currentSocket.emit(
          'voice-join',
          { roomId: currentRoomId, username },
          (
            res:
              | { success: true; members: VoiceMember[] }
              | { success: false; message: string }
          ) => resolve(res)
        )
      })

      if ('message' in response) {
        message.error(response.message ?? '加入语音聊天失败')
        stream.getTracks().forEach((track) => track.stop())
        localStreamRef.current = null
        setJoining(false)
        return
      }

      setJoined(true)
      setJoining(false)

      const currentSocketId = currentSocket.id
      const initialMembers: VoiceMember[] = [...response.members]
      if (currentSocketId) {
        initialMembers.unshift({
          socketId: currentSocketId,
          userId: -1,
          username,
        })
      }
      setMembers(initialMembers)

      // 为已有成员创建播放链路
      response.members.forEach((m) => {
        ensurePeerPlayback(m.socketId)
      })

      // 启动电平检测
      setupLocalAnalyser()
      startLevelDetection()
    } catch (err) {
      console.error('[voice] join error:', err)
      message.error('无法获取麦克风权限或加入语音失败')
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
      setJoining(false)
    }
  }, [
    joining,
    micEnabled,
    username,
    ensurePeerPlayback,
    setupLocalAnalyser,
    startLevelDetection,
  ])

  const leave = useCallback(() => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (currentSocket && currentRoomId) {
      currentSocket.emit('voice-leave', { roomId: currentRoomId })
    }
    cleanupAll()
  }, [cleanupAll])

  // ==================== 控制方法 ====================

  const toggleMic = useCallback(() => {
    setMicEnabled((prev) => !prev)
  }, [])

  const toggleMonitor = useCallback(() => {
    setMonitorEnabled((prev) => {
      const next = !prev
      if (next) {
        startMonitor()
      } else {
        stopMonitor()
      }
      return next
    })
  }, [startMonitor, stopMonitor])

  useEffect(() => {
    if (!joined) return
    if (monitorEnabled) {
      startMonitor()
    } else {
      stopMonitor()
    }
  }, [joined, monitorEnabled, startMonitor, stopMonitor])

  const setMicVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setMicVolumeState(clamped)
    micVolumeRef.current = clamped
    if (micGainNodeRef.current) {
      micGainNodeRef.current.gain.value = clamped
    }
  }, [])

  const setGlobalVolume = useCallback((value: number) => {
    const clamped = Math.max(0, Math.min(1, value))
    setGlobalVolumeState(clamped)
    globalVolumeRef.current = clamped
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = clamped
    }
  }, [])

  const setPeerVolume = useCallback(
    (socketId: string, value: number) => {
      const clamped = Math.max(0, Math.min(1, value))
      setPeerVolumes((prev) => {
        const next = new Map(prev)
        next.set(socketId, clamped)
        return next
      })
      peerVolumesRef.current.set(socketId, clamped)
      applyAudioVolume(socketId)
    },
    [applyAudioVolume]
  )

  // ==================== 延迟检测 ====================

  useEffect(() => {
    if (!joined) return
    const timer = setInterval(() => {
      const next = new Map<string, number>()
      peerStatesRef.current.forEach((state, socketId) => {
        if (state.lastLatency > 0) {
          next.set(socketId, state.lastLatency)
        }
      })
      setPeerLatencies(next)
    }, 2000)
    return () => clearInterval(timer)
  }, [joined])

  // ==================== Socket 事件监听 ====================

  /** 处理收到的编解码器配置 */
  const handleVoiceCodecConfig = useCallback(
    (payload: { from: string; description: ArrayBuffer }) => {
      if (!joinedRef.current) return
      if (payload.from === socketRef.current?.id) return

      // 确保播放链路存在
      ensurePeerPlayback(payload.from)
      // 配置解码器
      configurePeerDecoder(payload.from, payload.description)
    },
    [ensurePeerPlayback, configurePeerDecoder]
  )

  /** 处理收到的音频数据（Opus 编码或 PCM 回退） */
  const handleVoiceAudioData = useCallback(
    (payload: {
      from: string
      data: ArrayBuffer
      sampleRate?: number
      timestamp: number
      mediaTs?: number
      encoded?: boolean
    }) => {
      if (!joinedRef.current) return
      if (payload.from === socketRef.current?.id) return

      // 计算延迟（客户端时钟差，仅作参考）
      const latency = Date.now() - payload.timestamp
      const state = peerStatesRef.current.get(payload.from)
      if (state) {
        state.lastLatency = Math.max(0, latency)
      }

      if (payload.encoded && OPUS_SUPPORTED) {
        // Opus 模式：解码后播放
        const peerState = ensurePeerPlayback(payload.from)
        if (!peerState?.decoder) return

        // 如果解码器尚未配置，尝试无 description 配置
        if (!peerState.decoderConfigured) {
          configurePeerDecoder(payload.from, codecDescriptionRef.current)
        }

        try {
          const encodedChunk = new EncodedAudioChunk({
            type: 'key',
            timestamp: payload.mediaTs ?? payload.timestamp * 1000,
            data: payload.data,
          })
          peerState.decoder.decode(encodedChunk)
        } catch (err) {
          console.error('[voice] decode error:', err)
        }
      } else {
        // PCM 回退模式：直接播放
        const int16 = new Int16Array(payload.data)
        const float32 = int16ToFloat32(int16)
        playAudioChunk(
          payload.from,
          float32,
          payload.sampleRate ?? OPUS_SAMPLE_RATE
        )
      }
    },
    [ensurePeerPlayback, configurePeerDecoder, playAudioChunk]
  )

  const handleVoiceUserJoined = useCallback(
    (payload: { socketId: string; userId?: number; username?: string }) => {
      const currentSocketId = socketRef.current?.id
      const currentRoomId = roomIdRef.current
      const currentSocket = socketRef.current
      if (!currentSocketId || payload.socketId === currentSocketId) return

      setMembers((prev) => {
        if (prev.some((m) => m.socketId === payload.socketId)) return prev
        // 同一登录用户重连顶替：服务器已广播旧 socketId 的离开事件并清理
        // 对应条目，此处仅需追加新连接
        return [
          ...prev,
          {
            socketId: payload.socketId,
            userId: payload.userId ?? 0,
            username: payload.username,
          },
        ]
      })

      // 为新成员创建播放链路
      ensurePeerPlayback(payload.socketId)

      // 新成员加入时，重新发送编解码器配置
      if (
        OPUS_SUPPORTED &&
        codecDescriptionRef.current &&
        currentSocket &&
        currentRoomId
      ) {
        currentSocket.emit('voice-codec-config', {
          roomId: currentRoomId,
          description: codecDescriptionRef.current,
        })
      }
    },
    [ensurePeerPlayback]
  )

  const handleVoiceUserLeft = useCallback(
    (payload: { socketId: string; userId?: number; username?: string }) => {
      cleanupPeerPlayback(payload.socketId)
      setMembers((prev) => prev.filter((m) => m.socketId !== payload.socketId))
    },
    [cleanupPeerPlayback]
  )

  useEffect(() => {
    if (!socket) return

    socket.on('voice-audio-data', handleVoiceAudioData)
    socket.on('voice-codec-config', handleVoiceCodecConfig)
    socket.on('voice-user-joined', handleVoiceUserJoined)
    socket.on('voice-user-left', handleVoiceUserLeft)

    return () => {
      socket.off('voice-audio-data', handleVoiceAudioData)
      socket.off('voice-codec-config', handleVoiceCodecConfig)
      socket.off('voice-user-joined', handleVoiceUserJoined)
      socket.off('voice-user-left', handleVoiceUserLeft)
    }
  }, [
    socket,
    handleVoiceAudioData,
    handleVoiceCodecConfig,
    handleVoiceUserJoined,
    handleVoiceUserLeft,
  ])

  // 组件卸载或房间变化时自动离开
  useEffect(() => {
    return () => {
      if (joinedRef.current) {
        leave()
      }
    }
  }, [leave])

  return {
    joined,
    joining,
    micEnabled,
    members,
    globalVolume,
    peerVolumes,
    peerLatencies,
    join,
    leave,
    toggleMic,
    setGlobalVolume,
    setPeerVolume,
    monitorEnabled,
    toggleMonitor,
    micVolume,
    setMicVolume,
    audioLevels,
  }
}
