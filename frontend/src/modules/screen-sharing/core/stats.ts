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
 */

/** 视频受限原因。Chrome 只在 outbound-rtp 上给这个字段。 */
export type QualityLimitationReason = 'none' | 'cpu' | 'bandwidth' | 'other'

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
  /** 累计丢包比例（不是窗口比例）。 */
  packetLossRate: number | null
  qualityLimitationReason: QualityLimitationReason | null
  encoderImplementation: string | null
  /** 累计冻结次数（接收侧）。 */
  freezeCount: number | null
  /** 累计冻结时长，毫秒。 */
  totalFreezeMs: number | null
  /** 抖动缓冲的平均驻留时长，毫秒。 */
  jitterBufferMs: number | null
}

/** 统计值来源：inbound-rtp 还是 outbound-rtp。 */
const VIDEO = 'video'

/** 浏览器实现比 TS DOM 声明多出来的字段，用结构化类型补上。 */
type VideoInbound = RTCInboundRtpStreamStats & {
  framesDecoded?: number
  freezeCount?: number
  totalFreezesDuration?: number
  jitterBufferDelay?: number
  jitterBufferEmittedCount?: number
}

type VideoOutbound = RTCOutboundRtpStreamStats & {
  framesEncoded?: number
  qualityLimitationReason?: string
  encoderImplementation?: string
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
    qualityLimitationReason: null,
    encoderImplementation: null,
    freezeCount: null,
    totalFreezeMs: null,
    jitterBufferMs: null,
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
  }
}

/**
 * 挑出唯一一条活跃的视频流。
 *
 * 一个 PC 只承载一路视频，但换源/重协商的瞬间可能短暂出现两条；取码流最大
 * 的那条，避免刚好读到还没出字节的新流而让速率掉成 0。
 */
/** `active` 不在 TS 的 RTP 统计类型里，但 Chrome 会发。 */
function isActive(row: unknown): boolean {
  return (row as { active?: boolean }).active !== false
}

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
        return
      case 'outbound-rtp':
        if (row.kind === VIDEO)
          outboundRows.push(row as unknown as VideoOutbound)
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
    applyRates(previous, stats, baseline, 'outbound')
  }

  if (pair) {
    const rtt = pair.currentRoundTripTime
    if (typeof rtt === 'number' && rtt >= 0) {
      stats.rttMs = Math.round(rtt * 1000)
    }
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
 *  - 计数器回退（浏览器重置）按 0 处理，不能把负数当速率。
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
