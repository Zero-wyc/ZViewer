/**
 * 多连接（边）统计的汇总。
 *
 * Piik 链路没有「唯一一条 PC」：房主对每位观众各开一条出边，观众之间互助时
 * 一个人还可能同时有入边和出边。面板要给的是**这次共享**的整体状况，所以
 * 先把每条边的 `ShareStats` 汇总成一份，再照旧渲染。
 *
 * 汇总不是简单求和：
 *  - 码率求和（每条边都真占一份上行带宽），但中继节点优先看入边，否则同一
 *    路流在入边和出边上会被算两遍；
 *  - 帧率/丢包取**最差的一条**——面板回答的是「现在卡不卡」，某位观众掉帧
 *    就该显示掉帧，平均值会把问题抹平；
 *  - 受限原因取最严重的一档（CPU 优先），处置方式不由平均值决定。
 */
import type { PeerQuality } from './peer-quality.ts'
import {
  emptyShareStats,
  type QualityLimitationDurations,
  type QualityLimitationReason,
  type ShareStats,
} from './stats.ts'

/** 一条连接的采样结果：房主一条边一位观众，观众一条边一个上游。 */
export interface ShareEdgeStats {
  connectionId: string
  direction: 'inbound' | 'outbound'
  state: RTCPeerConnectionState
  stats: ShareStats
  /**
   * 观众侧回传的质量（`remote-inbound-rtp`），只有房主的出边有。
   * 丢包、RTT、抖动这些数在出边上本来就看不到，得靠对方回传。
   */
  quality?: PeerQuality
}

export interface AggregateShareStats extends ShareStats {
  /** 参与汇总的边数（房主是观众数，观众通常是 1）。 */
  edgeCount: number
  /** 已连上的边数。 */
  connectedCount: number
  /** 汇总后的连接状态：有一条不通就报不通。 */
  connectionState: RTCPeerConnectionState
}

/** 受限原因的严重程度：CPU 最需要处置，`none` 是无事发生。 */
const LIMITATION_RANK: Record<QualityLimitationReason, number> = {
  none: 0,
  other: 1,
  bandwidth: 2,
  cpu: 3,
}

/**
 * 连接状态的严重程度。
 *
 * `failed` 排最前：一位观众断了不该被其余正常连接掩盖。`disconnected` 是
 * 可恢复的抖动，但面板也得如实说「现在不通」。
 */
const STATE_RANK: Record<RTCPeerConnectionState, number> = {
  failed: 6,
  disconnected: 5,
  closed: 4,
  connecting: 3,
  new: 2,
  connected: 1,
}

/** 找最差的一条连接状态；空列表交给调用方当成「还没连」。 */
export function worstState(
  states: RTCPeerConnectionState[]
): RTCPeerConnectionState {
  if (states.length === 0) return 'new'
  let worst: RTCPeerConnectionState = 'connected'
  for (const state of states) {
    if (STATE_RANK[state] > STATE_RANK[worst]) worst = state
  }
  return worst
}

function maxOf(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null)
  return numbers.length === 0 ? null : Math.max(...numbers)
}

function minOf(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null)
  return numbers.length === 0 ? null : Math.min(...numbers)
}

function sumOf(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null)
  return numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0)
}

/** 各受限原因的时间占比：先把秒数加起来，再归一化成百分比。 */
function aggregateLimitationShare(
  shares: Array<QualityLimitationDurations | null>
): QualityLimitationDurations | null {
  const present = shares.filter(
    (share): share is QualityLimitationDurations => share !== null
  )
  if (present.length === 0) return null
  const total: QualityLimitationDurations = {
    none: 0,
    bandwidth: 0,
    cpu: 0,
    other: 0,
  }
  for (const share of present) {
    total.none += share.none
    total.bandwidth += share.bandwidth
    total.cpu += share.cpu
    total.other += share.other
  }
  const seconds = total.none + total.bandwidth + total.cpu + total.other
  if (seconds <= 0) return null
  return {
    none: (total.none / seconds) * 100,
    bandwidth: (total.bandwidth / seconds) * 100,
    cpu: (total.cpu / seconds) * 100,
    other: (total.other / seconds) * 100,
  }
}

export function aggregateEdgeStats(
  edges: ShareEdgeStats[]
): AggregateShareStats {
  const empty = emptyShareStats()
  const result: AggregateShareStats = {
    ...empty,
    edgeCount: edges.length,
    connectedCount: edges.filter((edge) => edge.state === 'connected').length,
    connectionState: worstState(edges.map((edge) => edge.state)),
  }
  if (edges.length === 0) return result

  const views = edges.map((edge) => edge.stats)
  // 中继节点既有入边也有出边，同一路流会被算两遍：优先报入边（他真正在看的）。
  const outbound = edges.filter((edge) => edge.direction === 'outbound')
  const inbound = edges.filter((edge) => edge.direction === 'inbound')
  const rateSource = inbound.length > 0 ? inbound : outbound

  result.receiving = views.some((view) => view.receiving)
  result.sending = views.some((view) => view.sending)
  result.bitrate = sumOf(rateSource.map((edge) => edge.stats.bitrate))
  result.frameRate = minOf(views.map((view) => view.frameRate))
  result.resolution = views.reduce<ShareStats['resolution']>((best, view) => {
    if (!view.resolution) return best
    if (!best) return view.resolution
    const area = view.resolution.width * view.resolution.height
    return area > best.width * best.height ? view.resolution : best
  }, null)
  result.codec = views.find((view) => view.codec !== null)?.codec ?? null

  result.rttMs = maxOf(views.map((view) => view.rttMs))
  result.jitterMs = maxOf(views.map((view) => view.jitterMs))
  result.jitterBufferMs = maxOf(views.map((view) => view.jitterBufferMs))

  result.packetsReceived = sumOf(views.map((view) => view.packetsReceived))
  result.packetsSent = sumOf(views.map((view) => view.packetsSent))
  result.packetsLost = sumOf(views.map((view) => view.packetsLost))
  // 累计丢包率按「总丢包 / 总发包」重算，比逐边取平均更接近真实；窗口丢包率
  // 没有原始包数可加权，取最差的一条（面板说的是「现在卡不卡」）。
  const received = result.packetsReceived ?? 0
  const lost = result.packetsLost
  result.packetLossRate =
    lost !== null && lost + received > 0 ? lost / (lost + received) : null
  result.windowPacketLossRate = maxOf(
    views.map((view) => view.windowPacketLossRate)
  )

  result.qualityLimitationReason = views
    .map((view) => view.qualityLimitationReason)
    .reduce<QualityLimitationReason | null>((worst, reason) => {
      if (!reason) return worst
      if (!worst) return reason
      return LIMITATION_RANK[reason] > LIMITATION_RANK[worst] ? reason : worst
    }, null)
  result.limitationShare = aggregateLimitationShare(
    views.map((view) => view.limitationShare)
  )
  result.encoderImplementation =
    views.find((view) => view.encoderImplementation !== null)
      ?.encoderImplementation ?? null

  result.freezeCount = sumOf(views.map((view) => view.freezeCount))
  result.totalFreezeMs = sumOf(views.map((view) => view.totalFreezeMs))
  result.freezeCountWindow = sumOf(views.map((view) => view.freezeCountWindow))
  result.freezeMsWindow = sumOf(views.map((view) => view.freezeMsWindow))
  result.framesDroppedWindow = sumOf(
    views.map((view) => view.framesDroppedWindow)
  )
  // 编码/解码耗时是「单帧成本」，多条边各编一次就取最慢的那条。
  result.encodeMsPerFrame = maxOf(views.map((view) => view.encodeMsPerFrame))
  result.decodeMsPerFrame = maxOf(views.map((view) => view.decodeMsPerFrame))

  // 音频在每条边上都是同一路混音，取一条就够了——相加会得出「音量翻倍」的假象。
  result.audio = views.find((view) => view.audio !== null)?.audio ?? null

  // 出边看不到入向丢包与抖动（发送端没有 inbound-rtp），退回观众回传的那份：
  // 房主判断「观众卡不卡」靠的就是它。
  const peerQualities = edges
    .map((edge) => edge.quality ?? null)
    .filter((quality): quality is PeerQuality => quality !== null)
  if (result.windowPacketLossRate === null)
    result.windowPacketLossRate = maxOf(
      peerQualities.map((quality) => quality.packetLossRate)
    )
  if (result.rttMs === null)
    result.rttMs = maxOf(peerQualities.map((quality) => quality.rttMs))
  if (result.jitterMs === null)
    result.jitterMs = maxOf(peerQualities.map((quality) => quality.jitterMs))

  return result
}
