/**
 * 观众侧质量证据：把一次 `getStats` 窗口翻译成线上的 `share.quality`。
 *
 * 这一层**只做搬运和夹值**，不做判定——判据在服务端（`backend-go/internal/
 * share/quality.go`），因为它要用「房主这一代设的目标帧率」做参照，而观众
 * 手里没有这个值。与 Piik 的分工一致：`viewer-quality-evidence.ts` 只负责把
 * 接收侧计数整理成窗口，判「这条边行不行」是 `route/quality.go` 的事。
 *
 * 数据本身是现成的：`core/stats.ts` 已经为了统计面板把 `inbound-rtp` 差分成
 * 窗口值，这里不再单独采一遍 `getStats`。
 */
import type { ShareQualityWindow } from '../protocol/types'
import type { ShareStats } from './stats'

/** 上报间隔。与服务端的「连续两个窗口」判定配套：4 秒内确认一次持续变差。 */
export const QUALITY_EVIDENCE_INTERVAL_MS = 2_000

/**
 * 服务端接受的窗口范围（`share/quality.go` 的 QualityMin/MaxWindowMs）。
 *
 * 超出范围会被整条拒掉——所以宁可报一个夹过的值，也不要报一个必然被扔的。
 */
const MIN_WINDOW_MS = 1_000
const MAX_WINDOW_MS = 5_000

/**
 * 这一窗值得上报吗？
 *
 * 三种情况返回 `null`（**不是**错误，就是没什么可说的）：
 *  - 没在收画面（`inbound-rtp` 还没出现，或刚换连接）；
 *  - 窗口时长不合法（服务端会拒）；
 *  - 一个可判定指标都没有（浏览器这几项全缺，报上去只会被判 unknown）。
 */
export function viewerQualityWindowFromStats(
  stats: ShareStats,
  windowMs: number
): ShareQualityWindow | null {
  if (!stats.receiving) return null
  if (!Number.isFinite(windowMs)) return null
  const window = Math.round(windowMs)
  if (window < MIN_WINDOW_MS || window > MAX_WINDOW_MS) return null

  const evidence: ShareQualityWindow = { windowMs: window }
  const fps = positive(stats.frameRate)
  if (fps !== null) evidence.framesPerSecond = round(fps, 1)
  const dropped = nonNegative(stats.framesDroppedWindow)
  if (dropped !== null) evidence.framesDropped = round(dropped, 0)
  const freezeCount = nonNegative(stats.freezeCountWindow)
  if (freezeCount !== null) evidence.freezeCount = Math.round(freezeCount)
  const freezeMs = nonNegative(stats.freezeMsWindow)
  if (freezeMs !== null) evidence.freezeDurationMs = round(freezeMs, 0)
  const loss = nonNegative(stats.windowPacketLossRate)
  if (loss !== null) evidence.packetLossRate = round(Math.min(1, loss), 4)
  const rtt = nonNegative(stats.rttMs)
  if (rtt !== null) evidence.rttMs = round(rtt, 0)
  const jitter = nonNegative(stats.jitterMs)
  if (jitter !== null) evidence.jitterMs = round(jitter, 0)
  const decode = nonNegative(stats.decodeMsPerFrame)
  if (decode !== null) evidence.decodeMsPerFrame = round(decode, 2)
  const bitrate = positive(stats.bitrate)
  if (bitrate !== null) evidence.bitrateKbps = Math.round(bitrate / 1000)
  if (stats.resolution) {
    evidence.width = stats.resolution.width
    evidence.height = stats.resolution.height
  }
  if (stats.codec) evidence.codec = stats.codec

  // 只有 windowMs 的窗口对判据毫无用处：服务端会判 unknown，不如不发。
  const judged =
    evidence.freezeCount !== undefined ||
    evidence.framesPerSecond !== undefined ||
    evidence.packetLossRate !== undefined
  return judged ? evidence : null
}

function nonNegative(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null
  return value
}

function positive(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null
  return value
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
