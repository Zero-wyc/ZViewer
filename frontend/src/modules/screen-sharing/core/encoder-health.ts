/**
 * 编码器是否跟得上目标帧率——运行时判定 + 自动降档。
 *
 * **与启动前预检的分工**：`video-codec-preflight.ts` 已经照搬了 Piik 的合成
 * 探针（一块必然满帧的画布 + 回环 PC），但它只在开播时回答一个问题——**这
 * 台机器的 H.264 能不能扛住这个档位**，答案只用来选 codec，不用来降档。
 * 降档必须看真实画面，原因有三条：
 *
 *  1. 合成画布（testsrc 式渐变）和真实屏幕内容的编码开销差得很远：一块静态
 *     桌面 4K 可能只要 3ms/帧，一屏滚动的代码编辑器要 20ms/帧。探针的「哇
 *     满帧」对真实内容没有保证。
 *  2. 探针是一次性的：开播后窗口大小、内容、系统负载都在变，只有每 2 秒在
 *     真实流上采 `framesEncoded` 才看得见这种漂移。
 *  3. 判据里的关键量（采集帧数 `media-source.frames`）在真实流上同样拿得到，
 *     探针并没有提供额外信息。
 *
 * 所以这里做的是「开局后头几个采样窗口实测 + 不够就降一档」，与预检形成
 * 「选编码 / 调档位」两层，代价是 0 秒启动延迟。
 *
 * 为什么不换 codec：编码在开播时就定过了（直连按探针结论、中继强制 VP8），
 * 运行期换 codec 要重协商（每个观众一次），而**降一档**在绝大多数机器上就够
 * 用了（编码耗时和像素数近似线性）。只有降到 720p30 仍然追不上，才说明这台
 * 机器根本不适合共享。
 */
import type { QualityProfile } from './quality'
import type { QualityLimitationReason } from './stats'

/** 判定的最小窗口：低于一秒的采样抖动太大，判不出稳态。 */
export const ENCODER_HEALTH_WINDOW_MS = 1_000

/** 连续多少个窗口不达标才降档（2 个 ≈ 4 秒，压住开局的编码器预热抖动）。 */
export const ENCODER_STARVED_WINDOWS = 2

/** 每个代际最多因**编码器**证据自动降几档（防止一路降到 720p15）。 */
export const MAX_AUTO_DOWNGRADES = 1

/**
 * 每个代际最多因**观众证据**自动降几档。
 *
 * 观众说卡和编码器说编不动是两回事：前者多半是上行带宽不够（编码器一点不
 * 累），后者是本机 CPU。所以两者各有一份预算，但**合计封顶**在
 * `MAX_TOTAL_AUTO_DOWNGRADES`：两条证据在同一次抖动里各降一档，会把 4K60
 * 一口气掉到 1080p30，用户完全不知道发生了什么。
 */
export const MAX_VIEWER_DOWNGRADES = 1

/** 两条证据链合计最多自动降几档。 */
export const MAX_TOTAL_AUTO_DOWNGRADES = 2

/**
 * 观众压力降档的最小间隔。
 *
 * 服务端已经按 20 秒节流下发，这里是第二道闸：一次降档要重配采集约束并逐个
 * 通知发布端（每条观众一次重协商），不能连着重来。
 */
export const VIEWER_DOWNGRADE_COOLDOWN_MS = 20_000

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
