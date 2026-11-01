/**
 * 编码健康判定与自动降档单测。
 *
 * 这里是「预检」的核心：判错方向的两个后果都很糟——
 *  - 误判「跟不上」：用户明明能跑 60fps，开播 4 秒就被降到 720p30；
 *  - 漏判：画面卡成 15fps，界面上却写着 60fps。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  encoderSustainsTarget,
  nextLowerProfile,
  type EncoderHealthSample,
} from '../core/encoder-health.ts'
import type { QualityProfile } from '../core/quality.ts'

function sample(
  overrides: Partial<EncoderHealthSample> = {}
): EncoderHealthSample {
  return {
    outboundId: 'OUT-1',
    sourceId: 'SRC-1',
    timestamp: 0,
    framesEncoded: 0,
    sourceFrames: 0,
    limitation: 'none',
    ...overrides,
  }
}

describe('encoderSustainsTarget', () => {
  it('编码帧数与采集帧数都跟得上目标帧率 → true', () => {
    const result = encoderSustainsTarget(
      sample({ timestamp: 0 }),
      sample({ timestamp: 2_000, framesEncoded: 60, sourceFrames: 60 }),
      30
    )
    assert.equal(result, true)
  })

  it('源出满了但编码跟不上 → false', () => {
    // 屏幕内容一直在动（源 60 帧/2s），编码只出了 16 帧。
    const result = encoderSustainsTarget(
      sample({ timestamp: 0 }),
      sample({ timestamp: 2_000, framesEncoded: 16, sourceFrames: 60 }),
      30
    )
    assert.equal(result, false)
  })

  it('拿不到采集帧数时只比目标帧率', () => {
    const slow = encoderSustainsTarget(
      sample({ timestamp: 0, sourceFrames: null }),
      sample({ timestamp: 2_000, framesEncoded: 16, sourceFrames: null }),
      30
    )
    assert.equal(slow, false)
    const fast = encoderSustainsTarget(
      sample({ timestamp: 0, sourceFrames: null }),
      sample({ timestamp: 2_000, framesEncoded: 60, sourceFrames: null }),
      30
    )
    assert.equal(fast, true)
  })

  it('浏览器明确报 CPU 受限 → 直接 false，不必等帧数', () => {
    const result = encoderSustainsTarget(
      sample({ timestamp: 0 }),
      sample({
        timestamp: 2_000,
        framesEncoded: 60,
        sourceFrames: 60,
        limitation: 'cpu',
      }),
      30
    )
    assert.equal(result, false)
  })

  it('窗口不足一秒 → null（判不了，调用方不能计入不达标）', () => {
    assert.equal(
      encoderSustainsTarget(
        sample({ timestamp: 0 }),
        sample({ timestamp: 500, framesEncoded: 15, sourceFrames: 15 }),
        30
      ),
      null
    )
  })

  it('采集侧自己就只出这么多帧时不算编码的锅', () => {
    // 目标 30fps，但屏幕内容静止，采集 2 秒只出 10 帧，编码也出了 10 帧
    const result = encoderSustainsTarget(
      sample({ timestamp: 0 }),
      sample({ timestamp: 2_000, framesEncoded: 10, sourceFrames: 10 }),
      30
    )
    assert.equal(result, true)
  })

  it('源出了 60 帧、编码只有 20 帧 → false（编码掉帧）', () => {
    const result = encoderSustainsTarget(
      sample({ timestamp: 0 }),
      sample({ timestamp: 2_000, framesEncoded: 20, sourceFrames: 60 }),
      30
    )
    assert.equal(result, false)
  })

  it('换了一条 outbound（重建连接）→ false，交给下一窗口重新判定', () => {
    const result = encoderSustainsTarget(
      sample({ timestamp: 0 }),
      sample({ outboundId: 'OUT-2', timestamp: 2_000, framesEncoded: 60 }),
      30
    )
    assert.equal(result, false)
  })

  it('时间戳不前进 → false（同一时刻的两次采样没有窗口）', () => {
    assert.equal(
      encoderSustainsTarget(
        sample({ timestamp: 2_000 }),
        sample({ timestamp: 2_000, framesEncoded: 60 }),
        30
      ),
      false
    )
  })
})

const baseProfile: QualityProfile = {
  resolution: { width: 1920, height: 1080 },
  maxFramerate: 60,
  maxBitrate: 16_000_000,
  degradationPreference: 'balanced',
  maxAudioBitrate: 128_000,
}

describe('nextLowerProfile', () => {
  it('先降帧率：60fps → 30fps，分辨率不动', () => {
    const next = nextLowerProfile(baseProfile)
    assert.ok(next)
    assert.equal(next.maxFramerate, 30)
    assert.deepEqual(next.resolution, { width: 1920, height: 1080 })
    assert.ok((next.maxBitrate ?? 0) <= 8_000_000, '帧率砍半后码率也要收')
  })

  it('45fps 也一步降到 30（45 省不了多少还多一次重配）', () => {
    const next = nextLowerProfile({ ...baseProfile, maxFramerate: 45 })
    assert.equal(next?.maxFramerate, 30)
  })

  it('帧率已是 30 就降分辨率：1080p → 720p', () => {
    const next = nextLowerProfile({ ...baseProfile, maxFramerate: 30 })
    assert.ok(next)
    assert.deepEqual(next.resolution, { width: 1280, height: 720 })
    assert.equal(next.maxFramerate, 30)
  })

  it('2k/4k 逐级下降', () => {
    assert.deepEqual(
      nextLowerProfile({
        ...baseProfile,
        maxFramerate: 30,
        resolution: { width: 3840, height: 2160 },
      })?.resolution,
      { width: 2560, height: 1440 }
    )
    assert.deepEqual(
      nextLowerProfile({
        ...baseProfile,
        maxFramerate: 30,
        resolution: { width: 2560, height: 1440 },
      })?.resolution,
      { width: 1920, height: 1080 }
    )
  })

  it('native（不约束宽高）当作最高档，先降到 720p', () => {
    const next = nextLowerProfile({
      ...baseProfile,
      maxFramerate: 30,
      resolution: null,
    })
    assert.deepEqual(next?.resolution, { width: 1280, height: 720 })
  })

  it('已经是最低档就返回 null，不再折腾', () => {
    assert.equal(
      nextLowerProfile({
        ...baseProfile,
        maxFramerate: 30,
        resolution: { width: 1280, height: 720 },
      }),
      null
    )
  })

  it('降档时码率不低于 2Mbps', () => {
    const next = nextLowerProfile({
      ...baseProfile,
      maxFramerate: 30,
      maxBitrate: 1_000_000,
    })
    assert.equal(next?.maxBitrate, 2_000_000)
  })
})
