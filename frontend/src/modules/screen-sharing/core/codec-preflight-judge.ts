/**
 * 编码探针的判定层：从一份 `getStats` 报告里读出「H.264 满帧编得动吗」。
 *
 * 纯函数、零 DOM 依赖（`RTCStatsReport` 就是个 Map），可以直接在 node 里
 * 构造假报告跑单测。画布与回环 PC 那半边在 `video-codec-preflight.ts`。
 *
 * 照搬 Piik `src/client/webrtc/video-codec-preflight.ts` + `webrtc/stats.ts`
 * 的判定部分（MIT）。**整个判定成立的前提是「源必然满帧」**，三条机制缺一
 * 不可（驱动侧见 `video-codec-preflight.ts`）：
 *
 *  1. 探针源不是屏幕，是一块按目标帧率自己刷的 canvas：每个 tick 全屏换色
 *     并平移一条扫线，没有一个像素是静止的。
 *  2. `captureStream` 的帧率与 `setInterval` 的间隔取自同一个
 *     `profile.maxFramerate`，源在构造上不可能供不上被测的目标。
 *  3. `contentHint = 'motion'`：编码器宁可掉分辨率也要保帧率。
 *
 * 于是这里的 `source > 0 && source + lag >= expected` 恒真，整条判据退化成
 * **纯编码器能力测试**：能满帧编 H.264 就用 H.264，否则整代退 VP8。
 *
 * 这与运行时的 `encoder-health.ts` 恰好相反：那边的源是真实屏幕，静止时
 * 本来就出不了几帧，所以「源不够」必须判正常。两个判据不能互相替代——
 * 这里只回答「这台机器的 H.264 能不能扛住这个档位」，那里回答「现在这份
 * 真实画面编得动吗」。
 */
import type { QualityProfile } from './quality'

/** 探针要按什么尺寸/帧率考编码器（由采集源实测尺寸与档位上限推出）。 */
export interface H264ProbeTarget {
  width: number
  height: number
  frameRate: number
}

/** 一次 `getStats` 采样里与判定相关的字段。 */
export interface H264ProbeSample {
  outboundId: string
  sourceId: string
  timestamp: number
  codec: string
  framesEncoded: number | null
  sourceFrames: number | null
  encodedFramesPerSecond: number | null
  sourceFramesPerSecond: number | null
  qualityLimitationReason: string | null
}

type StatsRecord = RTCStats & Record<string, unknown>

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/**
 * H.264 只吃偶数边长（奇数会被编码器静默裁掉一行/列，宏块也对不齐）。
 *
 * 往小取整而不是四舍五入：`ceiling` 是硬上限，取整后越过上限会让探针考的
 * 尺寸比真实档位还大，结论偏悲观。
 */
function evenDimension(value: number, ceiling: number | null): number {
  const even = Math.max(2, Math.floor(value / 2) * 2)
  return ceiling === null ? even : Math.min(ceiling, even)
}

/**
 * 探针的目标尺寸。
 *
 * 以采集源实测尺寸为基准、按档位上限等比缩到框内，**不做放大**：源比档位
 * 小时按源来考（放大只会烧掉本不属于这个档位的编码时间）。
 */
export function h264ProbeTarget(
  settings: MediaTrackSettings,
  profile: QualityProfile
): H264ProbeTarget {
  const ceiling = profile.resolution
  const sourceWidth = positiveNumber(settings.width, ceiling?.width ?? 1920)
  const sourceHeight = positiveNumber(settings.height, ceiling?.height ?? 1080)
  const scale = ceiling
    ? Math.max(sourceWidth / ceiling.width, sourceHeight / ceiling.height, 1)
    : 1
  return {
    width: evenDimension(sourceWidth / scale, ceiling?.width ?? null),
    height: evenDimension(sourceHeight / scale, ceiling?.height ?? null),
    frameRate: profile.maxFramerate,
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function recordById(report: RTCStatsReport, id: unknown): StatsRecord | null {
  if (typeof id !== 'string') return null
  return (report.get(id) as StatsRecord | undefined) ?? null
}

/**
 * 找到 outbound-rtp 对应的 `media-source`（采集侧出帧数从这里读）。
 *
 * 照 Piik `webrtc/stats.ts:417-440`：优先用 `mediaSourceId` 直连；有些浏览器
 * 省掉这个链接，只有在「一个 sender + 一个同类 source」时才敢推断，多路
 * sender/source 一律判歧义返回 null（宁可判不了，也不认错源）。
 */
function mediaSourceRecord(
  report: RTCStatsReport,
  media: StatsRecord
): StatsRecord | null {
  if (media.type !== 'outbound-rtp' || media.isRemote === true) return null
  if (media.mediaSourceId !== undefined) {
    const source = recordById(report, media.mediaSourceId)
    return source?.type === 'media-source' ? source : null
  }
  if (media.kind !== 'video' && media.kind !== 'audio') return null
  const senders: StatsRecord[] = []
  const sources: StatsRecord[] = []
  report.forEach((raw) => {
    const record = raw as StatsRecord
    if (record.kind !== media.kind) return
    if (record.type === 'outbound-rtp' && record.isRemote !== true) {
      senders.push(record)
    }
    if (record.type === 'media-source') sources.push(record)
  })
  return senders.length === 1 &&
    senders[0]!.id === media.id &&
    sources.length === 1
    ? sources[0]!
    : null
}

/**
 * 从一条 `getStats` 报告里读出一次采样。
 *
 * 探针 PC 上只有一条视频 outbound，所以「候选不唯一」= 报告还没稳定，直接
 * 返回 null 等下一个轮询。**必须校验 codec 真的是 H.264**：探针要证明的是
 * H.264 的能力，浏览器偷偷改用 VP8 时「满帧」毫无意义。
 */
export function readH264ProbeSample(
  report: RTCStatsReport
): H264ProbeSample | null {
  const candidates: StatsRecord[] = []
  report.forEach((raw) => {
    const record = raw as StatsRecord
    if (
      record.type === 'outbound-rtp' &&
      record.kind === 'video' &&
      record.isRemote !== true &&
      finiteNumber(record.framesEncoded) !== null
    ) {
      candidates.push(record)
    }
  })
  if (candidates.length !== 1) return null
  const outbound = candidates[0]!
  const codec = recordById(report, outbound.codecId)
  const source = mediaSourceRecord(report, outbound)
  const mimeType = stringValue(codec?.mimeType)
  if (
    codec?.type !== 'codec' ||
    source?.type !== 'media-source' ||
    mimeType?.toLowerCase() !== 'video/h264'
  ) {
    return null
  }
  return {
    outboundId: outbound.id,
    sourceId: source.id,
    timestamp: finiteNumber(outbound.timestamp) ?? 0,
    codec: mimeType,
    framesEncoded: finiteNumber(outbound.framesEncoded),
    sourceFrames: finiteNumber(source.frames),
    encodedFramesPerSecond: finiteNumber(outbound.framesPerSecond),
    sourceFramesPerSecond: finiteNumber(source.framesPerSecond),
    qualityLimitationReason: stringValue(outbound.qualityLimitationReason),
  }
}

/** 判定窗口的最小长度：低于一秒的采样抖动太大，判不出稳态。 */
export const PREFLIGHT_MEASUREMENT_MS = 1_000

/** 容差：一个轮询周期内应有的帧数，抵消采样时刻的对齐误差。 */
export function allowedFrameLag(
  targetFrameRate: number,
  pollMs: number
): number {
  return Math.max(1, Math.ceil((targetFrameRate * pollMs) / 1_000))
}

/**
 * 这一窗口编码器是否跟得上目标帧率。
 *
 * `null` = 窗口不足，调用方要继续轮询。判死只有三条路：换流（id 变了）、
 * 浏览器明确报 CPU 受限、或者源已满帧而编码增量落后。
 */
export function h264ProbeSustainsTarget(
  baseline: H264ProbeSample,
  current: H264ProbeSample,
  targetFrameRate: number,
  frameLag: number
): boolean | null {
  if (
    baseline.outboundId !== current.outboundId ||
    baseline.sourceId !== current.sourceId ||
    current.timestamp <= baseline.timestamp ||
    current.codec.toLowerCase() !== 'video/h264' ||
    current.qualityLimitationReason === 'cpu'
  ) {
    return false
  }
  const elapsedMs = current.timestamp - baseline.timestamp
  if (elapsedMs < PREFLIGHT_MEASUREMENT_MS) return null
  const expectedFrames = (targetFrameRate * elapsedMs) / 1_000
  if (
    baseline.framesEncoded !== null &&
    current.framesEncoded !== null &&
    baseline.sourceFrames !== null &&
    current.sourceFrames !== null &&
    current.framesEncoded >= baseline.framesEncoded &&
    current.sourceFrames >= baseline.sourceFrames
  ) {
    const encoded = current.framesEncoded - baseline.framesEncoded
    const source = current.sourceFrames - baseline.sourceFrames
    // 源这一侧在探针里必然满帧（见文件头），所以「源不够」只可能是探针自己
    // 出问题——照样判失败，宁可退 VP8 也不要开播后卡成幻灯片。
    return (
      source > 0 &&
      encoded > 0 &&
      source + frameLag >= expectedFrames &&
      encoded + frameLag >= expectedFrames &&
      encoded + frameLag >= source
    )
  }
  // 拿不到累计帧数（部分平台不给 `framesEncoded`）：退回看瞬时帧率。
  if (
    current.encodedFramesPerSecond === null ||
    current.sourceFramesPerSecond === null
  ) {
    return null
  }
  return (
    current.sourceFramesPerSecond > 0 &&
    current.encodedFramesPerSecond > 0 &&
    current.sourceFramesPerSecond + frameLag >= targetFrameRate &&
    current.encodedFramesPerSecond + frameLag >= targetFrameRate &&
    current.encodedFramesPerSecond + frameLag >= current.sourceFramesPerSecond
  )
}

/** 预热是否够了（时间够长且没换流）。 */
export function hasProbeWindow(
  baseline: H264ProbeSample,
  current: H264ProbeSample,
  warmupMs: number
): boolean {
  if (
    baseline.outboundId !== current.outboundId ||
    baseline.sourceId !== current.sourceId ||
    current.timestamp <= baseline.timestamp
  ) {
    return false
  }
  return current.timestamp - baseline.timestamp >= warmupMs
}
