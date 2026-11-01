/**
 * 编码器是否跟得上目标帧率——运行时判定 + 自动降档。
 *
 * **与 Piik `webrtc/video-codec-preflight.ts` 的关系**：判据照搬（编码增量
 * 追不上采集增量 / 目标帧率，或 `qualityLimitationReason === 'cpu'` 直接判死），
 * 但**不做启动前的合成探针**。原因有三条，都是 ZViewer 的实际情况决定的：
 *
 *  1. 合成画布（testsrc 式渐变）和真实屏幕内容的编码开销差得很远：一块静态
 *     桌面 4K 可能只要 3ms/帧，一屏滚动的代码编辑器要 20ms/帧。用合成画面
 *     测出来的结论，对真实内容没有参考价值。
 *  2. 它要额外 4 秒启动时间 + 一条回环 PC，而我们已经每 2 秒在真实流上采
 *     `framesEncoded`——现成的数据，零额外开销。
 *  3. 判据里的关键量（采集帧数 `media-source.frames`）在真实流上同样拿得到，
 *     探针并没有提供额外信息。
 *
 * 所以这里做的是「开局后头几个采样窗口实测 + 不够就降一档」，等价于预检的
 * 目的（不让用户停在"编不动"的状态），但代价是 0 秒启动延迟。
 *
 * 为什么不换 codec：直连首选 H.264、中继强制 VP8，换 codec 要重协商（每个
 * 观众一次），而**降一档**在绝大多数机器上就够用了（编码耗时和像素数近似
 * 线性）。只有降到 720p30 仍然追不上，才说明这台机器根本不适合共享。
 */
import type { QualityProfile } from './quality'
import type { QualityLimitationReason } from './stats'

/** 判定的最小窗口：低于一秒的采样抖动太大，判不出稳态。 */
export const ENCODER_HEALTH_WINDOW_MS = 1_000

/** 连续多少个窗口不达标才降档（2 个 ≈ 4 秒，压住开局的编码器预热抖动）。 */
export const ENCODER_STARVED_WINDOWS = 2

/** 每个代际最多自动降几档（防止一路降到 720p15）。 */
export const MAX_AUTO_DOWNGRADES = 1

export interface EncoderHealthSample {
  /** 换流会让计数器归零，必须先比对 id。 */
  outboundId: string | null
  sourceId: string | null
  timestamp: number
  framesEncoded: number | null
  /** 采集侧实际出帧数（`media-source.frames`）；屏幕采集拿不到时为 null。 */
  sourceFrames: number | null
  limitation: QualityLimitationReason | null
}

/**
 * 这一窗口内编码器是否跟得上 `targetFrameRate`。
 *
 * 返回 `null` 表示「还判不了」（窗口不足或数据缺失），调用方应当**不计数**——
 * 把「不知道」当成「不达标」会让一些设备在开播 2 秒内就被降档。
 */
export function encoderSustainsTarget(
  baseline: EncoderHealthSample,
  current: EncoderHealthSample,
  targetFrameRate: number
): boolean | null {
  // 换流/换源：计数器归零，这一窗口没有意义。
  if (
    baseline.outboundId !== current.outboundId ||
    (baseline.sourceId !== null &&
      current.sourceId !== null &&
      baseline.sourceId !== current.sourceId) ||
    current.timestamp <= baseline.timestamp
  ) {
    return false
  }
  // CPU 受限是硬证据：此时浏览器已经明确说「编不动了」，不必等帧数。
  if (current.limitation === 'cpu') return false

  const elapsedMs = current.timestamp - baseline.timestamp
  if (elapsedMs < ENCODER_HEALTH_WINDOW_MS) return null

  const expectedFrames = (targetFrameRate * elapsedMs) / 1000
  // 容差 ≈ 一个轮询周期内应有的帧数，抵消采样时刻的对齐误差（Piik 同口径）。
  const slack = Math.max(
    1,
    Math.ceil((targetFrameRate * elapsedMs) / 1000 / 10)
  )

  const encoded =
    baseline.framesEncoded !== null && current.framesEncoded !== null
      ? current.framesEncoded - baseline.framesEncoded
      : null
  if (encoded === null || encoded < 0) return null

  const source =
    baseline.sourceFrames !== null && current.sourceFrames !== null
      ? current.sourceFrames - baseline.sourceFrames
      : null

  // **与 Piik 的一处不同**：它的探针是一块持续变化的合成画布，源必然满帧，
  // 所以「源不够」等价于失败。这里采的是真实屏幕——画面静止时采集器本来就
  // 只出很少的帧（一帧不动就没有新帧），那是正常现象，不能因此降档。
  if (source !== null && source >= 0) {
    if (source + slack < expectedFrames * 0.9) return true
    return (
      encoded + slack >= expectedFrames * 0.9 && encoded + slack >= source * 0.9
    )
  }

  // 拿不到采集帧数（部分平台没有 media-source）：只能比目标帧率。
  return encoded + slack >= expectedFrames * 0.9
}

/** 分辨率阶梯（宽高，降序）。`null`（native）当作最高档。 */
const RESOLUTION_LADDER: Array<{ width: number; height: number }> = [
  { width: 3840, height: 2160 },
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
]

/**
 * 下一档更省 CPU 的档位；已经到底返回 `null`。
 *
 * 决策顺序：**先降帧率、再降分辨率**。同样的省电幅度下，帧率对观感的伤害
 * 小于糊掉的字（办公投屏最看重的是文字清晰），而且降帧率对码率也更省。
 */
export function nextLowerProfile(
  profile: QualityProfile
): QualityProfile | null {
  // 60/45 → 30：一步到位，45 这个中间档省不了多少还多一次重配。
  if (profile.maxFramerate > 30) {
    return {
      ...profile,
      maxFramerate: 30,
      maxBitrate: Math.min(profile.maxBitrate, 8_000_000),
    }
  }

  const current = profile.resolution
  const lower = current
    ? (RESOLUTION_LADDER.find((item) => item.width < current.width) ?? null)
    : (RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1] ?? null)
  if (!lower) return null
  return {
    ...profile,
    resolution: lower,
    // 分辨率砍一半，码率同步降下来；给 2Mbps 的下限，别把 720p 压成马赛克。
    maxBitrate: Math.max(2_000_000, Math.round(profile.maxBitrate * 0.6)),
  }
}
