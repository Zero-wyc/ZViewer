/**
 * 单条观众连接的质量采样。
 *
 * 房主这一侧其实**不需要观众上报**就能知道对方卡不卡：浏览器原生就提供
 * `remote-inbound-rtp`——那是观众用自己的 RTCP 回传的接收报告（丢包、抖动、
 * RTT）。Piik 的 viewer-quality-evidence 之所以要回传，是因为它的观众可能是
 * 多跳中继、父节点看不到孙节点；ZViewer 是单层星形，房主直连每个观众，
 * 这份数据本来就在手里。
 *
 * 所以这里只做一件事：把 outbound-rtp 与 remote-inbound-rtp 的**累计计数器
 * 差分成窗口值**，口径与 `core/stats.ts` 一致（回退/换流一律 null）。
 */
import type { QualityLimitationReason } from './stats'

export interface PeerQuality {
  /** 本窗口丢包率（观众侧反馈），0–1。 */
  packetLossRate: number | null
  /** 观众侧报告的往返时延，毫秒。 */
  rttMs: number | null
  /** 观众侧抖动，毫秒。 */
  jitterMs: number | null
  /** 本窗口编码帧率。 */
  frameRate: number | null
  /** 本窗口发送码率（bps）。 */
  bitrate: number | null
  /** 编码受限原因（浏览器判定，观众卡不一定是网络问题）。 */
  limitation: QualityLimitationReason | null
  /** 累计丢包数，用于「一直没恢复」的判断。 */
  packetsLost: number | null
}

/** 一条观众连接上的展示用快照。 */
export interface PeerQualityView {
  connectionId: string
  connectionState: RTCPeerConnectionState
  quality: PeerQuality
}

export interface PeerQualityBaseline {
  outboundId: string | null
  remoteId: string | null
  bytesSent: number
  framesEncoded: number
  packetsSent: number
  packetsLost: number
  timestamp: number
}

export function emptyPeerQuality(): PeerQuality {
  return {
    packetLossRate: null,
    rttMs: null,
    jitterMs: null,
    frameRate: null,
    bitrate: null,
    limitation: null,
    packetsLost: null,
  }
}

export function emptyPeerQualityBaseline(): PeerQualityBaseline {
  return {
    outboundId: null,
    remoteId: null,
    bytesSent: 0,
    framesEncoded: 0,
    packetsSent: 0,
    packetsLost: 0,
    timestamp: 0,
  }
}

type OutboundRow = RTCOutboundRtpStreamStats & {
  framesEncoded?: number
  qualityLimitationReason?: string
}

type RemoteInboundRow = RTCStats & {
  type: 'remote-inbound-rtp'
  kind?: string
  localId?: string
  packetsLost?: number
  jitter?: number
  roundTripTime?: number
  fractionLost?: number
}

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

/** 计数器差值；回退（浏览器重置、换流）时返回 null，绝不把负数当速率。 */
function delta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null
  if (current < previous) return null
  return current - previous
}

/**
 * 从一份 PC 统计报告里读出这条观众连接的质量。
 *
 * 一次报告里可能有多个 outbound-rtp（视频/音频）：只认 video，且取码流
 * 最大的那条，避免刚建出来的那条（还没发字节）把速率压成 0。
 */
export function samplePeerQuality(
  previous: PeerQualityBaseline | null,
  report: RTCStatsReport
): { quality: PeerQuality; baseline: PeerQualityBaseline } {
  const outboundRows: OutboundRow[] = []
  const remoteRows: RemoteInboundRow[] = []

  report.forEach((value) => {
    const row = value as RTCStats & Record<string, unknown>
    if (row.type === 'outbound-rtp' && row.kind === 'video') {
      outboundRows.push(row as unknown as OutboundRow)
    }
    if (row.type === 'remote-inbound-rtp' && row.kind === 'video') {
      remoteRows.push(row as unknown as RemoteInboundRow)
    }
  })

  const active = outboundRows.filter(
    (row) => (row as { active?: boolean }).active !== false
  )
  const outbound =
    active.length > 1
      ? active.reduce((best, row) =>
          (row.bytesSent ?? 0) > (best.bytesSent ?? 0) ? row : best
        )
      : active[0]
  const remote = outbound
    ? (remoteRows.find((row) => !row.localId || row.localId === outbound.id) ??
      remoteRows[0])
    : remoteRows[0]

  const quality = emptyPeerQuality()
  const baseline = emptyPeerQualityBaseline()

  if (outbound) {
    baseline.outboundId = outbound.id
    baseline.bytesSent = outbound.bytesSent ?? 0
    baseline.framesEncoded = outbound.framesEncoded ?? 0
    baseline.packetsSent = outbound.packetsSent ?? 0
    baseline.timestamp = outbound.timestamp ?? 0
    quality.limitation = limitationReason(outbound.qualityLimitationReason)
  }
  if (remote) {
    baseline.remoteId = remote.id
    baseline.packetsLost = remote.packetsLost ?? 0
    quality.packetsLost = remote.packetsLost ?? null
    if (typeof remote.roundTripTime === 'number' && remote.roundTripTime >= 0) {
      quality.rttMs = Math.round(remote.roundTripTime * 1000)
    }
    if (typeof remote.jitter === 'number' && remote.jitter >= 0) {
      quality.jitterMs = Math.round(remote.jitter * 1000)
    }
  }

  if (!previous || !outbound) {
    return { quality, baseline }
  }

  // 换了一条流（新增/重建观众连接）就不做窗口差分：计数器归零，差值无意义。
  if (
    previous.outboundId !== baseline.outboundId ||
    (previous.remoteId !== null &&
      baseline.remoteId !== null &&
      previous.remoteId !== baseline.remoteId)
  ) {
    return { quality, baseline }
  }

  const windowMs = baseline.timestamp - previous.timestamp
  if (!(windowMs > 0)) return { quality, baseline }
  const seconds = windowMs / 1000

  const bytes = delta(baseline.bytesSent, previous.bytesSent)
  if (bytes !== null) {
    quality.bitrate = (bytes * 8) / seconds
  }
  const frames = delta(baseline.framesEncoded, previous.framesEncoded)
  if (frames !== null) {
    quality.frameRate = frames / seconds
  }

  // 观众侧丢包率：自身回传的累计丢包 ÷ (本窗口发出的包 + 新增丢包)。
  // 分母用「发送数」而不是「接收数」——发送数在本机是准的，接收数要靠对端报。
  const lost = delta(baseline.packetsLost, previous.packetsLost)
  const sent = delta(baseline.packetsSent, previous.packetsSent)
  if (lost !== null && sent !== null && sent + lost > 0) {
    quality.packetLossRate = lost / (sent + lost)
  }

  return { quality, baseline }
}

/**
 * 两份质量是否「看起来一样」。
 *
 * 帧率/码率是浮点，每 2 秒必然小幅变化；用严格相等会让房主页面每 2 秒
 * 重渲染一次（观众越多越明显）。这里给 5% 的容差，只报「看得出变化」。
 */
export function peerQualityEqual(
  left: PeerQuality,
  right: PeerQuality
): boolean {
  const near = (a: number | null, b: number | null): boolean => {
    if (a === null || b === null) return a === b
    return Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.05)
  }
  return (
    near(
      left.packetLossRate === null ? null : left.packetLossRate * 1000,
      right.packetLossRate === null ? null : right.packetLossRate * 1000
    ) &&
    left.rttMs === right.rttMs &&
    left.jitterMs === right.jitterMs &&
    near(left.frameRate, right.frameRate) &&
    near(left.bitrate, right.bitrate) &&
    left.limitation === right.limitation &&
    left.packetsLost === right.packetsLost
  )
}

/**
 * 一位观众的质量等级。
 *
 * 只报**最严重的那一项**：一屏里塞「丢包 3% / RTT 120ms / 40fps」没人读得
 * 下去，房主要的是「谁在卡、卡在哪」。阈值是经验值，改之前先说清楚依据：
 *  - 丢包 > 5%：Opus 还能靠 FEC 撑住，视频已经开始花屏/跳帧；
 *  - RTT > 300ms：屏幕共享的交互感明显变差（但广播场景可以忍）；
 *  - 编码受限带宽/CPU：这不是网络问题，房主该降档位/降分辨率。
 */
export type PeerQualitySeverity =
  'offline' | 'loss' | 'latency' | 'bandwidth' | 'cpu' | 'good'

export function peerQualitySeverity(
  quality: PeerQuality,
  connectionState: RTCPeerConnectionState
): PeerQualitySeverity {
  if (connectionState !== 'connected') return 'offline'
  if (quality.packetLossRate !== null && quality.packetLossRate > 0.05) {
    return 'loss'
  }
  if (quality.rttMs !== null && quality.rttMs > 300) return 'latency'
  if (quality.limitation === 'bandwidth') return 'bandwidth'
  if (quality.limitation === 'cpu') return 'cpu'
  return 'good'
}
