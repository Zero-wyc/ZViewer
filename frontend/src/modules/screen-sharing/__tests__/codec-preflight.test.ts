/**
 * 开播前编码探针的判定层单测。
 *
 * 这套判据的全部前提是「源必然满帧」（合成画布自己刷），所以这里同时锁住
 * 两件事：
 *  - 源满帧、编码跟不上 → 判失败（该退 VP8）；
 *  - 源没满帧 → 也判失败（探针自己出问题时宁可退 VP8，不要开播后卡顿）。
 *
 * 判错方向的后果：误判「编不动」会把一台好机器降成软编 VP8；漏判会让用户
 * 开播后一直卡在 15fps。两个都是用户能直接看到的坏结果。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  allowedFrameLag,
  h264ProbeSustainsTarget,
  h264ProbeTarget,
  hasProbeWindow,
  readH264ProbeSample,
  type H264ProbeSample,
} from '../core/codec-preflight-judge.ts'
import type { QualityProfile } from '../core/quality.ts'

const profile1080p60: QualityProfile = {
  resolution: { width: 1920, height: 1080 },
  maxFramerate: 60,
  maxBitrate: 16_000_000,
  degradationPreference: 'balanced',
  maxAudioBitrate: 128_000,
}

describe('h264ProbeTarget', () => {
  it('4K 源在 1080p 档位下按 1080p 考（等比缩到框内）', () => {
    assert.deepEqual(
      h264ProbeTarget({ width: 3840, height: 2160 }, profile1080p60),
      { width: 1920, height: 1080, frameRate: 60 }
    )
  })

  it('源比档位小就不放大（放大只会烧本不属于这一档的编码时间）', () => {
    assert.deepEqual(
      h264ProbeTarget({ width: 1600, height: 900 }, profile1080p60),
      { width: 1600, height: 900, frameRate: 60 }
    )
  })

  it('非 16:9 的源按最长边贴合，短边等比', () => {
    // 3440×1440 贴 1920 宽 → 高 803.7 → 往小取偶数 802，不被上限截断。
    assert.deepEqual(
      h264ProbeTarget({ width: 3440, height: 1440 }, profile1080p60),
      { width: 1920, height: 802, frameRate: 60 }
    )
  })

  it('native 档位（resolution 为 null）按源尺寸取偶数，不设上限', () => {
    const native: QualityProfile = { ...profile1080p60, resolution: null }
    assert.deepEqual(h264ProbeTarget({ width: 1921, height: 1081 }, native), {
      width: 1920,
      height: 1080,
      frameRate: 60,
    })
  })

  it('拿不到源尺寸时按档位兜底', () => {
    assert.deepEqual(h264ProbeTarget({}, profile1080p60), {
      width: 1920,
      height: 1080,
      frameRate: 60,
    })
  })

  it('帧率严格取档位目标（源与目标必须是同一个数）', () => {
    const profile = { ...profile1080p60, maxFramerate: 30 }
    assert.equal(
      h264ProbeTarget({ width: 1920, height: 1080 }, profile).frameRate,
      30
    )
  })
})

function sample(overrides: Partial<H264ProbeSample> = {}): H264ProbeSample {
  return {
    outboundId: 'OUT-1',
    sourceId: 'SRC-1',
    timestamp: 0,
    codec: 'video/H264',
    framesEncoded: 0,
    sourceFrames: 0,
    encodedFramesPerSecond: null,
    sourceFramesPerSecond: null,
    qualityLimitationReason: 'none',
    ...overrides,
  }
}

// 30fps + 100ms 轮询 → 容差 3 帧。
const LAG_30 = allowedFrameLag(30, 100)

describe('allowedFrameLag', () => {
  it('是「一个轮询周期内应有的帧数」，至少 1 帧', () => {
    assert.equal(allowedFrameLag(30, 100), 3)
    assert.equal(allowedFrameLag(60, 100), 6)
    assert.equal(allowedFrameLag(5, 100), 1)
  })
})

describe('h264ProbeSustainsTarget', () => {
  it('源满帧 + 编码满帧 → true（H.264 可用）', () => {
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({ timestamp: 2_000, framesEncoded: 60, sourceFrames: 60 }),
        30,
        LAG_30
      ),
      true
    )
  })

  it('源满帧、编码掉一半 → false（这才是探针要抓的软编）', () => {
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({ timestamp: 2_000, framesEncoded: 30, sourceFrames: 60 }),
        30,
        LAG_30
      ),
      false
    )
  })

  it('源自己没满帧 → 也判 false（探针失效不等于编码器可用）', () => {
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({ timestamp: 2_000, framesEncoded: 10, sourceFrames: 10 }),
        30,
        LAG_30
      ),
      false
    )
  })

  it('编码比源慢（编码落后于采集）→ false，哪怕两者都「不少」', () => {
    // 2 秒里源出 54 帧、编码只出 45 帧：编码确实丢帧了。
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({ timestamp: 2_000, framesEncoded: 45, sourceFrames: 54 }),
        30,
        LAG_30
      ),
      false
    )
  })

  it('浏览器明确报 CPU 受限 → 直接 false，不等帧数', () => {
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({
          timestamp: 2_000,
          framesEncoded: 60,
          sourceFrames: 60,
          qualityLimitationReason: 'cpu',
        }),
        30,
        LAG_30
      ),
      false
    )
  })

  it('窗口不足一秒 → null（判不了，调用方继续轮询）', () => {
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({ timestamp: 900, framesEncoded: 30, sourceFrames: 30 }),
        30,
        LAG_30
      ),
      null
    )
  })

  it('换了 outbound 或 source（重建/换流）→ false', () => {
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({ outboundId: 'OUT-2', timestamp: 2_000, framesEncoded: 60 }),
        30,
        LAG_30
      ),
      false
    )
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({ sourceId: 'SRC-2', timestamp: 2_000, framesEncoded: 60 }),
        30,
        LAG_30
      ),
      false
    )
  })

  it('浏览器偷偷换成 VP8 → false（满帧的是 VP8，证明不了 H.264）', () => {
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0 }),
        sample({
          timestamp: 2_000,
          codec: 'video/VP8',
          framesEncoded: 60,
          sourceFrames: 60,
        }),
        30,
        LAG_30
      ),
      false
    )
  })

  it('拿不到累计帧数时退回看瞬时帧率', () => {
    const noCounters = {
      framesEncoded: null,
      sourceFrames: null,
    }
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0, ...noCounters }),
        sample({
          timestamp: 2_000,
          ...noCounters,
          encodedFramesPerSecond: 30,
          sourceFramesPerSecond: 30,
        }),
        30,
        LAG_30
      ),
      true
    )
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0, ...noCounters }),
        sample({
          timestamp: 2_000,
          ...noCounters,
          encodedFramesPerSecond: 12,
          sourceFramesPerSecond: 30,
        }),
        30,
        LAG_30
      ),
      false
    )
  })

  it('两者都拿不到 → null，不要拿「不知道」当结论', () => {
    const noCounters = { framesEncoded: null, sourceFrames: null }
    assert.equal(
      h264ProbeSustainsTarget(
        sample({ timestamp: 0, ...noCounters }),
        sample({ timestamp: 2_000, ...noCounters }),
        30,
        LAG_30
      ),
      null
    )
  })
})

describe('hasProbeWindow', () => {
  it('预热窗口不足 → false（建连抖动不能当稳态）', () => {
    assert.equal(
      hasProbeWindow(sample({ timestamp: 0 }), sample({ timestamp: 300 }), 500),
      false
    )
  })

  it('够长且没换流 → true', () => {
    assert.equal(
      hasProbeWindow(sample({ timestamp: 0 }), sample({ timestamp: 600 }), 500),
      true
    )
  })

  it('换流 → false，就算时间够长也没意义', () => {
    assert.equal(
      hasProbeWindow(
        sample({ timestamp: 0 }),
        sample({ timestamp: 600, sourceId: 'SRC-2' }),
        500
      ),
      false
    )
  })
})

/** 造一份最小可用的假 `getStats` 报告。 */
function fakeReport(records: Array<Record<string, unknown>>): RTCStatsReport {
  const map = new Map<string, unknown>()
  for (const record of records) map.set(String(record.id), record)
  return map as unknown as RTCStatsReport
}

describe('readH264ProbeSample', () => {
  const base = [
    {
      id: 'OUT',
      type: 'outbound-rtp',
      kind: 'video',
      timestamp: 1_000,
      codecId: 'CODEC',
      mediaSourceId: 'SRC',
      framesEncoded: 120,
      framesPerSecond: 59.8,
      qualityLimitationReason: 'none',
    },
    { id: 'CODEC', type: 'codec', mimeType: 'video/H264' },
    { id: 'SRC', type: 'media-source', kind: 'video', frames: 121 },
  ]

  it('读全字段', () => {
    assert.deepEqual(readH264ProbeSample(fakeReport(base)), {
      outboundId: 'OUT',
      sourceId: 'SRC',
      timestamp: 1_000,
      codec: 'video/H264',
      framesEncoded: 120,
      sourceFrames: 121,
      encodedFramesPerSecond: 59.8,
      sourceFramesPerSecond: null,
      qualityLimitationReason: 'none',
    })
  })

  it('codec 不是 H.264 → null（只认它考的编码）', () => {
    const report = fakeReport(
      base.map((item) =>
        item.id === 'CODEC' ? { ...item, mimeType: 'video/VP8' } : item
      )
    )
    assert.equal(readH264ProbeSample(report), null)
  })

  it('缺 media-source → null（没有源侧帧数就不判）', () => {
    assert.equal(
      readH264ProbeSample(fakeReport(base.filter((item) => item.id !== 'SRC'))),
      null
    )
  })

  it('两条视频 outbound → null（报告还没稳定，等下一个轮询）', () => {
    const report = fakeReport([...base, { ...base[0]!, id: 'OUT-2' }])
    assert.equal(readH264ProbeSample(report), null)
  })

  it('没有 mediaSourceId 时，只有在唯一 sender + 唯一 source 下才推断', () => {
    const withoutLink = base.map((item) => {
      const copy: Record<string, unknown> = { ...item }
      delete copy.mediaSourceId
      return copy
    })
    const sampleRead = readH264ProbeSample(fakeReport(withoutLink))
    assert.equal(sampleRead?.sourceId, 'SRC')

    const ambiguous = readH264ProbeSample(
      fakeReport([
        ...withoutLink,
        { id: 'SRC-2', type: 'media-source', kind: 'video' },
      ])
    )
    assert.equal(ambiguous, null)
  })
})
