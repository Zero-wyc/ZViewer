/**
 * 窗口化统计与音频段单测。
 *
 * 这一组盯的是「累计值会骗人」：跑了半小时之后，刚才 10 秒丢的包会被摊薄
 * 成看不出问题的小数。窗口值必须只反映最近一次采样的区间，而且计数器回退
 * （换流、浏览器重置）时必须是 `null` 而不是负数或 0。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sampleShareStats } from '../core/stats.ts'

function reportOf(...rows: Array<Record<string, unknown>>): RTCStatsReport {
  const map = new Map<string, unknown>()
  for (const row of rows) map.set(String(row.id), row)
  return map as unknown as RTCStatsReport
}

function inbound(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'IN-1',
    type: 'inbound-rtp',
    kind: 'video',
    active: true,
    timestamp: 1_000,
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

function outbound(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'OUT-1',
    type: 'outbound-rtp',
    kind: 'video',
    active: true,
    timestamp: 1_000,
    bytesSent: 0,
    framesEncoded: 0,
    frameWidth: 1280,
    frameHeight: 720,
    packetsSent: 0,
    codecId: 'CODEC-2',
    ...overrides,
  }
}

/** 一条音频接收流。 */
function audioIn(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'AIN-1',
    type: 'inbound-rtp',
    kind: 'audio',
    active: true,
    timestamp: 1_000,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: 0,
    jitter: 0.01,
    audioLevel: 0.4,
    totalSamplesReceived: 0,
    concealedSamples: 0,
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    ...overrides,
  }
}

const VP8 = { id: 'CODEC-1', type: 'codec', mimeType: 'video/VP8' }
const H264 = { id: 'CODEC-2', type: 'codec', mimeType: 'video/H264' }

describe('sampleShareStats 窗口化', () => {
  it('窗口丢包率与累计丢包率分开算', () => {
    const first = sampleShareStats(
      null,
      reportOf(
        inbound({ timestamp: 1_000, packetsReceived: 900, packetsLost: 0 }),
        VP8
      )
    )
    const second = sampleShareStats(
      first.baseline,
      reportOf(
        inbound({ timestamp: 2_000, packetsReceived: 1_800, packetsLost: 100 }),
        VP8
      )
    )
    // 累计 100 / 1900 ≈ 5.26%；本窗口 100 / 1000 = 10%
    assert.equal(second.stats.packetLossRate, 100 / 1900)
    assert.equal(second.stats.windowPacketLossRate, 0.1)
  })

  it('计数器回退（浏览器重置）不产生负数速率', () => {
    const first = sampleShareStats(
      null,
      reportOf(
        inbound({ timestamp: 1_000, packetsReceived: 900, packetsLost: 10 }),
        VP8
      )
    )
    const second = sampleShareStats(
      first.baseline,
      reportOf(
        inbound({ timestamp: 2_000, packetsReceived: 100, packetsLost: 2 }),
        VP8
      )
    )
    // 丢包率需要「收到的包」作分母，回退后算不出比例 → null；
    // 字节速率沿用原实现的约定：回退按 0 处理（这一窗口确实没有新数据）。
    assert.equal(second.stats.windowPacketLossRate, null)
    assert.equal(second.stats.bitrate, 0)
  })

  it('冻结次数与时长按窗口计，累计值保持累计', () => {
    const first = sampleShareStats(
      null,
      reportOf(
        inbound({
          timestamp: 1_000,
          freezeCount: 2,
          totalFreezesDuration: 0.5,
        }),
        VP8
      )
    )
    const second = sampleShareStats(
      first.baseline,
      reportOf(
        inbound({
          timestamp: 3_000,
          freezeCount: 5,
          totalFreezesDuration: 1.25,
        }),
        VP8
      )
    )
    assert.equal(second.stats.freezeCount, 5, '累计值照旧可读')
    assert.equal(second.stats.freezeCountWindow, 3)
    assert.equal(second.stats.totalFreezeMs, 1250)
    assert.equal(second.stats.freezeMsWindow, 750)
  })

  it('编码耗时按窗口的平均值算（毫秒/帧）', () => {
    const first = sampleShareStats(
      null,
      reportOf(
        outbound({ timestamp: 1_000, framesEncoded: 30, totalEncodeTime: 1 }),
        H264
      )
    )
    const second = sampleShareStats(
      first.baseline,
      reportOf(
        outbound({ timestamp: 2_000, framesEncoded: 60, totalEncodeTime: 2 }),
        H264
      )
    )
    // 本窗口 1 秒编码 30 帧 → 33.3ms/帧
    assert.ok(second.stats.encodeMsPerFrame !== null)
    assert.ok(Math.abs(second.stats.encodeMsPerFrame - 1000 / 30) < 0.01)
  })

  it('受限原因占比只统计本窗口', () => {
    const first = sampleShareStats(
      null,
      reportOf(
        outbound({
          timestamp: 1_000,
          qualityLimitationDurations: {
            none: 7,
            bandwidth: 3,
            cpu: 0,
            other: 0,
          },
        }),
        H264
      )
    )
    const second = sampleShareStats(
      first.baseline,
      reportOf(
        outbound({
          timestamp: 3_000,
          qualityLimitationDurations: {
            none: 8,
            bandwidth: 5,
            cpu: 0,
            other: 0,
          },
        }),
        H264
      )
    )
    // 本窗口增量：none 1s、bandwidth 2s → 33.3% / 66.7%
    const share = second.stats.limitationShare
    assert.ok(share)
    assert.ok(Math.abs(share.none - 100 / 3) < 0.01)
    assert.ok(Math.abs(share.bandwidth - 200 / 3) < 0.01)
    assert.equal(share.cpu, 0)
  })

  it('缺少受限时长字段时占比为 null，不硬凑成 0%', () => {
    const first = sampleShareStats(null, reportOf(outbound(), H264))
    const second = sampleShareStats(
      first.baseline,
      reportOf(outbound({ timestamp: 3_000 }), H264)
    )
    assert.equal(second.stats.limitationShare, null)
  })
})

describe('sampleShareStats 音频', () => {
  it('第一次采样只有状态没有窗口值', () => {
    const { stats } = sampleShareStats(null, reportOf(audioIn()))
    assert.ok(stats.audio)
    assert.equal(stats.audio.receiving, true)
    assert.equal(stats.audio.jitterMs, 10)
    assert.equal(stats.audio.level, 0.4)
    assert.equal(stats.audio.bitrate, null, '没有上一次基线就没有窗口')
    assert.equal(stats.audio.packetLossRate, null)
  })

  it('窗口内算码率、丢包率与丢包隐藏比例', () => {
    const first = sampleShareStats(
      null,
      reportOf(
        audioIn({
          timestamp: 1_000,
          bytesReceived: 1_000,
          packetsReceived: 100,
          totalSamplesReceived: 48_000,
          concealedSamples: 0,
        })
      )
    )
    const second = sampleShareStats(
      first.baseline,
      reportOf(
        audioIn({
          timestamp: 2_000,
          bytesReceived: 4_000,
          packetsReceived: 200,
          packetsLost: 5,
          totalSamplesReceived: 96_000,
          concealedSamples: 4_800,
        })
      )
    )
    assert.ok(second.stats.audio)
    // 本窗口 1 秒 3000 字节 → 24kbps
    assert.equal(second.stats.audio.bitrate, 24_000)
    assert.equal(second.stats.audio.packetLossRate, 5 / 105)
    assert.equal(second.stats.audio.concealmentRate, 0.1)
  })

  it('音频流换了一条（id 变了）就不做窗口差分', () => {
    const first = sampleShareStats(
      null,
      reportOf(audioIn({ id: 'AIN-1', bytesReceived: 1_000 }))
    )
    const second = sampleShareStats(
      first.baseline,
      reportOf(audioIn({ id: 'AIN-2', timestamp: 2_000, bytesReceived: 900 }))
    )
    assert.ok(second.stats.audio)
    assert.equal(second.stats.audio.bitrate, null)
    assert.equal(second.stats.audio.receiving, true)
  })

  it('没有音轨时 audio 为 null', () => {
    const { stats } = sampleShareStats(null, reportOf(inbound(), VP8))
    assert.equal(stats.audio, null)
  })
})
