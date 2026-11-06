/**
 * WebRTC 统计采样。
 *
 * 纯函数：给一份 `RTCStatsReport` 和上一次的基线，算出「这一窗口内」的速率
 * 与当前状态。没有 DOM 依赖（`RTCStatsReport` 就是个 Map），可以直接在 node
 * 测试里构造假报告。
 *
 * 为什么不用 stats 里的 `framesPerSecond` / `bitrate` 之类的现成字段：
 * 那些是浏览器自己的瞬时估算，各家算法不同，和 `chrome://webrtc-internals`
 * 显示的「区间平均」对不上。这里统一用累计计数器做差，和 internals 同口径。
 *
 * **累计值 vs 窗口值**（Piik `webrtc/stats.ts` 的核心教训）：
 * 丢包、冻结、编码耗时、受限原因这些字段在报告里都是**累计**的。直接展示
 * 累计值会骗人——跑了半小时之后，刚才 10 秒丢 5% 的包会被摊成 0.1%，
 * 「现在卡不卡」永远看不出来。所以凡是能差分的都再算一份窗口值，
 * 字段名带 `Window` / `MsPerFrame` / `Share` 后缀。
 */

/** 视频受限原因。Chrome 只在 outbound-rtp 上给这个字段。 */
export type QualityLimitationReason = 'none' | 'cpu' | 'bandwidth' | 'other'

/** 受限原因各占多少时间（秒，累计值）。 */
export interface QualityLimitationDurations {
  none: number
  bandwidth: number
  cpu: number
  other: number
}

/**
 * 音频（系统声）统计。
 *
 * 屏幕共享的音画不同步、观众说「声音断断续续」，靠视频那一路看不出来：
 * 得单独看音频的丢包、抖动缓冲与丢包隐藏比例。
 */
export interface ShareAudioStats {
  receiving: boolean
  sending: boolean
  /** 本窗口码率（bps）。 */
  bitrate: number | null
  /** 本窗口丢包率。 */
  packetLossRate: number | null
  jitterMs: number | null
  /** 接收侧实测电平（0–1），用来判断「到底有没有声音」。 */
  level: number | null
  /** 本窗口内靠丢包隐藏补出来的采样占比（0–1）。越高越像「断续」。 */
  concealmentRate: number | null
  /** 抖动缓冲平均驻留时长，毫秒。 */
  jitterBufferMs: number | null
}

/** 上一次采样的累加计数器。速率只能靠两次差分得出。 */
export interface StatsBaseline {
  inboundId: string | null
  inboundBytes: number
  inboundFrames: number
  inboundTimestamp: number
  outboundId: string | null
  outboundBytes: number
  outboundFrames: number
  outboundTimestamp: number
  /** 视频接收侧的窗口计数器。 */
  inboundCounters: InboundCounters
  /** 视频发送侧的窗口计数器。 */
  outboundCounters: OutboundCounters
  audioInId: string | null
  audioInCounters: AudioCounters
  audioOutId: string | null
  audioOutCounters: AudioCounters
}

/** 接收侧需要差分的累计计数（`null` 表示浏览器没给这个字段）。 */
export interface InboundCounters {
  packetsReceived: number | null
  packetsLost: number | null
  framesDropped: number | null
  freezeCount: number | null
  freezeDuration: number | null
  jitterBufferDelay: number | null
  jitterBufferEmitted: number | null
  decodeTime: number | null
}

/** 发送侧需要差分的累计计数。 */
export interface OutboundCounters {
  packetsSent: number | null
  encodeTime: number | null
  limitation: QualityLimitationDurations | null
}

/** 音频收发共用的累计计数。 */
export interface AudioCounters {
  bytes: number | null
  timestamp: number | null
  packetsReceived: number | null
  packetsSent: number | null
  packetsLost: number | null
  totalSamplesReceived: number | null
  concealedSamples: number | null
  jitterBufferDelay: number | null
  jitterBufferEmitted: number | null
}

export interface ShareStats {
  /** 有正在接收的视频流。 */
  receiving: boolean
  /** 有正在发送的视频流。 */
  sending: boolean
  resolution: { width: number; height: number } | null
  /** 本窗口平均帧率。 */
  frameRate: number | null
  /** 本窗口平均码率（bps）。 */
  bitrate: number | null
  codec: string | null
  rttMs: number | null
  jitterMs: number | null
  packetsReceived: number | null
  packetsSent: number | null
  packetsLost: number | null
  /** 累计丢包比例（整条连接的平均，不是窗口）。 */
  packetLossRate: number | null
  /** 本窗口丢包比例。诊断「现在卡不卡」要看这个。 */
  windowPacketLossRate: number | null
  qualityLimitationReason: QualityLimitationReason | null
  /** 本窗口内各受限原因的时间占比（%），合起来接近 100。 */
  limitationShare: QualityLimitationDurations | null
  encoderImplementation: string | null
  /** 累计冻结次数（接收侧）。 */
  freezeCount: number | null
  /** 累计冻结时长，毫秒。 */
  totalFreezeMs: number | null
  /** 本窗口新增的冻结次数。 */
  freezeCountWindow: number | null
  /** 本窗口新增的冻结时长，毫秒。 */
  freezeMsWindow: number | null
  /** 本窗口被丢弃的解码帧数。 */
  framesDroppedWindow: number | null
  /** 本窗口平均解码耗时，毫秒/帧。 */
  decodeMsPerFrame: number | null
  /** 本窗口平均编码耗时，毫秒/帧——CPU 瓶颈的直接证据。 */
  encodeMsPerFrame: number | null
  /** 抖动缓冲的平均驻留时长，毫秒。 */
  jitterBufferMs: number | null
  /** 音频统计；这条 PC 上没有音轨时为 `null`。 */
  audio: ShareAudioStats | null
}

/** 统计值来源：inbound-rtp 还是 outbound-rtp。 */
const VIDEO = 'video'
const AUDIO = 'audio'

/** 浏览器实现比 TS DOM 声明多出来的字段，用结构化类型补上。 */
type VideoInbound = RTCInboundRtpStreamStats & {
  framesDecoded?: number
  framesDropped?: number
  freezeCount?: number
  totalFreezesDuration?: number
  jitterBufferDelay?: number
  jitterBufferEmittedCount?: number
  totalDecodeTime?: number
}

type VideoOutbound = RTCOutboundRtpStreamStats & {
  framesEncoded?: number
  qualityLimitationReason?: string
  qualityLimitationDurations?: Record<string, unknown>
  encoderImplementation?: string
  totalEncodeTime?: number
}

type CodecStat = { id: string; mimeType?: string }

/** 空统计：还没连上或报告里什么都没有时用。 */
export function emptyShareStats(): ShareStats {
  return {
    receiving: false,
    sending: false,
    resolution: null,
    frameRate: null,
    bitrate: null,
    codec: null,
    rttMs: null,
    jitterMs: null,
    packetsReceived: null,
    packetsSent: null,
    packetsLost: null,
    packetLossRate: null,
    windowPacketLossRate: null,
    qualityLimitationReason: null,
    limitationShare: null,
    encoderImplementation: null,
    freezeCount: null,
    totalFreezeMs: null,
    freezeCountWindow: null,
    freezeMsWindow: null,
    framesDroppedWindow: null,
    decodeMsPerFrame: null,
    encodeMsPerFrame: null,
    jitterBufferMs: null,
    audio: null,
  }
}

export function emptyInboundCounters(): InboundCounters {
  return {
    packetsReceived: null,
    packetsLost: null,
    framesDropped: null,
    freezeCount: null,
    freezeDuration: null,
    jitterBufferDelay: null,
    jitterBufferEmitted: null,
    decodeTime: null,
  }
}

export function emptyOutboundCounters(): OutboundCounters {
  return { packetsSent: null, encodeTime: null, limitation: null }
}

export function emptyAudioCounters(): AudioCounters {
  return {
    bytes: null,
    timestamp: null,
    packetsReceived: null,
    packetsSent: null,
    packetsLost: null,
    totalSamplesReceived: null,
    concealedSamples: null,
    jitterBufferDelay: null,
    jitterBufferEmitted: null,
  }
}

/** 空的采样基线。 */
export function emptyBaseline(): StatsBaseline {
  return {
    inboundId: null,
    inboundBytes: 0,
    inboundFrames: 0,
    inboundTimestamp: 0,
    outboundId: null,
    outboundBytes: 0,
    outboundFrames: 0,
    outboundTimestamp: 0,
    inboundCounters: emptyInboundCounters(),
    outboundCounters: emptyOutboundCounters(),
    audioInId: null,
    audioInCounters: emptyAudioCounters(),
    audioOutId: null,
    audioOutCounters: emptyAudioCounters(),
  }
}

/** `active` 不在 TS 的 RTP 统计类型里，但 Chrome 会发。 */
function isActive(row: unknown): boolean {
  return (row as { active?: boolean }).active !== false
}

/**
 * 挑出唯一一条活跃的流。
 *
 * 一个 PC 只承载一路视频，但换源/重协商的瞬间可能短暂出现两条；取码流最大
 * 的那条，避免刚好读到还没出字节的新流而让速率掉成 0。
 */
function pickActive<T>(rows: T[], bytesOf: (row: T) => number): T | undefined {
  const active = rows.filter(isActive)
  if (active.length <= 1) return active[0]
  return active.reduce((best, row) =>
    bytesOf(row) > bytesOf(best) ? row : best
  )
}

function codecName(mimeType: string | undefined): string | null {
  if (!mimeType) return null
  const lower = mimeType.toLowerCase()
  if (!lower.startsWith('video/')) return mimeType
  switch (mimeType.slice('video/'.length).toUpperCase()) {
    case 'H264':
      return 'H.264'
    case 'H265':
      return 'H.265'
    default:
      return mimeType.slice('video/'.length).toUpperCase()
  }
}

/** 把 `qualityLimitationReason` 收成已知取值；未知值按 `other`。 */
function limitationReason(
  value: string | undefined
): QualityLimitationReason | null {
  if (!value) return null
  switch (value) {
    case 'none':
    case 'cpu':
    case 'bandwidth':
      return value
    case 'other':
    default:
      return 'other'
  }
}

/**
 * 受限期时长（秒）。
 *
 * 四个键缺一个就整份丢掉：缺项时没法算占比，硬凑会把「不知道」显示成 0%。
 */
function limitationDurations(
  value: Record<string, unknown> | undefined
): QualityLimitationDurations | null {
  if (!value || typeof value !== 'object') return null
  const result = {} as QualityLimitationDurations
  for (const reason of ['none', 'bandwidth', 'cpu', 'other'] as const) {
    const duration = value[reason]
    if (
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0
    ) {
      return null
    }
    result[reason] = duration
  }
  return result
}

function numberValue(
  row: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  const value = row?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 计数器差值；回退（浏览器重置）时返回 `null`，绝不把负数当速率。 */
function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || current < previous) return null
  return current - previous
}

function perFrameMs(
  totalTime: number | null,
  previousTotalTime: number | null,
  frames: number | null,
  previousFrames: number | null
): number | null {
  const timeDelta = delta(totalTime, previousTotalTime)
  const frameDelta = delta(frames, previousFrames)
  if (timeDelta === null || frameDelta === null || frameDelta <= 0) return null
  return (timeDelta / frameDelta) * 1000
}

/** 占比（%）；分母为 0 或数据不可信时返回 `null`。 */
function sharePercent(
  durations: QualityLimitationDurations | null,
  previous: QualityLimitationDurations | null
): QualityLimitationDurations | null {
  if (!durations || !previous) return null
  const deltas = {} as QualityLimitationDurations
  let total = 0
  for (const reason of ['none', 'bandwidth', 'cpu', 'other'] as const) {
    const value = delta(durations[reason], previous[reason])
    if (value === null) return null
    deltas[reason] = value
    total += value
  }
  if (total <= 0) return null
  return {
    none: (deltas.none / total) * 100,
    bandwidth: (deltas.bandwidth / total) * 100,
    cpu: (deltas.cpu / total) * 100,
    other: (deltas.other / total) * 100,
  }
}

function inboundCountersOf(row: VideoInbound): InboundCounters {
  return {
    packetsReceived: row.packetsReceived ?? null,
    packetsLost: row.packetsLost ?? null,
    framesDropped: row.framesDropped ?? null,
    freezeCount: row.freezeCount ?? null,
    freezeDuration: row.totalFreezesDuration ?? null,
    jitterBufferDelay: row.jitterBufferDelay ?? null,
    jitterBufferEmitted: row.jitterBufferEmittedCount ?? null,
    decodeTime: row.totalDecodeTime ?? null,
  }
}

function outboundCountersOf(row: VideoOutbound): OutboundCounters {
  return {
    packetsSent: row.packetsSent ?? null,
    encodeTime: row.totalEncodeTime ?? null,
    limitation: limitationDurations(row.qualityLimitationDurations),
  }
}

function audioCountersOf(
  row: Record<string, unknown>,
  direction: 'inbound' | 'outbound'
): AudioCounters {
  return {
    bytes:
      direction === 'inbound'
        ? numberValue(row, 'bytesReceived')
        : numberValue(row, 'bytesSent'),
    timestamp: numberValue(row, 'timestamp'),
    packetsReceived: numberValue(row, 'packetsReceived'),
    packetsSent: numberValue(row, 'packetsSent'),
    packetsLost: numberValue(row, 'packetsLost'),
    totalSamplesReceived: numberValue(row, 'totalSamplesReceived'),
    concealedSamples: numberValue(row, 'concealedSamples'),
    jitterBufferDelay: numberValue(row, 'jitterBufferDelay'),
    jitterBufferEmitted: numberValue(row, 'jitterBufferEmittedCount'),
  }
}

/**
 * 从一份统计报告里读出状态，并与上次基线做差得出速率。
 *
 * 返回新的基线：调用方必须把它存下来喂给下一次采样，否则帧率/码率永远是
 * `null`（第一次采样没有可比对象，这是正确的，不是漏算）。
 */
export function sampleShareStats(
  previous: StatsBaseline | null,
  report: RTCStatsReport
): { stats: ShareStats; baseline: StatsBaseline } {
  const inboundRows: VideoInbound[] = []
  const outboundRows: VideoOutbound[] = []
  const audioInboundRows: Record<string, unknown>[] = []
  const audioOutboundRows: Record<string, unknown>[] = []
  const codecs = new Map<string, CodecStat>()
  let pair: RTCIceCandidatePairStats | null = null

  report.forEach((value) => {
    const row = value as RTCStats & Record<string, unknown>
    switch (row.type) {
      case 'codec':
        codecs.set(row.id, row as unknown as CodecStat)
        return
      case 'inbound-rtp':
        if (row.kind === VIDEO) inboundRows.push(row as unknown as VideoInbound)
        if (row.kind === AUDIO) audioInboundRows.push(row)
        return
      case 'outbound-rtp':
        if (row.kind === VIDEO)
          outboundRows.push(row as unknown as VideoOutbound)
        if (row.kind === AUDIO) audioOutboundRows.push(row)
        return
      case 'candidate-pair': {
        const candidate = row as unknown as RTCIceCandidatePairStats
        // 只有被提名的候选对才是真正在跑的那条路径，它的 RTT 才有意义。
        if (!candidate.nominated && candidate.state !== 'succeeded') return
        if (!pair || (candidate.nominated && !pair.nominated)) pair = candidate
        return
      }
      default:
        return
    }
  })

  const inbound = pickActive(inboundRows, (row) => row.bytesReceived ?? 0)
  const outbound = pickActive(outboundRows, (row) => row.bytesSent ?? 0)
  const audioIn = pickActive(
    audioInboundRows,
    (row) => numberValue(row, 'bytesReceived') ?? 0
  )
  const audioOut = pickActive(
    audioOutboundRows,
    (row) => numberValue(row, 'bytesSent') ?? 0
  )

  const stats = emptyShareStats()
  const baseline = emptyBaseline()

  if (inbound) {
    stats.receiving = true
    stats.resolution =
      inbound.frameWidth && inbound.frameHeight
        ? { width: inbound.frameWidth, height: inbound.frameHeight }
        : null
    stats.packetsReceived = inbound.packetsReceived ?? null
    stats.packetsLost = inbound.packetsLost ?? null
    if (
      inbound.packetsReceived !== undefined &&
      inbound.packetsLost !== undefined &&
      inbound.packetsReceived + inbound.packetsLost > 0
    ) {
      stats.packetLossRate =
        inbound.packetsLost / (inbound.packetsReceived + inbound.packetsLost)
    }
    if (typeof inbound.jitter === 'number') {
      stats.jitterMs = Math.round(inbound.jitter * 1000)
    }
    // 抖动缓冲用「累计延迟 / 累计播出帧数」的比值：这就是 internals 里
    // jitterBufferDelay 那一行括号里的平均值，直接读瞬时值并不存在。
    const emitted = inbound.jitterBufferEmittedCount ?? 0
    if (emitted > 0 && typeof inbound.jitterBufferDelay === 'number') {
      stats.jitterBufferMs = Math.round(
        (inbound.jitterBufferDelay / emitted) * 1000
      )
    }
    stats.freezeCount = inbound.freezeCount ?? null
    if (typeof inbound.totalFreezesDuration === 'number') {
      stats.totalFreezeMs = Math.round(inbound.totalFreezesDuration * 1000)
    }
    if (inbound.codecId) {
      stats.codec = codecName(codecs.get(inbound.codecId)?.mimeType)
    }

    baseline.inboundId = inbound.id
    baseline.inboundBytes = inbound.bytesReceived ?? 0
    baseline.inboundFrames = inbound.framesDecoded ?? 0
    baseline.inboundTimestamp = inbound.timestamp ?? 0
    baseline.inboundCounters = inboundCountersOf(inbound)
    applyRates(previous, stats, baseline, 'inbound')
  }

  if (outbound) {
    stats.sending = true
    if (!stats.resolution && outbound.frameWidth && outbound.frameHeight) {
      stats.resolution = {
        width: outbound.frameWidth,
        height: outbound.frameHeight,
      }
    }
    stats.packetsSent = outbound.packetsSent ?? null
    stats.qualityLimitationReason = limitationReason(
      outbound.qualityLimitationReason
    )
    stats.encoderImplementation = outbound.encoderImplementation ?? null
    if (!stats.codec && outbound.codecId) {
      stats.codec = codecName(codecs.get(outbound.codecId)?.mimeType)
    }

    baseline.outboundId = outbound.id
    baseline.outboundBytes = outbound.bytesSent ?? 0
    baseline.outboundFrames = outbound.framesEncoded ?? 0
    baseline.outboundTimestamp = outbound.timestamp ?? 0
    baseline.outboundCounters = outboundCountersOf(outbound)
    applyRates(previous, stats, baseline, 'outbound')
  }

  if (pair) {
    const rtt = pair.currentRoundTripTime
    if (typeof rtt === 'number' && rtt >= 0) {
      stats.rttMs = Math.round(rtt * 1000)
    }
  }

  if (previous) {
    applyWindowMetrics(previous, stats, baseline, inbound, outbound)
    stats.audio = audioStats(previous, baseline, audioIn, audioOut)
  } else if (audioIn || audioOut) {
    // 第一次采样：窗口值算不出来，但「有没有音频」「电平多少」已经可用。
    stats.audio = audioStats(null, baseline, audioIn, audioOut)
  }

  return { stats, baseline }
}

/**
 * 把累计计数器差分成速率，直接写进 `stats`。
 *
 * 三条硬规则：
 *  - `id` 变了就不算：换源/重协商会让计数器归零，拿新旧的差会得出负数或
 *    一个荒谬的大值；
 *  - 时间戳不前进就不算：同一毫秒内的两次采样没有窗口；
 *  - 计数器回退（浏览器重置）按 `null` 处理，不能把负数当速率。
 */
function applyRates(
  previous: StatsBaseline | null,
  stats: ShareStats,
  baseline: StatsBaseline,
  direction: 'inbound' | 'outbound'
): void {
  if (!previous) return
  const id = direction === 'inbound' ? baseline.inboundId : baseline.outboundId
  const prevId =
    direction === 'inbound' ? previous.inboundId : previous.outboundId
  if (!id || id !== prevId) return

  const bytes =
    direction === 'inbound' ? baseline.inboundBytes : baseline.outboundBytes
  const prevBytes =
    direction === 'inbound' ? previous.inboundBytes : previous.outboundBytes
  const frames =
    direction === 'inbound' ? baseline.inboundFrames : baseline.outboundFrames
  const prevFrames =
    direction === 'inbound' ? previous.inboundFrames : previous.outboundFrames
  const timestamp =
    direction === 'inbound'
      ? baseline.inboundTimestamp
      : baseline.outboundTimestamp
  const prevTimestamp =
    direction === 'inbound'
      ? previous.inboundTimestamp
      : previous.outboundTimestamp

  const windowMs = timestamp - prevTimestamp
  if (!(windowMs > 0)) return
  const seconds = windowMs / 1000
  stats.bitrate = (Math.max(0, bytes - prevBytes) * 8) / seconds
  stats.frameRate = Math.max(0, frames - prevFrames) / seconds
}

/**
 * 窗口化指标：丢包、冻结、耗时、受限占比。
 *
 * 与 `applyRates` 分开是因为它要读的计数器多得多，而且每个计数器都要单独
 * 判「id 是否还是同一条流」。Piik 把这一步做成 `createStatsAccumulator`
 * 的 30 多个 previous 字段，这里等价地收进 `InboundCounters` /
 * `OutboundCounters` 两组，语义一致、可读性更好。
 */
function applyWindowMetrics(
  previous: StatsBaseline,
  stats: ShareStats,
  baseline: StatsBaseline,
  inbound: VideoInbound | undefined,
  outbound: VideoOutbound | undefined
): void {
  if (inbound && baseline.inboundId === previous.inboundId) {
    const now = baseline.inboundCounters
    const before = previous.inboundCounters

    const received = delta(now.packetsReceived, before.packetsReceived)
    const lost = delta(now.packetsLost, before.packetsLost)
    if (received !== null && lost !== null && received + lost > 0) {
      stats.windowPacketLossRate = lost / (received + lost)
    }

    stats.freezeCountWindow = delta(now.freezeCount, before.freezeCount)
    const freezeSeconds = delta(now.freezeDuration, before.freezeDuration)
    stats.freezeMsWindow =
      freezeSeconds === null ? null : Math.round(freezeSeconds * 1000)
    stats.framesDroppedWindow = delta(now.framesDropped, before.framesDropped)
    stats.decodeMsPerFrame = perFrameMs(
      now.decodeTime,
      before.decodeTime,
      inbound.framesDecoded ?? null,
      previous.inboundFrames
    )
  }

  if (outbound && baseline.outboundId === previous.outboundId) {
    const now = baseline.outboundCounters
    const before = previous.outboundCounters
    stats.encodeMsPerFrame = perFrameMs(
      now.encodeTime,
      before.encodeTime,
      outbound.framesEncoded ?? null,
      previous.outboundFrames
    )
    stats.limitationShare = sharePercent(now.limitation, before.limitation)
  }
}

/**
 * 音频窗口统计。
 *
 * 只做三件事：本窗口码率、本窗口丢包率、丢包隐藏占比。三者的分母都用
 * 「同一个窗口」的增量——混用累计与窗口会让比例超过 100%。
 */
function audioStats(
  previous: StatsBaseline | null,
  baseline: StatsBaseline,
  inbound: Record<string, unknown> | undefined,
  outbound: Record<string, unknown> | undefined
): ShareAudioStats | null {
  if (!inbound && !outbound) return null

  const audio: ShareAudioStats = {
    receiving: false,
    sending: false,
    bitrate: null,
    packetLossRate: null,
    jitterMs: null,
    level: null,
    concealmentRate: null,
    jitterBufferMs: null,
  }

  if (inbound) {
    const counters = audioCountersOf(inbound, 'inbound')
    audio.receiving = true
    baseline.audioInId = String(inbound.id ?? '')
    baseline.audioInCounters = counters
    const jitter = numberValue(inbound, 'jitter')
    if (jitter !== null) audio.jitterMs = Math.round(jitter * 1000)
    const level = numberValue(inbound, 'audioLevel')
    if (level !== null) audio.level = Math.max(0, Math.min(1, level))

    // 抖动缓冲平均驻留：累计比值，不需要窗口。
    const emitted = counters.jitterBufferEmitted ?? 0
    if (emitted > 0 && counters.jitterBufferDelay !== null) {
      audio.jitterBufferMs = Math.round(
        (counters.jitterBufferDelay / emitted) * 1000
      )
    }

    if (previous && previous.audioInId === baseline.audioInId) {
      const before = previous.audioInCounters
      const windowMs =
        counters.timestamp !== null && before.timestamp !== null
          ? counters.timestamp - before.timestamp
          : 0
      const bytes = delta(counters.bytes, before.bytes)
      if (windowMs > 0 && bytes !== null) {
        audio.bitrate = (bytes * 8) / (windowMs / 1000)
      }
      const received = delta(counters.packetsReceived, before.packetsReceived)
      const lost = delta(counters.packetsLost, before.packetsLost)
      if (received !== null && lost !== null && received + lost > 0) {
        audio.packetLossRate = lost / (received + lost)
      }
      const samples = delta(
        counters.totalSamplesReceived,
        before.totalSamplesReceived
      )
      const concealed = delta(
        counters.concealedSamples,
        before.concealedSamples
      )
      if (samples !== null && concealed !== null && samples > 0) {
        // 隐藏采样可能包含预取的静音，比例按 min(1) 收口。
        audio.concealmentRate = Math.min(1, concealed / samples)
      }
    }
  }

  if (outbound) {
    const counters = audioCountersOf(outbound, 'outbound')
    audio.sending = true
    baseline.audioOutId = String(outbound.id ?? '')
    baseline.audioOutCounters = counters
    if (previous && previous.audioOutId === baseline.audioOutId) {
      const before = previous.audioOutCounters
      const windowMs =
        counters.timestamp !== null && before.timestamp !== null
          ? counters.timestamp - before.timestamp
          : 0
      const bytes = delta(counters.bytes, before.bytes)
      if (windowMs > 0 && bytes !== null) {
        audio.bitrate = (bytes * 8) / (windowMs / 1000)
      }
    }
  }

  return audio
}
