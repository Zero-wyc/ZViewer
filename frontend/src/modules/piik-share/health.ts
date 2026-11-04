/**
 * 房主侧出边的编码健康判定：连续几个窗口编不动就降一档。
 *
 * 判据本身在 `screen-sharing/core/encoder-health`（移植自
 * Piik 的稳态判定）。这里只补 Piik 链路特有的三件事：
 *
 *  1. **逐边计数**。Piik 的路由是树：房主同时往 3～4 个观众推流，每条边
 *     一个 RTCPeerConnection、一份 outbound-rtp。计数必须按 `connectionId`
 *     分开，否则几个观众的快慢会互相抵消，永远凑不出「连续 N 个窗口」。
 *  2. **边消失就清基线**。观众离开、换父之后边会被关掉；留着它的基线，
 *     下一个复用的 connectionId 会拿旧计数器做差，一上来就判成饥饿。
 *  3. **换流不算饥饿**。`replaceTrack` 换源后 `framesEncoded` 归零，这一窗口
 *     没有意义，既不能算不达标，也不该清零已有的计数（那会让降档永远等不到）。
 *
 * 与旧实现的差别只有降档动作：旧链路走 `updateProfile`（重下发采集约束），
 * 这里走 setParameters 的 `scaleResolutionDownBy`——共享屏幕重采集会重新弹
 * 一次画面选择器，观众端也要黑一帧，代价比糊一点高得多。
 */
import {
  ENCODER_STARVED_WINDOWS,
  MAX_AUTO_DOWNGRADES,
  encoderSustainsTarget,
  type EncoderHealthSample,
} from '../screen-sharing/core/encoder-health.ts'
import type { ShareHealthSample } from './endpoint.ts'

export interface ShareHealthMonitorOptions {
  /** 每个共享代际最多自动降几档。到顶后 `observe` 恒返回 false。 */
  maxDowngrades?: number
  /** 连续多少个窗口不达标才降档。测试里调小以免造长序列。 */
  starvedWindows?: number
}

export class ShareHealthMonitor {
  private readonly maxDowngrades: number
  private readonly starvedWindows: number
  private readonly baselines = new Map<string, EncoderHealthSample>()
  private readonly starved = new Map<string, number>()
  private downgrades = 0

  constructor(options: ShareHealthMonitorOptions = {}) {
    this.maxDowngrades = options.maxDowngrades ?? MAX_AUTO_DOWNGRADES
    this.starvedWindows = options.starvedWindows ?? ENCODER_STARVED_WINDOWS
  }

  /** 本代际已经降了几档。 */
  get downgradeCount(): number {
    return this.downgrades
  }

  /** 降档额度用完了吗。 */
  get exhausted(): boolean {
    return this.downgrades >= this.maxDowngrades
  }

  /**
   * 喂一轮采样，返回「现在该降一档」。
   *
   * 一次 `observe` 最多返回一次 true：同时有几条边都在挨饿也只降一档，
   * 因为降档改的是同一个编码器的目标，降两档等于一次跳过两个台阶。
   */
  observe(samples: ShareHealthSample[], targetFrameRate: number): boolean {
    const seen = new Set<string>()
    let starvedEnough = false

    for (const sample of samples) {
      seen.add(sample.connectionId)
      const baseline = this.baselines.get(sample.connectionId)
      this.baselines.set(sample.connectionId, snapshotOf(sample))

      if (!baseline) continue
      if (!comparable(baseline, sample)) {
        // 换流 / 计数器归零：这一窗口没有信息量，保留原计数以便接上。
        continue
      }
      const sustains = encoderSustainsTarget(baseline, sample, targetFrameRate)
      if (sustains === null) continue
      if (sustains) {
        this.starved.delete(sample.connectionId)
        continue
      }
      const windows = (this.starved.get(sample.connectionId) ?? 0) + 1
      this.starved.set(sample.connectionId, windows)
      if (windows >= this.starvedWindows) starvedEnough = true
    }

    // 这一轮没出现的边已经关了：基线与计数一起丢掉。
    for (const connectionId of [...this.baselines.keys()]) {
      if (seen.has(connectionId)) continue
      this.baselines.delete(connectionId)
      this.starved.delete(connectionId)
    }

    if (!starvedEnough || this.exhausted) return false
    this.downgrades += 1
    this.starved.clear()
    return true
  }

  /** 换一档之后重新观察（降档本身会改目标帧率）。 */
  reset(): void {
    this.baselines.clear()
    this.starved.clear()
    this.downgrades = 0
  }
}

function snapshotOf(sample: ShareHealthSample): EncoderHealthSample {
  return {
    outboundId: sample.outboundId,
    sourceId: sample.sourceId,
    timestamp: sample.timestamp,
    framesEncoded: sample.framesEncoded,
    sourceFrames: sample.sourceFrames,
    limitation: sample.limitation,
  }
}

/**
 * 两个采样能不能相减。
 *
 * `encoderSustainsTarget` 对「换了流」返回 false，那会被当成饥饿窗口；
 * 但换源当口帧数归零是正常现象，判成饥饿会让用户刚切完画面就被降一档。
 * 所以先在更外层挡掉，并顺带挡掉时钟没走的情况。
 */
function comparable(
  baseline: EncoderHealthSample,
  current: ShareHealthSample
): boolean {
  if (current.timestamp <= baseline.timestamp) return false
  // 部分浏览器不给 mediaSourceId，null 不作数，有值时才比对。
  if (
    baseline.outboundId !== null &&
    current.outboundId !== null &&
    baseline.outboundId !== current.outboundId
  ) {
    return false
  }
  if (
    baseline.sourceId !== null &&
    current.sourceId !== null &&
    baseline.sourceId !== current.sourceId
  ) {
    return false
  }
  return true
}
