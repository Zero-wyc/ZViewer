/**
 * 观众侧质量证据整理单测。
 *
 * 这一层只做「搬运 + 夹值」，但错法很具体：
 *  - 把没有可比对象的第一个窗口报上去 → 服务端看到「零帧零包」的降级证据；
 *  - 把窗口时长算错 → 服务端按比例判冻结占比，判据整体偏一边；
 *  - 报一个超出服务端接受范围的 windowMs → 整条被拒，等于这个观众永不上报。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { emptyShareStats } from '../core/stats.ts'
import { viewerQualityWindowFromStats } from '../core/viewer-quality.ts'

describe('viewerQualityWindowFromStats', () => {
  it('没在收画面就没什么可报的', () => {
    const stats = emptyShareStats()
    assert.equal(viewerQualityWindowFromStats(stats, 2000), null)
  })

  it('窗口时长超出服务端接受范围时不报', () => {
    const stats = { ...emptyShareStats(), receiving: true, frameRate: 30 }
    // 服务端只收 1000–5000ms：超范围的整条会被拒，不如不发。
    assert.equal(viewerQualityWindowFromStats(stats, 400), null)
    assert.equal(viewerQualityWindowFromStats(stats, 6000), null)
    assert.equal(viewerQualityWindowFromStats(stats, Number.NaN), null)
  })

  it('一个可判定指标都没有时也不报（服务端只会判 unknown）', () => {
    const stats = { ...emptyShareStats(), receiving: true }
    assert.equal(viewerQualityWindowFromStats(stats, 2000), null)
  })

  it('窗口指标原样搬过去，脉率/丢包按时位数取整', () => {
    const stats = {
      ...emptyShareStats(),
      receiving: true,
      frameRate: 29.968,
      bitrate: 4_512_345,
      resolution: { width: 1920, height: 1080 },
      codec: 'H264',
      rttMs: 42,
      jitterMs: 7,
      windowPacketLossRate: 0.012345,
      freezeCountWindow: 1,
      freezeMsWindow: 320.4,
      framesDroppedWindow: 3,
      decodeMsPerFrame: 6.789,
    }
    const window = viewerQualityWindowFromStats(stats, 2001.4)
    assert.ok(window)
    assert.equal(window.windowMs, 2001)
    assert.equal(window.framesPerSecond, 30)
    assert.equal(window.framesDropped, 3)
    assert.equal(window.freezeCount, 1)
    assert.equal(window.freezeDurationMs, 320)
    assert.equal(window.packetLossRate, 0.0123)
    assert.equal(window.rttMs, 42)
    assert.equal(window.jitterMs, 7)
    assert.equal(window.decodeMsPerFrame, 6.79)
    assert.equal(window.bitrateKbps, 4512)
    assert.equal(window.width, 1920)
    assert.equal(window.height, 1080)
    assert.equal(window.codec, 'H264')
  })

  it('丢包率夹到 1，负值与 NaN 的字段直接丢掉', () => {
    const stats = {
      ...emptyShareStats(),
      receiving: true,
      windowPacketLossRate: 4.2,
      frameRate: -1,
      jitterMs: Number.NaN,
      freezeCountWindow: 0,
      freezeMsWindow: 0,
    }
    const window = viewerQualityWindowFromStats(stats, 2000)
    assert.ok(window)
    assert.equal(window.packetLossRate, 1)
    assert.equal(window.framesPerSecond, undefined)
    assert.equal(window.jitterMs, undefined)
    // 冻结 0/0 是**有效**证据（画面在动），必须保留。
    assert.equal(window.freezeCount, 0)
    assert.equal(window.freezeDurationMs, 0)
  })

  it('只有冻结统计也能成窗口（这正是判「卡住」的主指标）', () => {
    const stats = {
      ...emptyShareStats(),
      receiving: true,
      freezeCountWindow: 2,
      freezeMsWindow: 900,
    }
    const window = viewerQualityWindowFromStats(stats, 2000)
    assert.ok(window)
    assert.equal(window.freezeCount, 2)
    assert.deepEqual(Object.keys(window).sort(), [
      'freezeCount',
      'freezeDurationMs',
      'windowMs',
    ])
  })
})
