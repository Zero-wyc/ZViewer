/**
 * 观众连接质量采样单测。
 *
 * 房主不需要观众上报：`remote-inbound-rtp` 就是观众回传的接收报告。
 * 这里钉住三件事：窗口差分口径、`localId` 关联、以及计数器回退时必须
 * 给 `null` 而不是 0（否则「刚重置」会被显示成「完美」）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  emptyPeerQuality,
  peerQualityEqual,
  peerQualitySeverity,
  samplePeerQuality,
} from '../core/peer-quality.ts'

function reportOf(...rows: Array<Record<string, unknown>>): RTCStatsReport {
  const map = new Map<string, unknown>()
  for (const row of rows) map.set(String(row.id), row)
  return map as unknown as RTCStatsReport
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
    packetsSent: 0,
    qualityLimitationReason: 'none',
    ...overrides,
  }
}

function remoteIn(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'RIN-1',
    type: 'remote-inbound-rtp',
    kind: 'video',
    localId: 'OUT-1',
    packetsLost: 0,
    jitter: 0.02,
    roundTripTime: 0.08,
    ...overrides,
  }
}

describe('samplePeerQuality', () => {
  it('第一次采样只给状态，窗口值为 null', () => {
    const { quality } = samplePeerQuality(
      null,
      reportOf(outbound({ bytesSent: 1000, framesEncoded: 10 }), remoteIn())
    )
    assert.equal(quality.rttMs, 80)
    assert.equal(quality.jitterMs, 20)
    assert.equal(quality.limitation, 'none')
    assert.equal(quality.bitrate, null)
    assert.equal(quality.frameRate, null)
    assert.equal(quality.packetLossRate, null)
  })

  it('窗口内算码率、帧率与观众侧丢包率', () => {
    const first = samplePeerQuality(
      null,
      reportOf(
        outbound({
          timestamp: 1_000,
          bytesSent: 1_000,
          framesEncoded: 30,
          packetsSent: 100,
        }),
        remoteIn({ packetsLost: 0 })
      )
    )
    const second = samplePeerQuality(
      first.baseline,
      reportOf(
        outbound({
          timestamp: 2_000,
          bytesSent: 251_000,
          framesEncoded: 60,
          packetsSent: 200,
        }),
        remoteIn({ packetsLost: 10 })
      )
    )
    // 1 秒 250KB → 2Mbps；30 帧 → 30fps；丢 10 / 发 100+10 ≈ 9.1%
    assert.equal(second.quality.bitrate, 2_000_000)
    assert.equal(second.quality.frameRate, 30)
    assert.ok(Math.abs(second.quality.packetLossRate - 10 / 110) < 1e-9)
    assert.equal(second.quality.packetsLost, 10)
  })

  it('只用 localId 对得上的那份接收报告', () => {
    const { quality } = samplePeerQuality(
      null,
      reportOf(
        outbound(),
        remoteIn({ id: 'RIN-OTHER', localId: 'OUT-OTHER', roundTripTime: 0.5 }),
        remoteIn({ roundTripTime: 0.09 })
      )
    )
    assert.equal(quality.rttMs, 90, '应取与自己那条 outbound 关联的报告')
  })

  it('计数器回退（浏览器重置）不给负数速率', () => {
    const first = samplePeerQuality(
      null,
      reportOf(
        outbound({ timestamp: 1_000, bytesSent: 5_000, packetsSent: 500 }),
        remoteIn({ packetsLost: 20 })
      )
    )
    const second = samplePeerQuality(
      first.baseline,
      reportOf(
        outbound({ timestamp: 2_000, bytesSent: 100, packetsSent: 10 }),
        remoteIn({ packetsLost: 1 })
      )
    )
    assert.equal(second.quality.bitrate, null)
    assert.equal(second.quality.packetLossRate, null)
  })

  it('换了一条 outbound 流就不做窗口差分', () => {
    const first = samplePeerQuality(
      null,
      reportOf(outbound({ timestamp: 1_000, bytesSent: 1_000 }), remoteIn())
    )
    const second = samplePeerQuality(
      first.baseline,
      reportOf(
        outbound({ id: 'OUT-2', timestamp: 2_000, bytesSent: 9_000 }),
        remoteIn({ id: 'RIN-2', localId: 'OUT-2' })
      )
    )
    assert.equal(second.quality.bitrate, null)
    assert.equal(second.quality.rttMs, 80, '状态字段照常给')
  })

  it('没有 outbound 时返回空质量，不抛错', () => {
    const { quality, baseline } = samplePeerQuality(null, reportOf(remoteIn()))
    assert.deepEqual(quality, {
      ...emptyPeerQuality(),
      rttMs: 80,
      jitterMs: 20,
      packetsLost: 0,
    })
    assert.equal(baseline.outboundId, null)
  })
})

describe('peerQualityEqual', () => {
  it('小幅抖动视为相同（避免每 2 秒重渲染）', () => {
    const base = { ...emptyPeerQuality(), frameRate: 30, bitrate: 2_000_000 }
    assert.equal(
      peerQualityEqual(base, { ...base, frameRate: 30.4, bitrate: 2_050_000 }),
      true
    )
  })

  it('明显变化判为不同', () => {
    const base = { ...emptyPeerQuality(), frameRate: 30, bitrate: 2_000_000 }
    assert.equal(peerQualityEqual(base, { ...base, frameRate: 12 }), false)
    assert.equal(
      peerQualityEqual(base, { ...base, packetLossRate: 0.2 }),
      false
    )
    assert.equal(peerQualityEqual(base, { ...base, limitation: 'cpu' }), false)
  })
})

describe('peerQualitySeverity', () => {
  it('没连上优先报未连接', () => {
    assert.equal(
      peerQualitySeverity(
        { ...emptyPeerQuality(), packetLossRate: 0.5 },
        'connecting'
      ),
      'offline'
    )
  })

  it('按 丢包 > 延迟 > 受限原因 的顺序取最严重的一项', () => {
    const base = { ...emptyPeerQuality() }
    assert.equal(
      peerQualitySeverity(
        { ...base, packetLossRate: 0.08, rttMs: 900 },
        'connected'
      ),
      'loss'
    )
    assert.equal(
      peerQualitySeverity({ ...base, rttMs: 450 }, 'connected'),
      'latency'
    )
    assert.equal(
      peerQualitySeverity({ ...base, limitation: 'bandwidth' }, 'connected'),
      'bandwidth'
    )
    assert.equal(
      peerQualitySeverity({ ...base, limitation: 'cpu' }, 'connected'),
      'cpu'
    )
  })

  it('阈值内（丢包 4%、RTT 200ms）算良好', () => {
    assert.equal(
      peerQualitySeverity(
        {
          ...emptyPeerQuality(),
          packetLossRate: 0.04,
          rttMs: 200,
          limitation: 'none',
        },
        'connected'
      ),
      'good'
    )
  })
})
