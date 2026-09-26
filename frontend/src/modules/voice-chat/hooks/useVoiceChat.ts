import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { getVoiceMediaSocket } from '@/hooks/useSocket'
import { getVoiceInstanceId } from '../lib/multiInstance'

// ============================================================
// 语音聊天 — 服务器中转架构 + Opus 编码（自适应码率）
//
// 1. 客户端通过 AudioWorklet 采集 PCM 音频（Float32, 48kHz, mono）
// 2. 使用 WebCodecs AudioEncoder 将 PCM 编码为 Opus（码率按上行拥塞
//    自适应：桌面 128k→32k、移动端 32k→16k 阶梯降档/回升）
// 3. 编码后的 Opus 帧经「语音媒体专用连接」（独立 Socket.IO 连接，
//    仅 WebSocket 传输）发送到服务器——与业务消息的 TCP 队头阻塞隔离
// 4. 服务器转发给房间内其他语音成员的媒体连接（慢消费者按写缓冲丢帧）
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

/** Opus 编码比特率（128kbps）：桌面码率阶梯的最高档（自适应降档起点） */
const OPUS_BITRATE = 128_000

/** Opus 编码采样率 */
const OPUS_SAMPLE_RATE = 48_000

/**
 * 接收端 jitter buffer 目标水位下限（秒）。
 * 播放调度与解码回调都跑在主线程，而房间页同时运行播放器/弹幕/
 * 评论，主线程 100~300ms 的卡顿是常态——下限必须能吸收典型卡顿，
 * 否则每次卡顿都排空播放队列产生可闻断音。150ms 是语音通话的
 * 常规缓冲水平（WebRTC 同量级），延迟代价可接受
 */
const TARGET_BUFFER_MIN_SEC = 0.15

/** jitter buffer 目标水位上限（秒）：抖动再大也不超过 */
const TARGET_BUFFER_MAX_SEC = 0.4

/** 目标水位基线（秒）：2×抖动 EWMA 之上再加的固定余量 */
const TARGET_BUFFER_BASE_SEC = 0.1

/** 标准语音帧长（秒）：AudioWorklet 20ms/帧，用于计算到达间隔偏差 */
const VOICE_FRAME_SEC = 0.02

/** 极端积压硬重置阈值（秒）：超过则直接丢帧重建时间线 */
const BACKLOG_RESET_SEC = 0.5

/**
 * PLC（丢包隐藏）单次填充上限（秒）：underrun 空洞超过此长度时截断。
 * 极端空洞（主线程长冻结/网络中断）填满会输出大段"机器人残响"，
 * 截断后剩余部分保持静音，衰减包络让填充内容自然淡出
 */
const PLC_MAX_FILL_SEC = 0.6

/**
 * 移动端（手机网页）检测：iPhone/Android/旧 iPad UA 直接命中；
 * 新版 iPad UA 与 macOS 相同，由多点触控数区分
 */
const IS_MOBILE =
  typeof navigator !== 'undefined' &&
  (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) &&
      typeof navigator.maxTouchPoints === 'number' &&
      navigator.maxTouchPoints > 1))

/**
 * 移动端弱化语音参数：手机上行带宽与抖动远差于桌面，高码率/高缓冲下
 * 实测音频严重断续。码率降至 32kbps（Opus 语音模式 32k 可懂度良好），
 * jitter buffer 放宽以吸收移动网络的高抖动与切换基站突刺，
 * 积压硬重置阈值同步放宽（0.3s 起播水位下 0.5s 积压阈值会频繁触发重置）
 */
const MOBILE_OPUS_BITRATE = 32_000
const MOBILE_BUFFER_MIN_SEC = 0.3
const MOBILE_BUFFER_MAX_SEC = 0.6
const MOBILE_BUFFER_BASE_SEC = 0.2
const MOBILE_BACKLOG_RESET_SEC = 1.0

/**
 * 移动端 Opus 编码帧长（秒）：40ms 长帧。socket.io/engine.io/WS/TCP/IP
 * 逐层包头合计约 60~100B，20ms 帧（50 包/秒）的包率在手机弱网下的
 * 开销与突发敏感性远高于包内容本身——40ms 帧把包率减半（25 包/秒），
 * Opus 40ms 语音档可懂度仍良好。接收端「到达间隔统计的期望值」必须
 * 与之联动（MOBILE_OPUS_FRAME_SEC），否则 jitter 统计虚高、水位抬升
 */
const MOBILE_OPUS_FRAME_SEC = 0.04

/** 移动端 PCM 回退模式的上行合并帧数：2 帧（40ms）拼包发送，理由同上 */
const PCM_MOBILE_BATCH_FRAMES = 2

// ==================== 时钟漂移补偿（动态最低水位） ====================
//
// 收发两端 48kHz 硬件时钟存在 ppm 级漂移：播放端时钟略快于发送端时
// 播放消耗速率略高于到达速率，队列寿命持续递减，固定 min buffer 会
// 周期性 underrun——听感为每隔 N 秒一次的规律性断音。按 underrun
// 频率动态调整每个 peer 的最低水位，把被漂移侵蚀掉的缓冲量补回来

/**
 * 当前平台的最低水位基线（秒）：动态水位的初始值与回落下限。
 * 取值与原固定 min 一致（桌面 0.15 / 移动 0.3）——无漂移证据时
 * 行为与原来完全相同，不凭空增加延迟
 */
const BUFFER_MIN_BASELINE_SEC = IS_MOBILE
  ? MOBILE_BUFFER_MIN_SEC
  : TARGET_BUFFER_MIN_SEC

/**
 * 漂移评估窗口（ms）：窗口内连续语音 underrun ≥ 2 次则抬升水位一档，
 * 无 underrun 且持续有接收流量则回落一档。30s 足以区分"漂移侵蚀"
 * （规律性、持续出现）与"偶发抖动"（一次性网络突刺）
 */
const DRIFT_WINDOW_MS = 30_000

/** 水位单次调整步长（秒）：20ms 一档，量级与典型漂移每窗口的侵蚀量匹配 */
const DRIFT_BUFFER_STEP_SEC = 0.02

/** 抬升阈值：窗口内连续语音 underrun 达到该次数即抬升一档 */
const DRIFT_RAISE_UNDERRUN_COUNT = 2

/**
 * 回落所需的窗口内最小接收帧数（约 2s 净语音 @20ms 帧）：与窗口
 * 跨度上限共同判定"持续有接收流量"——对方闭麦半小时后回来的零星
 * 帧不足以证明当前水位经得起持续播放的考验，不参与回落评估
 */
const DRIFT_FALLBACK_MIN_FRAMES = 100

/**
 * 回落评估的窗口跨度上限（ms）：到期评估只能由帧到达触发，无流量时
 * 窗口悬置、跨度膨胀。跨度超过 2 倍窗口时长说明期内存在长接收间隙
 * （对方闭麦/静音），该窗口不视为稳定期，禁止回落
 */
const DRIFT_FALLBACK_MAX_SPAN_MS = 60_000

/**
 * 上行背压阈值：底层 WebSocket 写入积压超过该字节数（≈50 包/约 1 秒）
 * 时丢弃当前帧。Socket.IO 的发送队列无限增长，弱网/网络切换时不丢帧
 * 会让上行流越拖越迟（延迟持续累积直到会话性质卡死），
 * 实时语义下丢帧远优于积压；同时防止语音帧挤占同 socket 的业务消息
 */
const UPLINK_QUEUE_LIMIT_BYTES = 16 * 1024

/**
 * 读取 socket 底层 engine.io WebSocket 的未发送积压字节数。
 * transport 非 WebSocket（轮询）或访问失败时返回 0（不丢帧）
 */
function getUplinkBacklogBytes(io: unknown): number {
  try {
    const ioTyped = io as
      | { engine?: { transport?: { ws?: { bufferedAmount?: number } } } }
      | null
      | undefined
    return ioTyped?.engine?.transport?.ws?.bufferedAmount ?? 0
  } catch {
    return 0
  }
}

// ==================== 上行自适应码率 ====================
//
// 固定码率下弱网只能靠背压丢帧维持实时性，而整帧丢弃的听感损伤
// 远大于降码率（丢帧 = 内容跳切，降码率 = 音质变糊）。按 10s 摘要
// 窗口的丢帧统计分级降档，拥塞消退后缓慢回升。

/**
 * 桌面端码率阶梯（bps，索引 0 为最高档）：128k → 96k → 64k → 48k → 32k。
 * 最高档即原固定码率（OPUS_BITRATE）；弱网沿阶梯逐档下调，拥塞消退
 * 后逐档回升
 */
const DESKTOP_BITRATE_LADDER = [OPUS_BITRATE, 96_000, 64_000, 48_000, 32_000]

/**
 * 移动端码率阶梯（bps，索引 0 为最高档）：32k → 24k → 16k。
 * 最高档即原固定码率（MOBILE_OPUS_BITRATE）——手机上行窄，更高档位
 * 会被排队吞掉，阶梯整体低于桌面
 */
const MOBILE_BITRATE_LADDER = [MOBILE_OPUS_BITRATE, 24_000, 16_000]

/** 当前平台的码率阶梯（bps）：档位索引以此为下标 */
const BITRATE_LADDER = IS_MOBILE
  ? MOBILE_BITRATE_LADDER
  : DESKTOP_BITRATE_LADDER

/**
 * 降档阈值：10s 窗口内背压丢帧 ≥ 25 帧（20ms 帧约 500 个/窗口，
 * 即 ~5% 丢帧率）判定持续拥塞。丢帧到该量级说明背压兜底已在持续
 * 触发，降码率从源头减少发送量优于继续丢帧
 */
const BITRATE_DOWNGRADE_DROP_FRAMES = 25

/** 升档所需连续干净窗口数：2 个窗口 = 20s，慢升快降（升档有探路风险） */
const BITRATE_UPGRADE_CLEAN_WINDOWS = 2

/**
 * 升档的 backlog 水位条件：EWMA 低于背压阈值的 50%。用 EWMA 而非
 * 窗口末瞬时值：瞬时值被网络突发污染，EWMA 低位才能确认拥塞
 * 真正消退而非恰好处于两个突发之间
 */
const BITRATE_UPGRADE_BACKLOG_RATIO = 0.5

/**
 * 升档后观察窗的回降阈值：丢帧 ≥ 5 帧即回降。取 5 而非 1：升档后
 * 的个别丢帧更可能是瞬时抖动（基站切换/突发大消息），≥1 就回降会
 * 让档位在噪声下反复横跳；5 帧（1% 量级）才判定为新码率超出
 * 网络承受力的真拥塞
 */
const BITRATE_REBOUND_DROP_FRAMES = 5

/**
 * 上行 backlog EWMA 平滑系数：每帧权重 5%。50 帧/秒下约 1s 收敛
 * 到新水平（1 - 0.95^50 ≈ 92%），既能吸收帧级突发又不至于让
 * 10s 窗口末的读数完全失真
 */
const UPLINK_BACKLOG_EWMA_ALPHA = 0.05

/**
 * 构造 Opus 编码器配置：setupEncoder 初始配置与自适应码率热重配置
 * 共用。configure() 是全量替换语义——热重配置若只传 bitrate 会丢失
 * codec 等必填项，移动端 opus 扩展参数（40ms 长帧/complexity）也会
 * 回退，必须始终走同一份构造
 */
function buildEncoderConfig(bitrate: number): AudioEncoderConfig {
  const config: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate: OPUS_SAMPLE_RATE,
    numberOfChannels: 1,
    bitrate,
  }
  if (IS_MOBILE) {
    // 移动端 Opus 扩展参数（WebCodecs Opus 注册项；TS DOM 未收录全部
    // 字段，经断言注入——WebIDL 字典语义下浏览器忽略不认识的键，
    // 不会 configure 失败）：
    // - frameDuration 40ms：包率 50→25pps（见 MOBILE_OPUS_FRAME_SEC）
    // - complexity 5：降低编码 CPU 占用，防止手机端主线程挤压
    //   播放调度（decode/playback 同跑在主线程）
    // 不开 useinbandfec：Socket.IO 走 TCP 可靠有序传输，帧只会迟到
    // 不会丢失；而 WebCodecs 无 decode_fec API，嵌入包内的冗余数据
    // 无法被解码端消费——FEC 只白耗 32k 档约 15~20% 的有效语音码率。
    // 弱网连续性由接收端 PLC（underrun 填充）承担
    ;(config as unknown as Record<string, unknown>).opus = {
      frameDuration: 40_000,
      complexity: 5,
    }
  }
  return config
}

/** 电平条采样频率（ms）：12.5Hz 足够平滑，远低于 rAF 的 60Hz */
const LEVEL_SAMPLE_INTERVAL_MS = 80

/** 电平变化发布阈值：变化低于此值不触发 setState（0~1 尺度） */
const LEVEL_CHANGE_THRESHOLD = 0.03

/** 解码器错误重建节流间隔（防 error 死循环） */
const DECODER_REBUILD_THROTTLE_MS = 10_000

/** 编码器错误重建节流间隔（防 error 死循环） */
const ENCODER_REBUILD_THROTTLE_MS = 10_000

/**
 * 质量摘要日志窗口（ms）：每窗口汇总输出一行上行/下行质量指标。
 * 10s 内 20ms 帧约 500 个，样本量足够反映丢帧/卡顿趋势，又不至于
 * 日志刷屏；无流量的窗口静默
 */
const QUALITY_SUMMARY_INTERVAL_MS = 10_000

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
  /** 上次音频块到达时刻（performance.now，计算到达间隔） */
  lastArrivalAt: number
  /**
   * 到达间隔偏差的 EWMA（秒）：|实际间隔 - 标准帧长| 的指数滑动平均。
   * 用于计算 underrun 重起播时的目标水位（网络稳→低水位低延迟，
   * 抖动大→自动抬升防 underrun）。正常播放为纯排队，不做水位干预
   */
  jitterEwma: number
  /** 对方流的 codec description（错误重建解码器时复用） */
  codecDescription?: ArrayBuffer
  /** 解码器上次重建时间戳（防 error 死循环） */
  decoderRebuildAt?: number
  /** Opus 解码器（WebCodecs 模式下每个远端用户独立） */
  decoder?: AudioDecoder
  /** 解码器是否已配置（收到 codec description 后才为 true） */
  decoderConfigured?: boolean
  /**
   * 最近一帧解码 PCM（PLC 丢包隐藏的合成素材）。TCP 可靠传输下
   * 帧不会中途丢失，"丢帧"只以 underrun（帧迟到）形态出现——
   * 用上一帧内容循环+衰减填充 underrun 空洞。解码回调每次产出
   * 全新数组，直接持有引用安全
   */
  lastPcm?: Float32Array<ArrayBuffer> | null
  /**
   * 上一已调度帧的 mediaTs（微秒，编码端单调时钟）。服务端慢消费者
   * 跳帧与上行背压丢帧在到达端只表现为 mediaTs 跳变，相邻帧差值
   * 超过 1.5 帧长即判定传输途中丢帧（触发间隙 PLC 填充）。0 表示
   * 尚未收到带 mediaTs 的帧（无从比较，不参与判定）
   */
  lastMediaTsUs: number
  /**
   * 该 peer 的动态最低水位（秒）：时钟漂移补偿。初始为平台基线
   * （BUFFER_MIN_BASELINE_SEC），30s 评估窗口内连续语音 underrun
   * ≥ 2 次则 +20ms（上限平台 bufferMax），持续无 underrun 则回落
   * （下限基线）。仅作为 targetBuffer 的 min 分量——水位变化不
   * 触碰已排队的时间线（只进不退），下次 underrun 重起播或积压
   * 重置取 targetBuffer 时自然生效
   */
  dynamicBufferMinSec: number
  /**
   * 漂移评估窗口内的连续语音 underrun 计数（判定口径与质量统计
   * 一致：prevIntervalMs ∈ (0,150)）。必须独立于 dlStats.underruns
   * ——后者每 10s 被质量摘要重置，复用会让 30s 窗口只能"看见"
   * 最后 10s 的 underrun
   */
  driftUnderrunCount: number
  /** 漂移评估窗口内的接收帧数（回落评估判定"持续有接收流量"的素材） */
  driftWindowFrames: number
  /**
   * 漂移评估窗口起点（performance.now 毫秒）。0 = 尚未对齐首帧，
   * 首帧到达时按到期评估流程重置到真实时刻
   */
  driftWindowStartMs: number
}

/**
 * PLC（丢包隐藏）填充合成与调度：用最近一帧解码 PCM 循环复制 +
 * 3ms 淡入 + 指数衰减（尾部 ~8%）合成填充音频，在 startAt 时刻开始
 * 播放。underrun 空洞（帧迟到排空播放队列）与 mediaTs 间隙丢帧
 * （服务端跳帧/上行背压丢帧后的时间线空洞）共用同一算法——连续
 * 语音中的丢失从"死寂/内容跳切"变为短暂减弱的人声残留。
 * 返回实际填充秒数：素材缺失（尚未收到解码帧）或空洞过短（低于
 * 一帧，不值得合成）时返回 0，调用方按纯静音处理
 */
function schedulePlcFill(
  state: PeerPlaybackState,
  ctx: AudioContext,
  startAt: number,
  fillSec: number,
  sampleRate: number
): number {
  const prevPcm = state.lastPcm
  // 素材缺失（首帧前/刚清理）：无法合成，保持静音
  if (!prevPcm || prevPcm.length === 0) return 0
  // 低于一帧的碎片空洞：合成调度的开销超过听感收益，保持静音
  if (fillSec < VOICE_FRAME_SEC) return 0
  const fillSamples = Math.floor(fillSec * sampleRate)
  if (fillSamples <= 0) return 0
  const fillBuffer = ctx.createBuffer(1, fillSamples, sampleRate)
  const fillData = fillBuffer.getChannelData(0)
  // 3ms 淡入防接缝爆音；整体指数衰减到 ~8%，尾部与静音融合
  const fadeInSamples = Math.min(Math.floor(0.003 * sampleRate), fillSamples)
  for (let i = 0; i < fillSamples; i++) {
    let env = Math.exp((-2.5 * i) / fillSamples)
    if (i < fadeInSamples) {
      env *= i / fadeInSamples
    }
    fillData[i] = prevPcm[i % prevPcm.length] * env
  }
  const fillSource = ctx.createBufferSource()
  fillSource.buffer = fillBuffer
  fillSource.connect(state.gainNode)
  state.pendingSources.add(fillSource)
  fillSource.onended = () => {
    state.pendingSources.delete(fillSource)
  }
  fillSource.start(startAt)
  console.debug(`[voice] plc fill ${Math.round(fillSec * 1000)}ms`)
  return fillSec
}

/**
 * 时钟漂移补偿：30s 评估窗口到期时调整该 peer 的动态最低水位
 * （playAudioChunk 每帧调用，未到期直接返回，均摊开销可忽略）。
 * 收发两端 48kHz 硬件时钟存在 ppm 级漂移，播放端略快时队列寿命持续
 * 递减，固定 min buffer 会周期性 underrun（每隔 N 秒规律性断音）——
 * 按 underrun 频率把被侵蚀的缓冲量补回来：
 * - 抬升：窗口内连续语音 underrun ≥ 2 次 → 水位 +20ms（上限平台
 *   bufferMax，达顶后不再抬也不刷日志，但仍重置窗口重新观察）
 * - 回落：窗口内无连续语音 underrun 且持续有接收流量 → 水位 -20ms
 *   （下限平台基线）。"持续流量"以窗口内帧数与窗口跨度共同判定：
 *   长时间无流量（对方闭麦/静音）期间播放队列早已排空、无压力考验，
 *   不视为稳定期，避免恢复后仅凭零星帧就降档
 * 调整只改 min 分量数值，不触碰已排队的时间线（时间线只进不退），
 * 新水位在下次 underrun 重起播或积压重置取 targetBuffer 时自然生效
 */
function evaluateDriftBufferMin(
  state: PeerPlaybackState,
  socketId: string,
  nowMs: number,
  bufferMaxSec: number
): void {
  const spanMs = nowMs - state.driftWindowStartMs
  if (spanMs < DRIFT_WINDOW_MS) return
  const prevMinMs = Math.round(state.dynamicBufferMinSec * 1000)
  if (state.driftUnderrunCount >= DRIFT_RAISE_UNDERRUN_COUNT) {
    if (state.dynamicBufferMinSec < bufferMaxSec) {
      state.dynamicBufferMinSec = Math.min(
        bufferMaxSec,
        state.dynamicBufferMinSec + DRIFT_BUFFER_STEP_SEC
      )
      console.debug(
        `[voice] drift buffer min ${prevMinMs} -> ` +
          `${Math.round(state.dynamicBufferMinSec * 1000)}ms for peer ${socketId} ` +
          `(${state.driftUnderrunCount} underruns/${Math.round(spanMs / 1000)}s, ` +
          `clock drift compensation)`
      )
    }
  } else if (
    state.driftUnderrunCount === 0 &&
    state.dynamicBufferMinSec > BUFFER_MIN_BASELINE_SEC &&
    state.driftWindowFrames >= DRIFT_FALLBACK_MIN_FRAMES &&
    spanMs < DRIFT_FALLBACK_MAX_SPAN_MS
  ) {
    state.dynamicBufferMinSec = Math.max(
      BUFFER_MIN_BASELINE_SEC,
      state.dynamicBufferMinSec - DRIFT_BUFFER_STEP_SEC
    )
    console.debug(
      `[voice] drift buffer min ${prevMinMs} -> ` +
        `${Math.round(state.dynamicBufferMinSec * 1000)}ms for peer ${socketId} ` +
        `(stable ${Math.round(spanMs / 1000)}s, releasing excess buffer)`
    )
  }
  // 无论是否调整都重置窗口：下一个 30s 从当前时刻重新观察
  state.driftUnderrunCount = 0
  state.driftWindowFrames = 0
  state.driftWindowStartMs = nowMs
}

/**
 * 上行质量统计（本端全局一份，随 join/leave 会话生命周期重置）。
 * 编码帧数与背压丢帧数对照可反映上行拥塞程度（丢帧是延迟累积的
 * 唯一兜底手段，丢帧率高 = 弱网上行）
 */
interface UplinkStats {
  /** 窗口内编码/上行发出的帧数（Opus encode 提交 + PCM 直发） */
  encodedFrames: number
  /** 窗口内上行背压丢帧数（WebSocket 写积压超限丢弃） */
  droppedFrames: number
  /**
   * 当前编码码率档位（bps）。setupEncoder 初始 configure 与自适应
   * 码率热重配置（applyBitrateIndex）处同步更新；AudioEncoder 无
   * 读取当前配置的 API，只能旁路记录供摘要日志 br 字段读取
   */
  currentBitrate: number
}

/**
 * 下行质量统计（按 peer socketId 记录，peer 离开时随播放链路一起
 * 清理，防止反复进出房间导致 Map 泄漏）
 */
interface DownlinkStats {
  /** 窗口内接收调度的帧数（仅正常帧主路径，PLC 填充为内部合成不计） */
  receivedFrames: number
  /**
   * 窗口内 mediaTs 间隙推断的丢帧数。服务端慢消费者跳帧与上行背压
   * 丢帧在到达端均表现为 mediaTs 跳变，统一在此计数（检测逻辑见
   * playAudioChunk 的间隙检测分支：相邻帧 mediaTs 差值 > 1.5 帧长）
   */
  gapLostFrames: number
  /** 窗口内连续语音 underrun 次数（静音后恢复的首次起播不计） */
  underruns: number
  /** 窗口内 PLC 填充累计时长（ms） */
  plcFillMs: number
  /** 最新缓冲水位（ms，本帧调度后 nextStartTime - now；跨窗口保留） */
  bufferMs: number
}

/** 创建初始上行统计（码率档位取当前平台阶梯的最高档） */
function createUplinkStats(): UplinkStats {
  return {
    encodedFrames: 0,
    droppedFrames: 0,
    currentBitrate: BITRATE_LADDER[0],
  }
}

/**
 * 上行自适应码率状态机的跨窗口状态（10s 摘要窗口重置计数时必须
 * 保留，否则"连续干净窗口数"永远无法累积到升档阈值）。随 join/leave
 * 会话生命周期重置：档位回到最高档重新探测
 */
interface BitrateAdaptiveState {
  /** 当前码率档位索引（BITRATE_LADDER 下标，0 为最高档） */
  ladderIndex: number
  /**
   * 上行 backlog 字节数 EWMA（AudioWorklet 每帧采样，闭麦/禁言期间
   * 无样本自然停止更新）。比瞬时值更能区分持续拥塞与瞬时突发
   */
  backlogEwmaBytes: number
  /**
   * 连续「无丢帧且 backlog 低位」的窗口数（升档需连续 2 个）。
   * 闭麦/有零星丢帧的窗口不计入（无样本/非干净）
   */
  cleanWindows: number
  /**
   * 升档冷却标记：刚升档后的下一个窗口为防震荡观察窗——丢帧达到
   * 回降阈值则立即回降并重置冷却，否则清除标记恢复常规评估
   */
  justUpgraded: boolean
}

/** 创建初始自适应码率状态（最高档起，随会话重置） */
function createBitrateState(): BitrateAdaptiveState {
  return {
    ladderIndex: 0,
    backlogEwmaBytes: 0,
    cleanWindows: 0,
    justUpgraded: false,
  }
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
  /** 切后台恢复回调（join 注册、cleanupAll 移除） */
  const visibilityResumeHandlerRef = useRef<(() => void) | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const micGainNodeRef = useRef<GainNode | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const silenceGainRef = useRef<GainNode | null>(null)
  /** 反送链路独立增益：闭麦时静音反送（micGain 保持影响上行电平与电平条） */
  const monitorGainRef = useRef<GainNode | null>(null)

  // Opus 编码器相关 refs
  const audioEncoderRef = useRef<AudioEncoder | null>(null)
  const codecDescriptionRef = useRef<ArrayBuffer | null>(null)
  const encoderTimestampRef = useRef(0) // 微秒，单调递增

  // 接收端播放相关 refs
  const playbackContextRef = useRef<AudioContext | null>(null)
  const masterGainRef = useRef<GainNode | null>(null)
  const peerStatesRef = useRef<Map<string, PeerPlaybackState>>(new Map())

  // 语音质量度量统计 refs（埋点数据：上行全局一份，下行按 peer 记录，
  // 随 join/leave 生命周期重置，见「语音质量度量统计」分节）
  const uplinkStatsRef = useRef<UplinkStats>(createUplinkStats())
  const downlinkStatsRef = useRef<Map<string, DownlinkStats>>(new Map())
  /** 质量摘要日志定时器（join 成功后启动，cleanupAll 停止并重置统计） */
  const qualityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 上行自适应码率状态（跨摘要窗口保留，随 join/leave 生命周期重置） */
  const bitrateStateRef = useRef<BitrateAdaptiveState>(createBitrateState())

  // 语音媒体专用连接 refs（语音帧独立通道：与聊天/弹幕/信令隔离，
  // 大消息的 TCP 队头阻塞不再波及 20ms 音频帧）
  const voiceMediaSocketRef = useRef<Socket | null>(null)
  /** 媒体连接已完成 voice-media-init 绑定（上行发送的前提） */
  const mediaReadyRef = useRef(false)
  /** 当前媒体绑定参数（voice-join 应答下发 mediaToken，重连时更新） */
  const mediaInitRef = useRef<{ roomId: string; token: string } | null>(null)

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
    // 通知 AudioWorklet 启用/禁用采集（发送拦截）
    if (workletNodeRef.current?.port) {
      workletNodeRef.current.port.postMessage({ enabled: micEnabled })
    }
    // 反送随麦克风开关静音。不动 track.enabled：禁用 track 会重置
    // 浏览器 AGC/NS/AEC 状态，重开瞬间电平爬升，首句听感异常
    if (monitorGainRef.current) {
      monitorGainRef.current.gain.value = micEnabled ? 1 : 0
    }
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

  // ==================== 语音质量度量统计 ====================
  //
  // 语音链路质量埋点（spec：无度量则无法定位"质量差"的根因——上行丢/
  // 服务端丢/接收端 underrun 三类损伤在此一目了然）：
  // - 上行：编码帧数、背压丢帧数、当前码率档位（本端全局一份）
  // - 下行：接收帧数、间隙丢帧数（mediaTs 跳变推断）、underrun 次数、
  //   PLC 填充时长、各 peer jitter EWMA 与缓冲水位（按 peer 记录）
  // 每 10s 窗口汇总输出单行摘要；无流量的窗口静默（防刷屏）

  /** 惰性创建指定 peer 的下行统计条目 */
  const getDownlinkStats = useCallback((socketId: string): DownlinkStats => {
    let stats = downlinkStatsRef.current.get(socketId)
    if (!stats) {
      stats = {
        receivedFrames: 0,
        gapLostFrames: 0,
        underruns: 0,
        plcFillMs: 0,
        bufferMs: 0,
      }
      downlinkStatsRef.current.set(socketId, stats)
    }
    return stats
  }, [])

  /**
   * 热重配置编码器到新档位并同步统计。configure() 为全量替换语义，
   * 必须携带完整配置（含移动端 opus 扩展参数），故与 setupEncoder
   * 共用 buildEncoderConfig。热重配置只改码率：Opus 码率不体现在
   * decoderConfig 的 description 中（OpusHead 只含采样率/声道数/
   * 预跳），接收端解码器无需重配置，也无需重发 voice-codec-config。
   * PCM 回退模式（不支持 WebCodecs）无编码器也无码率概念，不动作
   */
  const applyBitrateIndex = useCallback((nextIndex: number, reason: string) => {
    const encoder = audioEncoderRef.current
    if (!encoder) return
    // 边界防护：越界档位（最低档再降/最高档再升）不动作——
    // 已在最低档仍拥塞时维持现有背压丢帧逻辑兜底（spec：档位下限）
    const clamped = Math.max(0, Math.min(BITRATE_LADDER.length - 1, nextIndex))
    const adaptive = bitrateStateRef.current
    if (clamped === adaptive.ladderIndex) return
    const prevBitrate = BITRATE_LADDER[adaptive.ladderIndex]
    const nextBitrate = BITRATE_LADDER[clamped]
    try {
      // 热重配置不断流：编码器保持 configured 状态，后续帧按新码率编码
      encoder.configure(buildEncoderConfig(nextBitrate))
    } catch (err) {
      // 配置失败（编码器已 closed 等）：保持原档位不动，错误回调的
      // 节流重建会以 ladderIndex 当前档位兜底重建
      console.error('[voice] bitrate reconfigure failed:', err)
      return
    }
    adaptive.ladderIndex = clamped
    // 摘要日志 br 字段读取该值（AudioEncoder 无读取当前配置的 API）
    uplinkStatsRef.current.currentBitrate = nextBitrate
    console.log(
      `[voice] bitrate ${Math.round(prevBitrate / 1000)}k -> ` +
        `${Math.round(nextBitrate / 1000)}k (${reason})`
    )
  }, [])

  /**
   * 10s 摘要窗口边界处的升降档评估。与质量摘要共用同一窗口节奏：
   * 丢帧/编码计数本就按该窗口累计，在窗口计数重置前读取评估即可，
   * 无需独立定时器；跨窗口状态（档位索引/干净窗口数/backlog EWMA/
   * 冷却标记）存于 bitrateStateRef，不受窗口计数重置影响。
   * 闭麦/禁言窗口（无上行样本）不评估：丢帧恒为 0 会虚增
   * "干净窗口"导致恢复开麦后立刻盲目升档
   */
  const evaluateBitrateAdjustment = useCallback(
    (dropped: number, encoded: number) => {
      // 本窗口无上行帧（闭麦/禁言）：无样本不评估，跨窗口状态原样保留
      if (encoded === 0) return
      const adaptive = bitrateStateRef.current
      if (adaptive.justUpgraded) {
        // 升档后防震荡观察窗：只判定新档位是否超出网络承受力。
        // 观察窗不计干净窗口，通过后下个窗口才恢复累积——升档节奏
        // 自然放缓为"升一档歇 10s"，符合慢升快降
        adaptive.justUpgraded = false
        if (dropped >= BITRATE_REBOUND_DROP_FRAMES) {
          // 升档即引发丢帧：网络承受不住新档位，立即回降一档
          applyBitrateIndex(
            adaptive.ladderIndex + 1,
            `upgrade probe failed, dropped ${dropped}/10s`
          )
        }
        // 无论是否回降都重置升档冷却：再升档需重新攒满 2 个干净窗口
        adaptive.cleanWindows = 0
        return
      }
      if (dropped >= BITRATE_DOWNGRADE_DROP_FRAMES) {
        // 持续拥塞快速降档：立即热重配置，从源头减少上行发送量
        applyBitrateIndex(
          adaptive.ladderIndex + 1,
          `uplink congestion, dropped ${dropped}/10s`
        )
        adaptive.cleanWindows = 0
        return
      }
      if (
        dropped === 0 &&
        adaptive.ladderIndex > 0 &&
        adaptive.backlogEwmaBytes <
          UPLINK_QUEUE_LIMIT_BYTES * BITRATE_UPGRADE_BACKLOG_RATIO
      ) {
        // 无丢帧且 backlog EWMA 低于阈值 50%：拥塞消退，累计干净窗口
        adaptive.cleanWindows++
        if (adaptive.cleanWindows >= BITRATE_UPGRADE_CLEAN_WINDOWS) {
          // 连续 2 个窗口（20s）达标才升档，并进入防震荡观察窗
          applyBitrateIndex(
            adaptive.ladderIndex - 1,
            `uplink clear, backlog ewma ${Math.round(adaptive.backlogEwmaBytes)}B`
          )
          adaptive.justUpgraded = true
          adaptive.cleanWindows = 0
        }
        return
      }
      // 有零星丢帧（未达降档阈值）或 backlog 偏高：不是干净窗口，
      // 升档资格清零重新观察
      adaptive.cleanWindows = 0
    },
    [applyBitrateIndex]
  )

  /** 启动周期性质量摘要日志（join 成功后调用，幂等） */
  const startQualitySummary = useCallback(() => {
    if (qualityTimerRef.current) return
    qualityTimerRef.current = setInterval(() => {
      // 汇总下行：计数类指标求和；jitter/水位取最差 peer
      // （诊断视角：最差链路决定整体听感下限）
      let recv = 0
      let gap = 0
      let underrunCount = 0
      let plcMs = 0
      let maxJitterMs = 0
      let maxBufMs = 0
      downlinkStatsRef.current.forEach((stats, socketId) => {
        recv += stats.receivedFrames
        gap += stats.gapLostFrames
        underrunCount += stats.underruns
        plcMs += stats.plcFillMs
        // jitter EWMA 存于播放状态（累积值，跨窗口不重置），输出时读取
        const state = peerStatesRef.current.get(socketId)
        if (state) {
          maxJitterMs = Math.max(maxJitterMs, state.jitterEwma * 1000)
        }
        maxBufMs = Math.max(maxBufMs, stats.bufferMs)
      })

      const uplink = uplinkStatsRef.current
      // 无流量窗口静默：本端闭麦且无接收时不输出（避免刷屏）
      if (uplink.encodedFrames === 0 && recv === 0) return

      // 升降档评估：必须在下方窗口计数重置前读取本窗口丢帧/编码数。
      // 评估先行，摘要 br 字段即显示切换后的最新档位
      evaluateBitrateAdjustment(uplink.droppedFrames, uplink.encodedFrames)

      // 多 peer 时标注 peer 数，下行为各 peer 汇总值
      const peerCount = downlinkStatsRef.current.size
      const peerPart = peerCount > 1 ? ` peers ${peerCount}` : ''
      console.log(
        `[voice] quality ${QUALITY_SUMMARY_INTERVAL_MS / 1000}s ` +
          `▲ enc ${uplink.encodedFrames} drop ${uplink.droppedFrames} ` +
          `br ${Math.round(uplink.currentBitrate / 1000)}k | ` +
          `▼${peerPart} recv ${recv} gap ${gap} ` +
          `underrun ${underrunCount} plc ${Math.round(plcMs)}ms ` +
          `jitter ${maxJitterMs.toFixed(1)}ms buf ${Math.round(maxBufMs)}ms`
      )

      // 重置窗口计数（jitter EWMA 与缓冲水位为累积/最新值不重置；
      // 自适应码率跨窗口状态——档位索引/干净窗口数/backlog EWMA——
      // 存于 bitrateStateRef，同样不在此重置）
      uplink.encodedFrames = 0
      uplink.droppedFrames = 0
      downlinkStatsRef.current.forEach((stats) => {
        stats.receivedFrames = 0
        stats.gapLostFrames = 0
        stats.underruns = 0
        stats.plcFillMs = 0
      })
    }, QUALITY_SUMMARY_INTERVAL_MS)
  }, [evaluateBitrateAdjustment])

  /** 停止摘要日志并重置全部统计（cleanupAll 调用；下次 join 重新累计） */
  const stopQualitySummary = useCallback(() => {
    if (qualityTimerRef.current) {
      clearInterval(qualityTimerRef.current)
      qualityTimerRef.current = null
    }
    uplinkStatsRef.current = createUplinkStats()
    // 档位状态随会话一并重置：下次 join 从最高档重新探测
    // （跨会话保留弱网记忆不可取——网络环境可能已改变）
    bitrateStateRef.current = createBitrateState()
    downlinkStatsRef.current.clear()
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
      sampleRate: number,
      mediaTsUs?: number
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
            // audioData.timestamp 直通编码 chunk.timestamp（微秒），
            // 供播放侧做 mediaTs 间隙丢帧检测（PCM 回退路径不传）
            playAudioChunkRef.current(
              socketId,
              float32,
              audioData.sampleRate,
              audioData.timestamp
            )
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
        lastArrivalAt: 0,
        jitterEwma: 0,
        lastPcm: null,
        lastMediaTsUs: 0,
        // 动态水位从平台基线起步（无漂移证据时不改变原行为），
        // 首帧到达时窗口起点经到期评估对齐到真实时刻
        dynamicBufferMinSec: BUFFER_MIN_BASELINE_SEC,
        driftUnderrunCount: 0,
        driftWindowFrames: 0,
        driftWindowStartMs: 0,
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

  /**
   * 播放收到的 PCM 音频块。mediaTsUs 为该帧编码时间戳（微秒，Opus
   * 模式由 AudioData.timestamp 直通），用于间隙丢帧检测与 PLC 填充；
   * PCM 回退模式不传（无编码时间戳，间隙检测不生效，行为不变）
   */
  const playAudioChunk = useCallback(
    (
      socketId: string,
      pcmData: Float32Array<ArrayBuffer>,
      sampleRate: number,
      mediaTsUs?: number
    ) => {
      const ctx = playbackContextRef.current
      if (!ctx) return
      const state = ensurePeerPlayback(socketId)
      if (!state) return

      // 质量埋点：接收帧计数（正常帧调度主路径；PLC 填充为函数内部
      // 合成，不经独立调用，无重复计数）
      const dlStats = getDownlinkStats(socketId)
      dlStats.receivedFrames++

      // 创建 AudioBuffer（copyToChannel 内部拷贝数据，无需先复制一份）
      const audioBuffer = ctx.createBuffer(1, pcmData.length, sampleRate)
      audioBuffer.copyToChannel(pcmData, 0)

      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(state.gainNode)

      const now = ctx.currentTime

      // ---- 自适应 jitter buffer：到达抖动 EWMA → 目标水位 ----
      const arrivalNow = performance.now()
      // 上一帧到达间隔（ms）：供下方 underrun 判定"连续语音中的卡顿"
      const prevIntervalMs =
        state.lastArrivalAt > 0 ? arrivalNow - state.lastArrivalAt : 0
      if (state.lastArrivalAt > 0) {
        const intervalSec = prevIntervalMs / 1000
        // 间隔异常大（暂停/对方静音后恢复）不纳入统计；
        // 期望间隔与编码帧长联动（移动端 40ms 长帧），否则统计虚高
        if (intervalSec > 0 && intervalSec < 0.5) {
          const expectedSec = IS_MOBILE
            ? MOBILE_OPUS_FRAME_SEC
            : VOICE_FRAME_SEC
          const deviation = Math.abs(intervalSec - expectedSec)
          state.jitterEwma = state.jitterEwma * 0.9 + deviation * 0.1
        }
      }
      state.lastArrivalAt = arrivalNow
      // 漂移评估窗口的流量计数（回落评估据此判定"持续有接收流量"）
      state.driftWindowFrames++
      // 移动端放宽 jitter buffer：手机网络的抖动与基站切换突刺远大于桌面，
      // 桌面档位会让起播水位频繁被击穿（underrun → 重置 → 再 underrun
      // 的断续循环），这就是移动端"严重卡顿"的直接听感来源。
      // min 分量不用平台常量而用该 peer 的动态水位（时钟漂移补偿，
      // 见 evaluateDriftBufferMin）——漂移证据只对具体收发链路有意义
      const bufferMax = IS_MOBILE
        ? MOBILE_BUFFER_MAX_SEC
        : TARGET_BUFFER_MAX_SEC
      const bufferBase = IS_MOBILE
        ? MOBILE_BUFFER_BASE_SEC
        : TARGET_BUFFER_BASE_SEC
      const backlogResetSec = IS_MOBILE
        ? MOBILE_BACKLOG_RESET_SEC
        : BACKLOG_RESET_SEC
      const targetBuffer = Math.min(
        bufferMax,
        Math.max(state.dynamicBufferMinSec, 2 * state.jitterEwma + bufferBase)
      )

      // ---- 时间线调度 ----
      // underrun：时间线落后于当前时刻（主线程卡顿/网络突发把队列排空）
      // → 以目标水位重新起播。帧仍在密集到达时发生即为真实卡顿，
      // debug 级日志便于排查（静音后恢复的正常起播不记录）
      let timeline = state.nextStartTime
      // 本帧是否 underrun：间隙 PLC 仅对队列存活的连续语音生效，
      // underrun 分支已重置时间线并完成空洞填充，不能重复填
      const underrun = timeline < now
      if (underrun) {
        if (prevIntervalMs > 0 && prevIntervalMs < 150) {
          // 质量埋点：连续语音中的 underrun（真实卡顿）；
          // 静音后恢复的首次起播不满足此间隔条件，不计
          dlStats.underruns++
          // 漂移补偿窗口独立计数（口径一致：仅连续语音 underrun）。
          // dlStats.underruns 每 10s 被质量摘要重置，不能复用——
          // 否则 30s 漂移窗口只能"看见"最后 10s 的 underrun
          state.driftUnderrunCount++
          console.debug(
            `[voice] underrun during continuous speech ` +
              `(deficit ${Math.round((now - timeline) * 1000)}ms, ` +
              `buffer target ${Math.round(targetBuffer * 1000)}ms)`
          )
        }
        timeline = now + targetBuffer

        // ---- PLC（丢包隐藏）----
        // underrun 在输出时间线上留出 [now, timeline) 的静音空洞。
        // TCP 可靠传输下帧不会中途丢失（迟到≠丢失），缺口以 underrun
        // 形态出现；用上一帧解码 PCM 循环复制 + 指数衰减合成填充，
        // 连续语音中的卡顿从"死寂"变为短暂减弱的人声残留。
        // 不填充的两种情况：
        // - 静音后恢复（prevIntervalMs ≥ 150ms）：无语音连续性预期，
        //   填充反而凭空造声
        // - 极端空洞超过 PLC_MAX_FILL_SEC：长冻结时大段"机器人残响"
        //   比静音更刺耳，超出部分保持静音（衰减包络已自然淡出）
        if (prevIntervalMs > 0 && prevIntervalMs < 150) {
          const fillSec = Math.min(timeline - now, PLC_MAX_FILL_SEC)
          // 质量埋点：PLC 填充时长累计（窗口汇总，反映卡顿修复占比）；
          // 未实际合成（素材缺失/空洞过短）时辅助函数返回 0
          dlStats.plcFillMs +=
            schedulePlcFill(state, ctx, now, fillSec, sampleRate) * 1000
        }
      }

      // ---- 时钟漂移补偿：30s 评估窗口到期则调整动态最低水位 ----
      // 放在 underrun 计数之后：本帧 underrun 计入当前窗口，凑满阈值
      // 即可抬升。水位变化不重排已排队时间线，本帧 targetBuffer 亦
      // 不回溯重算（时间线只进不退）
      evaluateDriftBufferMin(state, socketId, arrivalNow, bufferMax)

      // ---- mediaTs 间隙检测与 PLC 填充 ----
      // 服务端慢消费者跳帧与上行背压丢帧在传输途中已被吞掉，到达接收
      // 端只表现为 mediaTs 跳变——若仍按帧长首尾相接排队，丢失的时间
      // 在时间线上直接塌缩，听感为内容跳切断音。依据 mediaTs（而非
      // 到达时间）判定：Socket.IO 批量到达的帧 mediaTs 连续，不误触发；
      // 闭麦后重开麦 mediaTs 单调递增同样连续，不误触发
      if (mediaTsUs !== undefined && mediaTsUs > 0) {
        if (state.lastMediaTsUs > 0) {
          // 期望帧长与编码端联动（移动端 40ms 长帧），否则间隙判定
          // 阈值失真
          const expectedFrameSec = IS_MOBILE
            ? MOBILE_OPUS_FRAME_SEC
            : VOICE_FRAME_SEC
          const tsGapSec = (mediaTsUs - state.lastMediaTsUs) / 1_000_000
          if (tsGapSec > 1.5 * expectedFrameSec) {
            // 丢失净时长 = 总间隙 - 前后帧正常衔接占用的 1 帧长
            // （如丢 2 帧则 tsGap 为 3 帧长、填充 2 帧长）
            const gapSec = tsGapSec - expectedFrameSec
            // 质量埋点：mediaTs 间隙推断丢帧数（与服务端跳帧/上行
            // 背压丢帧两类源头在到达侧的表现统一对应）。underrun 时
            // 时间线已重置、不填充，但丢帧事实仍要计数
            dlStats.gapLostFrames += Math.round(tsGapSec / expectedFrameSec) - 1
            if (!underrun) {
              // 仅队列存活的连续语音插入填充（复用 underrun PLC 的
              // 循环复制 + 指数衰减算法）；超出 PLC_MAX_FILL_SEC 的
              // 空洞部分不填源、保持纯静音
              const fillSec = Math.min(gapSec, PLC_MAX_FILL_SEC)
              // 质量埋点：PLC 填充时长累计（仅计实际合成部分）
              dlStats.plcFillMs +=
                schedulePlcFill(state, ctx, timeline, fillSec, sampleRate) *
                1000
              // 时间线推进完整 gapSec（PLC 覆盖部分 + 超限静音部分）：
              // 空洞以占位而非塌缩的形态存在，后续帧的排队起点不被
              // 丢帧拉前，避免时间线整体前移的连锁跳变
              timeline += gapSec
            }
          }
        }
        // 每帧更新（含无间隙帧）：作为下一帧间隙比较的基准
        state.lastMediaTsUs = mediaTsUs
      }

      // 纯排队播放：时间线只进不退，也绝不向前跳。
      // - Socket.IO 消息批量到达是常态（一次涌入 5~10 帧），瞬时水位
      //   偏高是正常排队而非积压，时间线以 20ms/帧匀速消化，不可丢帧
      //   或变速追赶（丢帧断续、变速变调）
      // - 不可用 max(now + targetBuffer, timeline)：targetBuffer 随抖动
      //   EWMA 波动抬升时会把已排队的时间线整体前推，每次抬升插入
      //   (新水位 - 旧水位) 的静音空洞，反复抬升 → 反复插洞 → 持续
      //   卡顿。水位只在 underrun 重起播时生效
      const startTime = timeline
      state.pendingSources.add(source)
      source.onended = () => {
        state.pendingSources.delete(source)
      }
      source.start(startTime)
      state.nextStartTime = startTime + audioBuffer.duration
      // 记录最近一帧解码 PCM，供后续 underrun 时 PLC 合成（见上）
      state.lastPcm = pcmData

      // 极端积压（网络中断后恢复的突发批量）：丢弃已排队未播的旧块
      // 再重置时间线。实时语音宁可断 0.5s 音，也不能让新旧时间线
      // 重叠播放
      if (state.nextStartTime - now > backlogResetSec) {
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

      // 质量埋点：记录本帧调度后的缓冲水位（含上方积压重置修正），
      // 摘要输出取各 peer 最新值
      dlStats.bufferMs = Math.max(0, (state.nextStartTime - now) * 1000)
    },
    [ensurePeerPlayback, getDownlinkStats]
  )

  // 断开循环引用的 ref 必须在此赋值：解码器 output 回调经
  // playAudioChunkRef 调用真正的播放实现。漏掉此赋值时 ref 保持
  // 初始的空函数，解码出的所有音频被静默丢弃——双向完全无声且
  // 控制台无任何报错（Opus 解码本身正常）。
  // effect 时序安全：解码器仅在 join()（用户触发、含 getUserMedia
  // 等待）中创建，音频输出必然晚于本 effect 执行
  useEffect(() => {
    playAudioChunkRef.current = playAudioChunk
  }, [playAudioChunk])

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
      // 释放 PLC 合成素材引用
      state.lastPcm = null
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
    // 质量统计同步清理：成员反复进出房间时不残留条目（防 Map 泄漏）
    downlinkStatsRef.current.delete(socketId)
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

    // 停止质量摘要日志并重置统计（下次 join 从零累计）
    stopQualitySummary()

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
      monitorGainRef.current = null
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

    // 断开语音媒体专用连接（监听器由 mount effect 统一管理，仅断链；
    // 重进语音时 attachMediaSocket 会重新 connect 并绑定）
    mediaReadyRef.current = false
    mediaInitRef.current = null
    if (voiceMediaSocketRef.current) {
      try {
        voiceMediaSocketRef.current.disconnect()
      } catch {
        // ignore
      }
      voiceMediaSocketRef.current = null
    }

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
    // 移除切后台恢复监听
    if (visibilityResumeHandlerRef.current) {
      document.removeEventListener(
        'visibilitychange',
        visibilityResumeHandlerRef.current
      )
      visibilityResumeHandlerRef.current = null
    }
  }, [cleanupPeerPlayback, stopMonitor, stopLevelDetection, stopQualitySummary])

  // ==================== 语音媒体专用连接 ====================

  /** 媒体连接建立/重连后重新绑定（voice-media-init，token 幂等可重复） */
  const handleMediaConnect = useCallback(() => {
    const ms = voiceMediaSocketRef.current
    const init = mediaInitRef.current
    if (!ms || !init) return
    ms.emit(
      'voice-media-init',
      init,
      (res: { success: boolean; message?: string }) => {
        if (res.success) {
          mediaReadyRef.current = true
        } else {
          // 绑定失败（重连竞态下 token 对应的成员已被顶替/移除）：
          // voice-join 重连流程会下发新 token 并重新触发绑定
          mediaReadyRef.current = false
          console.warn('[voice] media init failed:', res.message)
        }
      }
    )
  }, [])

  /** 确保媒体连接存在并处于连接中（绑定时机的唯一入口） */
  const attachMediaSocket = useCallback(() => {
    const ms = getVoiceMediaSocket()
    voiceMediaSocketRef.current = ms
    if (ms.connected) {
      // 已连接（重连顶替/重新 join）：立即用最新 token 重新绑定
      handleMediaConnect()
    } else {
      ms.connect()
      // 绑定由 'connect' 事件回调（handleMediaConnect）完成
    }
  }, [handleMediaConnect])

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

      // track 保持常开：禁用 track.enabled 会重置浏览器 AGC/NS/AEC
      // 状态，重开瞬间电平爬升导致首句听感异常；发送拦截由 worklet
      // 承担，反送静音由 monitorGain 承担

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

      // 同时创建反送流（micGain → monitorGain → destination）。
      // monitorGain 独立于 micGain：闭麦时仅静音反送，micGain 继续
      // 驱动 worklet 输入与本地电平检测
      const monitorDestination = captureCtx.createMediaStreamDestination()
      const monitorGain = captureCtx.createGain()
      monitorGain.gain.value = micEnabledRef.current ? 1 : 0
      micGain.connect(monitorGain)
      monitorGain.connect(monitorDestination)
      monitorStreamRef.current = monitorDestination.stream

      await captureCtx.resume()
      audioContextRef.current = captureCtx
      micGainNodeRef.current = micGain
      monitorGainRef.current = monitorGain
      workletNodeRef.current = workletNode
      silenceGainRef.current = silenceGain

      // 3. Opus 编码器设置（WebCodecs 模式）
      // 上行发送助手：语音帧走媒体专用连接。未就绪（绑定未完成/绑定
      // 失败）时丢帧——实时语义下宁缺帧不积压，绑定在 join 应答后立即
      // 进行，正常情况下编码器产出首帧前早已就绪
      const emitMediaAudio = (payload: {
        data: ArrayBufferLike
        sampleRate?: number
        timestamp: number
        mediaTs?: number
        encoded?: boolean
      }) => {
        const ms = voiceMediaSocketRef.current
        if (!ms || !mediaReadyRef.current) return
        ms.emit('voice-media-data', payload)
      }

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

                // 发送编码后的音频。不用 volatile：volatile 在 socket 忙于
                // 写入时静默丢帧，而播放以实时速度消耗、发送也以实时速度
                // 生产，丢掉的帧永远无法补回，只能持续排空 jitter buffer
                // （实测每 1~2s 一次 underrun）。排队发送的突发延迟由
                // 接收端 jitter buffer 吸收
                emitMediaAudio({
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

            // 码率取当前档位而非固定常量：错误重建会重新执行本函数，
            // 通话中途编码器出错若回跳最高档，会再经历一轮拥塞降档
            // 探测（丢帧数秒）；初始 join 时 ladderIndex 恒为 0
            // （stopQualitySummary 已随会话重置），即平台最高档
            const bitrate = BITRATE_LADDER[bitrateStateRef.current.ladderIndex]
            // 配置构造与热重配置（applyBitrateIndex）共用
            // buildEncoderConfig：configure() 全量替换语义，移动端
            // opus 扩展参数（40ms 长帧/complexity）不遗漏
            encoder.configure(buildEncoderConfig(bitrate))
            // 质量统计：记录当前码率档位（摘要日志 br 字段读取该值，
            // AudioEncoder 无读取当前配置的 API 只能旁路记录）。
            // 初始 configure 与热重配置共用本入口同步统计
            uplinkStatsRef.current.currentBitrate = bitrate
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
        console.log(
          '[voice] Opus encoder configured at',
          BITRATE_LADDER[bitrateStateRef.current.ladderIndex],
          'bps'
        )
      }

      // 4. AudioWorklet 数据回调 → 编码/发送
      // PCM 回退模式的移动端合并状态：积满 PCM_MOBILE_BATCH_FRAMES 帧
      // 拼包发送（20ms/帧 → 40ms/包，包率减半）
      const pcmBatchFrames: Float32Array[] = []
      let pcmBatchSamples = 0
      workletNode.port.onmessage = (e: MessageEvent) => {
        const arrayBuffer = e.data as ArrayBuffer
        if (!arrayBuffer || !joinedRef.current || !micEnabledRef.current) return
        // 自己被禁言：不上行（服务器仍兜底校验，此处省编码与带宽）。
        // 闭麦/禁言期间不采样 backlog EWMA、不参与升降档评估（无样本）
        if (selfMutedRef.current) return
        // 上行背压：媒体连接底层 WebSocket 写入积压超过阈值时丢弃当前帧。
        // 弱网/基站切换下不丢帧会让发送队列无限堆积，延迟单调累积
        // 直到整段语音迟到到不可用
        const backlogBytes = getUplinkBacklogBytes(
          voiceMediaSocketRef.current?.io
        )
        // 自适应码率：每帧维护 backlog EWMA（复用背压判定的同一次读取，
        // 避免重复访问 socket 内部结构）。EWMA 平滑瞬时突发，供升档
        // 条件判定"拥塞是否真正消退"而非恰好处于两个突发之间
        const adaptive = bitrateStateRef.current
        adaptive.backlogEwmaBytes +=
          (backlogBytes - adaptive.backlogEwmaBytes) * UPLINK_BACKLOG_EWMA_ALPHA
        if (backlogBytes > UPLINK_QUEUE_LIMIT_BYTES) {
          // 质量埋点：上行背压丢帧（与编码帧数对照反映上行拥塞程度）
          uplinkStatsRef.current.droppedFrames++
          return
        }

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
            // 质量埋点：编码提交成功计一帧（编码器 output 异步发出）
            uplinkStatsRef.current.encodedFrames++
            // 递增时间戳（微秒）
            encoderTimestampRef.current +=
              (float32.length / captureCtx.sampleRate) * 1_000_000
          } catch (err) {
            console.error('[voice] encode error:', err)
          }
        } else {
          // PCM 回退模式：直接发送 Int16 数据（同样不用 volatile，理由同上）
          if (IS_MOBILE) {
            // 移动端合并 2 帧（40ms）拼包发送：旧设备不支持 WebCodecs
            // 时恰是性能最弱的场景，20ms 一包的小包开销不可承受
            pcmBatchFrames.push(float32)
            pcmBatchSamples += float32.length
            if (pcmBatchSamples < FRAME_SIZE * PCM_MOBILE_BATCH_FRAMES) return
            const merged = new Float32Array(pcmBatchSamples)
            let offset = 0
            for (const frame of pcmBatchFrames) {
              merged.set(frame, offset)
              offset += frame.length
            }
            pcmBatchFrames.length = 0
            pcmBatchSamples = 0
            const int16 = float32ToInt16(merged)
            emitMediaAudio({
              data: int16.buffer,
              sampleRate: captureCtx.sampleRate,
              timestamp: Date.now(),
              encoded: false,
            })
            // 质量埋点：上行发出帧计数（移动端 40ms 合并包按 1 计）
            uplinkStatsRef.current.encodedFrames++
            return
          }
          const int16 = float32ToInt16(float32)
          emitMediaAudio({
            data: int16.buffer,
            sampleRate: captureCtx.sampleRate,
            timestamp: Date.now(),
            encoded: false,
          })
          // 质量埋点：上行发出帧计数
          uplinkStatsRef.current.encodedFrames++
        }
      }

      // 5. 创建接收端播放 AudioContext（同样锁定 48kHz：解码输出为 48kHz，
      // 不匹配时 WebAudio 会隐式重采样，引入额外延迟与质量损失）
      const playbackCtx = new AudioContext({
        sampleRate: OPUS_SAMPLE_RATE,
        // 交互级输出缓冲：请求更小的硬件输出缓冲，端到端延迟随之下降。
        // 实时语音优先低延迟而非吞吐——抖动已由应用层 jitter buffer
        // 吸收，硬件缓冲再垫一层只会让每句话多等一段恒定延迟
        latencyHint: 'interactive',
      })
      const masterGain = playbackCtx.createGain()
      masterGain.gain.value = globalVolumeRef.current
      masterGain.connect(playbackCtx.destination)
      await playbackCtx.resume()
      playbackContextRef.current = playbackCtx
      masterGainRef.current = masterGain

      // 6. 发送 voice-join 到服务器
      // username 作为游客昵称兜底（登录用户服务器优先采用 token 中的用户名）
      const response = await new Promise<
        | {
            success: true
            members: VoiceMember[]
            selfMuted?: boolean
            mediaToken: string
          }
        | { success: false; message: string }
      >((resolve) => {
        currentSocket.emit(
          'voice-join',
          {
            roomId: currentRoomId,
            username,
            // 多实例（仅供测试）：恒上报每标签页独立 instanceId，
            // 是否生效由服务端系统设置 roomMultiInstanceLogin 门控——
            // 开启时派生独立成员键，多页面互不顶替；关闭时服务端忽略
            instanceId: getVoiceInstanceId(),
          },
          (
            res:
              | {
                  success: true
                  members: VoiceMember[]
                  selfMuted?: boolean
                  mediaToken: string
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

      // 7. 建立语音媒体专用连接并绑定（上行/下行语音帧都走这条连接，
      // 与主连接上的聊天/弹幕/信令隔离——TCP 队头阻塞下大消息不再
      // 把音频帧顶在后面排队）
      mediaInitRef.current = {
        roomId: currentRoomId,
        token: response.mediaToken,
      }
      attachMediaSocket()

      // 移动端切后台时系统会 suspend AudioContext（iOS 尤甚），回前台
      // 若不显式 resume，采集与播放都会停摆，表现为严重卡顿/完全无声。
      // document-level 监听跨 join/leave 生命周期在 join 成功段注册
      const handleVisibilityResume = () => {
        if (document.visibilityState !== 'visible') return
        for (const ctx of [
          audioContextRef.current,
          playbackContextRef.current,
        ]) {
          if (ctx && ctx.state === 'suspended') {
            void ctx.resume().catch(() => {
              // ignore：恢复失败由后续状态变化兜底
            })
          }
        }
      }
      visibilityResumeHandlerRef.current = handleVisibilityResume
      document.addEventListener('visibilitychange', handleVisibilityResume)

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

      // 启动质量摘要日志（10s 窗口，无流量窗口静默；
      // leave/cleanupAll 停止并重置统计）
      startQualitySummary()
    } catch (err) {
      console.error('[voice] join error:', err)
      // 按具体原因提示，避免把所有失败都归为"权限问题"
      if (!navigator.mediaDevices?.getUserMedia) {
        // HTTP 非安全上下文（局域网 IP 直连）或 iframe 未授权
        message.error(
          '当前环境不支持麦克风采集，请通过 HTTPS 或 localhost 访问'
        )
      } else {
        const name = (err as { name?: string })?.name ?? ''
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          message.error('麦克风权限被拒绝，请在浏览器地址栏权限中允许后重试')
        } else if (
          name === 'NotFoundError' ||
          name === 'DevicesNotFoundError'
        ) {
          message.error('未找到可用的麦克风设备')
        } else {
          message.error(
            '加入语音失败：' +
              (err instanceof Error ? err.message : String(err))
          )
        }
      }
      // 中途任一步骤异常（如 addModule 失败）都可能已创建 AudioContext，
      // 统一走完整清理避免泄漏
      cleanupAll()
    }
  }, [
    joining,
    username,
    ensurePeerPlayback,
    cleanupAll,
    setupLocalAnalyser,
    startLevelDetection,
    startQualitySummary,
    attachMediaSocket,
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

    socket.on('voice-codec-config', handleVoiceCodecConfig)
    socket.on('voice-user-joined', handleVoiceUserJoined)
    socket.on('voice-user-left', handleVoiceUserLeft)
    socket.on('voice-muted-changed', handleVoiceMutedChanged)
    socket.on('voice-kicked', handleVoiceKicked)

    return () => {
      socket.off('voice-codec-config', handleVoiceCodecConfig)
      socket.off('voice-user-joined', handleVoiceUserJoined)
      socket.off('voice-user-left', handleVoiceUserLeft)
      socket.off('voice-muted-changed', handleVoiceMutedChanged)
      socket.off('voice-kicked', handleVoiceKicked)
    }
  }, [
    socket,
    handleVoiceCodecConfig,
    handleVoiceUserJoined,
    handleVoiceUserLeft,
    handleVoiceMutedChanged,
    handleVoiceKicked,
  ])

  // 语音媒体专用连接事件（下行音频）：单例连接，监听器挂载期注册一次；
  // 连接/断开的生命周期由语音会话（join/leave）驱动，处理函数内部以
  // joinedRef/mediaInitRef 守卫，会话外的事件触发均为无操作
  useEffect(() => {
    const ms = getVoiceMediaSocket()
    voiceMediaSocketRef.current = ms
    ms.on('connect', handleMediaConnect)
    ms.on('voice-media-data', handleVoiceAudioData)
    return () => {
      ms.off('connect', handleMediaConnect)
      ms.off('voice-media-data', handleVoiceAudioData)
    }
  }, [handleMediaConnect, handleVoiceAudioData])

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
        {
          roomId: currentRoomId,
          username: usernameRef.current,
          instanceId: getVoiceInstanceId(),
        },
        (
          res:
            | {
                success: true
                members: VoiceMember[]
                selfMuted?: boolean
                mediaToken: string
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
          // 媒体连接重绑定：新成员条目有新 token（旧媒体连接若还活着，
          // 服务端已随旧条目移除而解绑；此处的 connect/init 会重新绑定）
          mediaInitRef.current = {
            roomId: currentRoomId,
            token: res.mediaToken,
          }
          attachMediaSocket()
          message.info('语音已重新连接')
        }
      )
    }

    socket.on('connect', handleReconnect)
    return () => {
      socket.off('connect', handleReconnect)
    }
  }, [socket, leave, ensurePeerPlayback, attachMediaSocket])

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
