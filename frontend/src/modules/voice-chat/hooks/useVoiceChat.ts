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

/** 接收端 jitter buffer 初始目标水位（秒），自适应下限 */
const TARGET_BUFFER_MIN_SEC = 0.06

/** jitter buffer 目标水位上限（秒）：抖动再大也不超过 */
const TARGET_BUFFER_MAX_SEC = 0.3

/** 目标水位基线（秒）：2×抖动 EWMA 之上再加的固定余量 */
const TARGET_BUFFER_BASE_SEC = 0.04

/** 标准语音帧长（秒）：AudioWorklet 20ms/帧，用于计算到达间隔偏差 */
const VOICE_FRAME_SEC = 0.02

/** 水位追赶：超过目标此余量后启用 1.05x 微加速消耗积压（秒） */
const CATCHUP_THRESHOLD_SEC = 0.08

/** 追赶播放速率（1.05x ≈ 每秒消化 47ms 积压，听感无感知） */
const CATCHUP_PLAYBACK_RATE = 1.05

/** 极端积压硬重置阈值（秒）：超过则直接丢帧重建时间线 */
const BACKLOG_RESET_SEC = 0.5

/** 电平条采样频率（ms）：12.5Hz 足够平滑，远低于 rAF 的 60Hz */
const LEVEL_SAMPLE_INTERVAL_MS = 80

/** 电平变化发布阈值：变化低于此值不触发 setState（0~1 尺度） */
const LEVEL_CHANGE_THRESHOLD = 0.03

/** 解码器错误重建节流间隔（防 error 死循环） */
const DECODER_REBUILD_THROTTLE_MS = 10_000

/** 编码器错误重建节流间隔（防 error 死循环） */
const ENCODER_REBUILD_THROTTLE_MS = 10_000

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
  /** 是否被语音禁言（仅 voice-join 应答时由服务器填充，供初始化标记） */
  muted?: boolean
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
  /** 语音禁言/解禁某成员（房主/房管） */
  muteVoiceMember: (
    socketId: string,
    muted: boolean
  ) => Promise<{ success: boolean; message?: string }>
  /** 踢出某成员的语音（房主/房管，60s 冷却） */
  kickVoiceMember: (
    socketId: string
  ) => Promise<{ success: boolean; message?: string }>
  /** 语音禁言状态（key 为 socketId，服务器广播同步） */
  voiceMutedBySocket: Set<string>
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
function int16ToFloat32(int16: Int16Array): Float32Array<ArrayBuffer> {
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

/** 字节级比较两个 ArrayBuffer 是否相同（codec-config 去重用） */
function isArrayBufferEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a === b) return true
  if (a.byteLength !== b.byteLength) return false
  const va = new Uint8Array(a)
  const vb = new Uint8Array(b)
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false
  }
  return true
}

/** 接收端每个远端用户的播放状态 */
interface PeerPlaybackState {
  gainNode: GainNode
  analyser: AnalyserNode
  /** 下一个音频块的开始播放时间（AudioContext.currentTime 基准） */
  nextStartTime: number
  /**
   * 已调度未播完的音频块。积压重置时必须显式 stop：
   * 仅重置 nextStartTime 会让旧时间线上已 start() 的块继续播放，
   * 与新时间线重叠（听感为回声/金属声）。
   */
  pendingSources: Set<AudioBufferSourceNode>
  /**
   * 自适应 jitter buffer 目标水位（秒）：基于到达抖动 EWMA 动态计算，
   * 网络稳→低水位低延迟，抖动大→自动抬升防 underrun。
   */
  targetBufferSec: number
  /** 上次音频块到达时刻（performance.now，计算到达间隔） */
  lastArrivalAt: number
  /** 到达间隔偏差的 EWMA（秒）：|实际间隔 - 标准帧长| 的指数滑动平均 */
  jitterEwma: number
  /** 对方流的 codec description（错误重建解码器时复用） */
  codecDescription?: ArrayBuffer
  /** 解码器上次重建时间戳（防 error 死循环） */
  decoderRebuildAt?: number
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
  /** 语音禁言成员集合（key 为 socketId，join 应答初始化 + 广播增量同步） */
  const [voiceMutedBySocket, setVoiceMutedBySocket] = useState<Set<string>>(
    new Set()
  )

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

  // 音量电平分析相关 refs（本地 analyser 挂在 captureCtx 的 micGain 后，
  // 不再单独建 AudioContext：省一个上下文配额，且电平反映 micVolume，
  // 与远端成员实际听到的音量一致）
  const localAnalyserRef = useRef<AnalyserNode | null>(null)
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
  /** 自己是否被语音禁言（服务器广播同步；禁言期间停止上行发送） */
  const selfMutedRef = useRef(false)

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
    const ctx = audioContextRef.current
    const micGain = micGainNodeRef.current
    if (!ctx || !micGain) return
    try {
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      // 挂在 micGain 之后：电平随麦克风音量实时变化，与远端听感一致
      micGain.connect(analyser)
      localAnalyserRef.current = analyser
    } catch (err) {
      console.warn('[voice] setup local analyser error:', err)
    }
  }, [])

  const startLevelDetection = useCallback(() => {
    if (levelTimerRef.current) return

    // 上一轮发布的电平快照：与当前采样比较，全部成员变化都低于阈值
    // 时跳过 setState（无人说话时 0 渲染，此前 rAF 60Hz 每帧重渲染）
    let lastPublished = new Map<string, number>()

    const tick = () => {
      const current = new Map<string, number>()

      // 本地电平
      if (localAnalyserRef.current && micVolumeRef.current > 0) {
        const level = getLevelFromAnalyser(localAnalyserRef.current)
        current.set('self', micEnabledRef.current ? level : 0)
      }

      // 远端电平
      peerStatesRef.current.forEach((state, socketId) => {
        current.set(socketId, getLevelFromAnalyser(state.analyser))
      })

      // 变化检测：新成员、离开成员或任一成员变化超阈值 → 发布
      let changed = current.size !== lastPublished.size
      if (!changed) {
        current.forEach((level, key) => {
          const last = lastPublished.get(key)
          if (
            last === undefined ||
            Math.abs(level - last) > LEVEL_CHANGE_THRESHOLD
          ) {
            changed = true
          }
        })
      }
      if (changed) {
        lastPublished = current
        setAudioLevels(current)
      }
    }

    levelTimerRef.current = setInterval(tick, LEVEL_SAMPLE_INTERVAL_MS)
  }, [getLevelFromAnalyser])

  const stopLevelDetection = useCallback(() => {
    if (levelTimerRef.current) {
      clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
    setAudioLevels(new Map())
  }, [])

  // ==================== 接收端播放 ====================

  // playAudioChunk 与 ensurePeerPlayback 相互引用（解码输出 → 播放 →
  // 懒建播放链路 → 创建解码器），直接互引会触发声明前访问
  // （react-hooks v6）。以 ref 持有播放函数断开循环，解码器 output
  // 回调（异步触发，晚于 commit）经 ref 调用最新实现。
  const playAudioChunkRef = useRef<
    (
      socketId: string,
      pcmData: Float32Array<ArrayBuffer>,
      sampleRate: number
    ) => void
  >(() => {})

  /**
   * 为指定远端用户创建 Opus 解码器。
   * 具名函数表达式：error 回调可自引用实现"节流重建"——解码器出错后
   * 关闭旧的并用缓存的 codec description 重建（10s 节流防死循环），
   * 避免错误后链路静默失效。
   */
  const createPeerDecoder = useCallback(function createDecoder(
    socketId: string
  ): AudioDecoder | null {
    const rebuild = () => {
      const state = peerStatesRef.current.get(socketId)
      if (!state) return
      const nowTs = Date.now()
      if (
        state.decoderRebuildAt &&
        nowTs - state.decoderRebuildAt < DECODER_REBUILD_THROTTLE_MS
      ) {
        return
      }
      state.decoderRebuildAt = nowTs
      try {
        state.decoder?.close()
      } catch {
        // ignore：可能已关闭
      }
      const next = createDecoder(socketId)
      if (!next) return
      if (state.codecDescription) {
        try {
          next.configure({
            codec: 'opus',
            sampleRate: OPUS_SAMPLE_RATE,
            numberOfChannels: 1,
            description: state.codecDescription,
          })
          state.decoderConfigured = true
        } catch (err) {
          console.error(
            '[voice] failed to configure rebuilt decoder for',
            socketId,
            err
          )
        }
      }
      state.decoder = next
    }

    try {
      return new AudioDecoder({
        output: (audioData: AudioData) => {
          const numFrames = audioData.numberOfFrames
          let float32: Float32Array<ArrayBuffer>
          try {
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
          } finally {
            // copyTo 异常时也必须释放，否则 AudioData 泄漏
            audioData.close()
          }
        },
        error: (e: DOMException) => {
          console.error('[voice] AudioDecoder error for', socketId, e)
          rebuild()
        },
      })
    } catch (err) {
      console.error('[voice] failed to create AudioDecoder:', err)
      return null
    }
  }, [])

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
        pendingSources: new Set(),
        targetBufferSec: TARGET_BUFFER_MIN_SEC,
        lastArrivalAt: 0,
        jitterEwma: 0,
      }

      // Opus 模式下创建解码器（error 时内部自动节流重建）
      if (OPUS_SUPPORTED) {
        state.decoder = createPeerDecoder(socketId) ?? undefined
        state.decoderConfigured = false
      }

      peerStatesRef.current.set(socketId, state)
      return state
    },
    [createPeerDecoder]
  )

  /** 配置远端用户的 Opus 解码器 */
  const configurePeerDecoder = useCallback(
    (socketId: string, description: ArrayBuffer | null) => {
      const state = peerStatesRef.current.get(socketId)
      if (!state || !state.decoder) return

      // 缓存 description：解码器错误重建时需要重新 configure
      if (description) {
        state.codecDescription = description
      }

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
    (
      socketId: string,
      pcmData: Float32Array<ArrayBuffer>,
      sampleRate: number
    ) => {
      const ctx = playbackContextRef.current
      if (!ctx) return
      const state = ensurePeerPlayback(socketId)
      if (!state) return

      // 创建 AudioBuffer（copyToChannel 内部拷贝数据，无需先复制一份）
      const audioBuffer = ctx.createBuffer(1, pcmData.length, sampleRate)
      audioBuffer.copyToChannel(pcmData, 0)

      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(state.gainNode)

      const now = ctx.currentTime

      // ---- 自适应 jitter buffer：到达抖动 EWMA → 目标水位 ----
      const arrivalNow = performance.now()
      if (state.lastArrivalAt > 0) {
        const intervalSec = (arrivalNow - state.lastArrivalAt) / 1000
        // 间隔异常大（暂停/对方静音后恢复）不纳入统计
        if (intervalSec > 0 && intervalSec < 0.5) {
          const deviation = Math.abs(intervalSec - VOICE_FRAME_SEC)
          state.jitterEwma = state.jitterEwma * 0.9 + deviation * 0.1
        }
      }
      state.lastArrivalAt = arrivalNow
      const targetBuffer = Math.min(
        TARGET_BUFFER_MAX_SEC,
        Math.max(
          TARGET_BUFFER_MIN_SEC,
          2 * state.jitterEwma + TARGET_BUFFER_BASE_SEC
        )
      )
      state.targetBufferSec = targetBuffer

      // ---- 时间线调度 ----
      // underrun：上一块已播完而新块迟到（时间线落后于当前时刻）→
      // 以目标水位重新起播，给后续包留缓冲
      let timeline = state.nextStartTime
      if (timeline < now) {
        timeline = now + targetBuffer
      }

      // 水位追赶：显著高于目标时 1.05x 微加速消耗积压（听感无感知），
      // 替代直接丢帧；仅在极端积压（>0.5s）才硬重置
      const bufferAhead = timeline - now
      const rate =
        bufferAhead > targetBuffer + CATCHUP_THRESHOLD_SEC
          ? CATCHUP_PLAYBACK_RATE
          : 1
      if (rate !== 1) {
        source.playbackRate.value = rate
      }

      const startTime = Math.max(now + targetBuffer, timeline)
      state.pendingSources.add(source)
      source.onended = () => {
        state.pendingSources.delete(source)
      }
      source.start(startTime)
      // 追赶时块实际占用时间线 = 时长 / 速率
      state.nextStartTime = startTime + audioBuffer.duration / rate

      // 极端积压（追赶无法覆盖的突发）：丢弃已排队未播的旧块再重置
      // 时间线。实时语音宁可断 0.5s 音，也不能让新旧时间线重叠播放
      if (state.nextStartTime - now > BACKLOG_RESET_SEC) {
        for (const s of state.pendingSources) {
          try {
            s.stop()
          } catch {
            // ignore：已播完/已停止的块
          }
        }
        state.pendingSources.clear()
        state.nextStartTime = now + targetBuffer
      }
    },
    [ensurePeerPlayback]
  )

  /** 清理指定远端用户的播放状态（含解码器与未播完的音频块） */
  const cleanupPeerPlayback = useCallback((socketId: string) => {
    const state = peerStatesRef.current.get(socketId)
    if (state) {
      // 停止未播完的音频块（避免成员离开后残留声音）
      for (const s of state.pendingSources) {
        try {
          s.stop()
        } catch {
          // ignore
        }
      }
      state.pendingSources.clear()
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

    // 本地 analyser 随 captureCtx 关闭自动释放，仅清引用
    localAnalyserRef.current = null

    setMembers([])
    setJoined(false)
    setJoining(false)
    setMicEnabled(true)
    setMonitorEnabled(false)
    setMicVolumeState(1)
    setPeerLatencies(new Map())
    setAudioLevels(new Map())
    setVoiceMutedBySocket(new Set())
    selfMutedRef.current = false
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
      // sampleRate 强制锁定 48kHz：AudioContext 选项是强制的（浏览器自动
      // 插入重采样器）。若跟随硬件默认（macOS/部分声卡为 44.1kHz），
      // FRAME_SIZE=960 实际帧长变为 21.77ms，与 Opus 20ms 内部帧不齐，
      // 会产生周期性爆音/变速感（仅部分设备复现，极难排查）
      const captureCtx = new AudioContext({ sampleRate: OPUS_SAMPLE_RATE })
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
        // 编码器错误重建节流（error 后状态为 closed，不重建则上行永久静默）
        let lastEncoderRebuildAt = 0
        const setupEncoder = (): AudioEncoder | null => {
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

                  // 去重：与上次已广播的配置字节级比较，相同则不重发。
                  // 部分 Chrome 版本对 Opus 每个 output 都附带 description，
                  // 不去重会每秒广播 50 个冗余配置（N 人房间再 ×N-1 下发）。
                  // 新加入成员的配置送达由 voice-user-joined 触发重发覆盖
                  if (
                    !codecDescriptionRef.current ||
                    !isArrayBufferEqual(codecDescriptionRef.current, descBuf)
                  ) {
                    codecDescriptionRef.current = descBuf

                    // 发送编解码器配置给房间内其他成员（必须送达，不用 volatile）
                    currentSocket.emit('voice-codec-config', {
                      roomId: currentRoomId,
                      description: descBuf,
                    })
                  }
                }

                // 拷贝编码后的 Opus 数据
                const chunkData = new ArrayBuffer(chunk.byteLength)
                chunk.copyTo(chunkData)

                // 发送编码后的音频。volatile：socket 拥堵时允许丢弃该帧
                // （实时语音丢一帧只是 20ms 静音，排队则延迟持续膨胀）
                currentSocket.volatile.emit('voice-audio-data', {
                  roomId: currentRoomId,
                  data: chunkData,
                  timestamp: Date.now(),
                  mediaTs: chunk.timestamp,
                  encoded: true,
                })
              },
              error: (e: DOMException) => {
                console.error('[voice] AudioEncoder error:', e)
                if (
                  Date.now() - lastEncoderRebuildAt <
                  ENCODER_REBUILD_THROTTLE_MS
                ) {
                  return
                }
                lastEncoderRebuildAt = Date.now()
                try {
                  encoder.close()
                } catch {
                  // ignore：可能已关闭
                }
                const next = setupEncoder()
                if (next) {
                  audioEncoderRef.current = next
                  console.warn('[voice] AudioEncoder rebuilt after error')
                }
              },
            })

            encoder.configure({
              codec: 'opus',
              sampleRate: OPUS_SAMPLE_RATE,
              numberOfChannels: 1,
              bitrate: OPUS_BITRATE,
            })
            return encoder
          } catch (err) {
            console.error(
              '[voice] failed to create AudioEncoder, falling back to PCM:',
              err
            )
            return null
          }
        }
        audioEncoderRef.current = setupEncoder()
        encoderTimestampRef.current = 0
        console.log('[voice] Opus encoder configured at', OPUS_BITRATE, 'bps')
      }

      // 4. AudioWorklet 数据回调 → 编码/发送
      workletNode.port.onmessage = (e: MessageEvent) => {
        const arrayBuffer = e.data as ArrayBuffer
        if (!arrayBuffer || !joinedRef.current || !micEnabledRef.current) return
        // 自己被禁言：不上行（服务器仍兜底校验，此处省编码与带宽）
        if (selfMutedRef.current) return

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
          // PCM 回退模式：直接发送 Int16 数据（volatile：拥堵允许丢帧）
          const int16 = float32ToInt16(float32)
          currentSocket.volatile.emit('voice-audio-data', {
            roomId: currentRoomId,
            data: int16.buffer,
            sampleRate: captureCtx.sampleRate,
            timestamp: Date.now(),
            encoded: false,
          })
        }
      }

      // 5. 创建接收端播放 AudioContext（同样锁定 48kHz：解码输出为 48kHz，
      // 不匹配时 WebAudio 会隐式重采样，引入额外延迟与质量损失）
      const playbackCtx = new AudioContext({ sampleRate: OPUS_SAMPLE_RATE })
      const masterGain = playbackCtx.createGain()
      masterGain.gain.value = globalVolumeRef.current
      masterGain.connect(playbackCtx.destination)
      await playbackCtx.resume()
      playbackContextRef.current = playbackCtx
      masterGainRef.current = masterGain

      // 6. 发送 voice-join 到服务器
      // username 作为游客昵称兜底（登录用户服务器优先采用 token 中的用户名）
      const response = await new Promise<
        | { success: true; members: VoiceMember[]; selfMuted?: boolean }
        | { success: false; message: string }
      >((resolve) => {
        currentSocket.emit(
          'voice-join',
          { roomId: currentRoomId, username },
          (
            res:
              | {
                  success: true
                  members: VoiceMember[]
                  selfMuted?: boolean
                }
              | { success: false; message: string }
          ) => resolve(res)
        )
      })

      if ('message' in response) {
        message.error(response.message ?? '加入语音聊天失败')
        // 此时 captureCtx/playbackCtx/encoder/worklet 均已创建，
        // 必须完整清理（Chrome 每页 AudioContext 上限约 6 个，
        // 泄漏累积后 join 会静默失败）
        cleanupAll()
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

      // 初始化禁言标记（join 应答携带，后续由 voice-muted-changed 增量同步）
      const mutedIds = response.members
        .filter((m) => m.muted)
        .map((m) => m.socketId)
      // 自己的禁言状态（服务器持久化，重进房间仍生效）：控制上行 + UI 标记
      selfMutedRef.current = response.selfMuted === true
      if (response.selfMuted && currentSocketId) {
        mutedIds.push(currentSocketId)
      }
      setVoiceMutedBySocket(new Set(mutedIds))

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
      // 中途任一步骤异常（如 addModule 失败）都可能已创建 AudioContext，
      // 统一走完整清理避免泄漏
      cleanupAll()
    }
  }, [
    joining,
    micEnabled,
    username,
    ensurePeerPlayback,
    cleanupAll,
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

  // 采样本地播放缓冲水位（nextStartTime - currentTime）作为延迟指标：
  // 完全本地可测，不受收发双方系统时钟偏差影响（此前用 Date.now 差值，
  // 跨机器时钟偏移可达秒级，显示基本不可信），且直接反映真实听感延迟
  useEffect(() => {
    if (!joined) return
    const timer = setInterval(() => {
      const ctx = playbackContextRef.current
      if (!ctx) return
      const now = ctx.currentTime
      const next = new Map<string, number>()
      peerStatesRef.current.forEach((state, socketId) => {
        // 只统计有活跃播放时间线的成员（nextStartTime > 0 表示已收到音频）
        if (state.nextStartTime > 0) {
          next.set(
            socketId,
            Math.max(0, Math.round((state.nextStartTime - now) * 1000))
          )
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

      if (payload.encoded && OPUS_SUPPORTED) {
        // Opus 模式：解码后播放
        const peerState = ensurePeerPlayback(payload.from)
        if (!peerState?.decoder) return

        // 如果解码器尚未配置（音频先于 codec-config 到达），先无 description
        // 兜底配置——Opus 帧自描述可直接解码；不可用本端编码器的 description
        // （OpusHead 的 pre-skip 等参数跨浏览器可能不同，且会被缓存进
        // state.codecDescription 污染后续解码器重建）。对端真正的
        // voice-codec-config 到达后会正式配置覆盖
        if (!peerState.decoderConfigured) {
          configurePeerDecoder(payload.from, null)
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
      setVoiceMutedBySocket((prev) => {
        if (!prev.has(payload.socketId)) return prev
        const next = new Set(prev)
        next.delete(payload.socketId)
        return next
      })
    },
    [cleanupPeerPlayback]
  )

  // ==================== 语音管理（房主/房管） ====================

  const handleVoiceMutedChanged = useCallback(
    (payload: {
      socketId: string
      userId: number
      username?: string
      muted: boolean
    }) => {
      if (!payload || typeof payload.socketId !== 'string') return
      setVoiceMutedBySocket((prev) => {
        const next = new Set(prev)
        if (payload.muted) {
          next.add(payload.socketId)
        } else {
          next.delete(payload.socketId)
        }
        return next
      })
      // 自己被禁言/解禁时提示，并控制上行发送开关
      const mySocketId = socketRef.current?.id
      if (mySocketId && payload.socketId === mySocketId) {
        selfMutedRef.current = payload.muted
        if (payload.muted) {
          message.warning('您已被管理员语音禁言')
        } else {
          message.success('语音禁言已解除')
        }
      }
    },
    []
  )

  const handleVoiceKicked = useCallback(() => {
    // 被踢出语音：本地直接执行完整离开流程（停止采集/清理播放链路）
    message.error('您已被管理员移出语音')
    leave()
  }, [leave])

  /** 语音禁言/解禁某成员 */
  const muteVoiceMember = useCallback((socketId: string, muted: boolean) => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (!currentSocket || !currentRoomId) {
      return Promise.resolve({ success: false, message: '未连接' })
    }
    return new Promise<{ success: boolean; message?: string }>((resolve) => {
      currentSocket.emit(
        'voice-mute',
        { roomId: currentRoomId, socketId, muted },
        (res: { success: boolean; message?: string }) => resolve(res)
      )
    })
  }, [])

  /** 踢出某成员的语音 */
  const kickVoiceMember = useCallback((socketId: string) => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (!currentSocket || !currentRoomId) {
      return Promise.resolve({ success: false, message: '未连接' })
    }
    return new Promise<{ success: boolean; message?: string }>((resolve) => {
      currentSocket.emit(
        'voice-kick',
        { roomId: currentRoomId, socketId },
        (res: { success: boolean; message?: string }) => resolve(res)
      )
    })
  }, [])

  useEffect(() => {
    if (!socket) return

    socket.on('voice-audio-data', handleVoiceAudioData)
    socket.on('voice-codec-config', handleVoiceCodecConfig)
    socket.on('voice-user-joined', handleVoiceUserJoined)
    socket.on('voice-user-left', handleVoiceUserLeft)
    socket.on('voice-muted-changed', handleVoiceMutedChanged)
    socket.on('voice-kicked', handleVoiceKicked)

    return () => {
      socket.off('voice-audio-data', handleVoiceAudioData)
      socket.off('voice-codec-config', handleVoiceCodecConfig)
      socket.off('voice-user-joined', handleVoiceUserJoined)
      socket.off('voice-user-left', handleVoiceUserLeft)
      socket.off('voice-muted-changed', handleVoiceMutedChanged)
      socket.off('voice-kicked', handleVoiceKicked)
    }
  }, [
    socket,
    handleVoiceAudioData,
    handleVoiceCodecConfig,
    handleVoiceUserJoined,
    handleVoiceUserLeft,
    handleVoiceMutedChanged,
    handleVoiceKicked,
  ])

  // socket.io 断线重连后 socket.id 变化：服务器 voiceMembers 表中无新连接
  // 的条目，上行音频会被服务器静默丢弃（自己听得到别人、别人听不到自己，
  // 面板却仍显示已连接）。已加入状态下自动重新 voice-join——轻量重加入：
  // 复用既有采集/编码/播放链路，不重新获取麦克风。
  useEffect(() => {
    if (!socket) return

    const handleReconnect = () => {
      if (!joinedRef.current) return
      const currentRoomId = roomIdRef.current
      if (!currentRoomId) return

      socket.emit(
        'voice-join',
        { roomId: currentRoomId, username: usernameRef.current },
        (
          res:
            | {
                success: true
                members: VoiceMember[]
                selfMuted?: boolean
              }
            | { success: false; message: string }
        ) => {
          if ('message' in res) {
            // 重加入被拒（如被踢冷却期内）：彻底离开语音
            message.error(res.message)
            leave()
            return
          }
          // 重建成员列表（自己的 socketId 已变化，远端条目不变）
          const initialMembers: VoiceMember[] = [...res.members]
          if (socket.id) {
            initialMembers.unshift({
              socketId: socket.id,
              userId: -1,
              username: usernameRef.current,
            })
          }
          setMembers(initialMembers)
          // 同步禁言标记与播放链路（含自己的持久化禁言状态）
          const mutedIds = res.members
            .filter((m) => m.muted)
            .map((m) => m.socketId)
          selfMutedRef.current = res.selfMuted === true
          if (res.selfMuted && socket.id) {
            mutedIds.push(socket.id)
          }
          setVoiceMutedBySocket(new Set(mutedIds))
          res.members.forEach((m) => {
            ensurePeerPlayback(m.socketId)
          })
          // 重发编解码器配置：其他端为新 socketId 重建了解码器，需重新配置
          if (OPUS_SUPPORTED && codecDescriptionRef.current) {
            socket.emit('voice-codec-config', {
              roomId: currentRoomId,
              description: codecDescriptionRef.current,
            })
          }
          message.info('语音已重新连接')
        }
      )
    }

    socket.on('connect', handleReconnect)
    return () => {
      socket.off('connect', handleReconnect)
    }
  }, [socket, leave, ensurePeerPlayback])

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
    muteVoiceMember,
    kickVoiceMember,
    voiceMutedBySocket,
  }
}
