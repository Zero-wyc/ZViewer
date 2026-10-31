import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  emptyBaseline,
  sampleShareStats,
  type StatsBaseline,
} from '../core/stats.ts'

/** 造一份统计报告。`RTCStatsReport` 本来就是 Map，测试里直接构造即可。 */
function reportOf(...rows: Array<Record<string, unknown>>): RTCStatsReport {
  const map = new Map<string, unknown>()
  for (const row of rows) map.set(String(row.id), row)
  return map as unknown as RTCStatsReport
}

/** 一条活跃的视频接收流。 */
function inbound(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'IN-1',
    type: 'inbound-rtp',
    kind: 'video',
    active: true,
    timestamp: 2_000,
    bytesReceived: 0,
    framesDecoded: 0,
    frameWidth: 1920,
    frameHeight: 1080,
    packetsReceived: 0,
    packetsLost: 0,
    jitter: 0.004,
    codecId: 'CODEC-1',
    ...overrides,
  }
}

/** 一条活跃的视频发送流。 */
function outbound(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'OUT-1',
    type: 'outbound-rtp',
    kind: 'video',
    active: true,
    timestamp: 2_000,
    bytesSent: 0,
    framesEncoded: 0,
    frameWidth: 1280,
    frameHeight: 720,
    packetsSent: 0,
    codecId: 'CODEC-2',
    ...overrides,
  }
}

const VP8 = { id: 'CODEC-1', type: 'codec', mimeType: 'video/VP8' }
const H264 = { id: 'CODEC-2', type: 'codec', mimeType: 'video/H264' }

describe('sampleShareStats', () => {
  it('空报告：既不收也不发，所有值都是 null', () => {
    const { stats, baseline } = sampleShareStats(null, reportOf())
    assert.equal(stats.receiving, false)
    assert.equal(stats.sending, false)
    assert.equal(stats.frameRate, null)
    assert.equal(stats.bitrate, null)
    assert.equal(stats.resolution, null)
    assert.deepEqual(baseline, emptyBaseline())
  })

  it('首次采样只建立基线：状态字段可用，速率留空', () => {
    const { stats, baseline } = sampleShareStats(null, reportOf(inbound(), VP8))
    assert.equal(stats.receiving, true)
    assert.deepEqual(stats.resolution, { width: 1920, height: 1080 })
    assert.equal(stats.codec, 'VP8')
    // 没有可比对象，速率必然是 null（不是漏算）。
    assert.equal(stats.frameRate, null)
    assert.equal(stats.bitrate, null)
    assert.equal(baseline.inboundId, 'IN-1')
    assert.equal(baseline.inboundTimestamp, 2_000)
  })

  it('第二次采样：帧率与码率按窗口做差', () => {
    const baseline: StatsBaseline = {
      ...emptyBaseline(),
      inboundId: 'IN-1',
      inboundBytes: 1_000,
      inboundFrames: 10,
      inboundTimestamp: 2_000,
    }
    const { stats } = sampleShareStats(
      baseline,
      // 2 秒窗口：多收了 500KB、多解了 60 帧
      reportOf(
        inbound({
          timestamp: 4_000,
          bytesReceived: 1_000 + 500_000,
          framesDecoded: 70,
        }),
        VP8
      )
    )
    assert.equal(stats.bitrate, (500_000 * 8) / 2)
    assert.equal(stats.frameRate, 30)
  })

  it('流 id 变了（换源/重协商）：速率留空，不能拿新旧计数器做差', () => {
    const baseline: StatsBaseline = {
      ...emptyBaseline(),
      inboundId: 'IN-OLD',
      inboundBytes: 9_000_000,
      inboundFrames: 9_000,
      inboundTimestamp: 2_000,
    }
    const { stats } = sampleShareStats(
      baseline,
      reportOf(inbound({ bytesReceived: 10, framesDecoded: 1 }), VP8)
    )
    assert.equal(stats.bitrate, null)
    assert.equal(stats.frameRate, null)
  })

  it('时间戳不前移：没有窗口，速率留空', () => {
    const baseline: StatsBaseline = {
      ...emptyBaseline(),
      inboundId: 'IN-1',
      inboundBytes: 1_000,
      inboundFrames: 10,
      inboundTimestamp: 2_000,
    }
    for (const timestamp of [2_000, 1_500]) {
      const { stats } = sampleShareStats(
        baseline,
        reportOf(
          inbound({ timestamp, bytesReceived: 50_000, framesDecoded: 90 }),
          VP8
        )
      )
      assert.equal(stats.bitrate, null, `timestamp=${timestamp}`)
      assert.equal(stats.frameRate, null, `timestamp=${timestamp}`)
    }
  })

  it('计数器回退：按 0 处理，不产生负速率', () => {
    const baseline: StatsBaseline = {
      ...emptyBaseline(),
      inboundId: 'IN-1',
      inboundBytes: 1_000_000,
      inboundFrames: 500,
      inboundTimestamp: 2_000,
    }
    const { stats } = sampleShareStats(
      baseline,
      reportOf(
        inbound({ timestamp: 4_000, bytesReceived: 10, framesDecoded: 2 }),
        VP8
      )
    )
    assert.equal(stats.bitrate, 0)
    assert.equal(stats.frameRate, 0)
  })

  it('抖动按毫秒取整，丢包率用累计值', () => {
    const { stats } = sampleShareStats(
      null,
      reportOf(
        inbound({ jitter: 0.0123, packetsReceived: 900, packetsLost: 100 }),
        VP8
      )
    )
    assert.equal(stats.jitterMs, 12)
    assert.equal(stats.packetsReceived, 900)
    assert.equal(stats.packetsLost, 100)
    assert.equal(stats.packetLossRate, 0.1)
  })

  it('抖动缓冲取「累计延迟 / 累计播出帧数」，不是瞬时值', () => {
    const { stats } = sampleShareStats(
      null,
      reportOf(
        inbound({ jitterBufferDelay: 3.6, jitterBufferEmittedCount: 120 }),
        VP8
      )
    )
    // 3.6s / 120 帧 = 30ms
    assert.equal(stats.jitterBufferMs, 30)
  })

  it('冻结次数与累计时长换算成毫秒', () => {
    const { stats } = sampleShareStats(
      null,
      reportOf(inbound({ freezeCount: 3, totalFreezesDuration: 1.25 }), VP8)
    )
    assert.equal(stats.freezeCount, 3)
    assert.equal(stats.totalFreezeMs, 1250)
  })

  it('编码受限原因：已知值原样保留，未知值归为 other，缺失为 null', () => {
    const reason = (value?: string) =>
      sampleShareStats(
        null,
        reportOf(
          outbound(
            value === undefined ? {} : { qualityLimitationReason: value }
          ),
          H264
        )
      ).stats.qualityLimitationReason
    assert.equal(reason('cpu'), 'cpu')
    assert.equal(reason('bandwidth'), 'bandwidth')
    assert.equal(reason('none'), 'none')
    assert.equal(reason('something-new'), 'other')
    assert.equal(reason(undefined), null)
  })

  it('发送侧的编码器实现与分辨率来自 outbound-rtp', () => {
    const { stats } = sampleShareStats(
      null,
      reportOf(
        outbound({ encoderImplementation: 'ExternalEncoder (VP8)' }),
        H264
      )
    )
    assert.equal(stats.sending, true)
    assert.equal(stats.encoderImplementation, 'ExternalEncoder (VP8)')
    assert.deepEqual(stats.resolution, { width: 1280, height: 720 })
    assert.equal(stats.codec, 'H.264')
  })

  it('多了一条未激活的流时选活跃的那条', () => {
    const { stats } = sampleShareStats(
      null,
      reportOf(
        inbound({
          id: 'IN-DEAD',
          active: false,
          frameWidth: 640,
          frameHeight: 360,
        }),
        inbound(),
        VP8
      )
    )
    assert.deepEqual(stats.resolution, { width: 1920, height: 1080 })
  })

  it('候选对 RTT 只认被提名的那条', () => {
    const pairs = [
      {
        id: 'P-1',
        type: 'candidate-pair',
        state: 'succeeded',
        currentRoundTripTime: 0.08,
      },
      {
        id: 'P-2',
        type: 'candidate-pair',
        state: 'in-progress',
        nominated: false,
        currentRoundTripTime: 0.5,
      },
    ]
    const { stats } = sampleShareStats(null, reportOf(inbound(), VP8, ...pairs))
    assert.equal(stats.rttMs, 80)
  })

  it('既没有候选对也没有流时 RTT 为 null', () => {
    const { stats } = sampleShareStats(null, reportOf())
    assert.equal(stats.rttMs, null)
  })
})
