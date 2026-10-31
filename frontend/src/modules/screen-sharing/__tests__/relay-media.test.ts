import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { relayMediaDeclaration } from '../core/relay-media.ts'
import type { QualityProfile } from '../core/quality.ts'

/** 造一份档位：只填声明会用到的字段。 */
function profile(overrides: Partial<QualityProfile> = {}): QualityProfile {
  return {
    frameRate: 30,
    maxBitrate: 6_000_000,
    maxAudioBitrate: 128_000,
    resolution: { width: 1920, height: 1080 },
    ...overrides,
  } as QualityProfile
}

describe('relayMediaDeclaration', () => {
  it('单层、RID 为空串（服务端只接受「一层 + 空 RID」这种形态）', () => {
    const media = relayMediaDeclaration(profile(), {
      codec: 'vp8',
      audio: false,
    })
    assert.deepEqual(media.rids, [''])
    assert.equal(media.formats.length, 1)
    assert.equal(media.rids.length, media.formats.length)
  })

  it('尺寸取采集档位，码率取上限', () => {
    const media = relayMediaDeclaration(profile(), {
      codec: 'vp8',
      audio: false,
    })
    assert.deepEqual(media.formats[0], {
      width: 1920,
      height: 1080,
      bitrate: 6_000_000,
    })
  })

  it('声明音频时必须带码率，否则整条发布被判非法', () => {
    const media = relayMediaDeclaration(profile(), {
      codec: 'vp8',
      audio: true,
    })
    assert.equal(media.audio, true)
    assert.equal(media.audioBitrate, 128_000)
  })

  it('不共享声音时码率写 0（而不是省略字段）', () => {
    const media = relayMediaDeclaration(profile(), {
      codec: 'vp8',
      audio: false,
    })
    assert.equal(media.audio, false)
    assert.equal(media.audioBitrate, 0)
  })

  it('码率取整且至少为 1：服务端把 0 当作非法声明', () => {
    const media = relayMediaDeclaration(
      profile({ maxBitrate: 0, maxAudioBitrate: 0 }),
      { codec: 'vp8', audio: true }
    )
    assert.equal(media.formats[0].bitrate, 1)
    assert.equal(media.audioBitrate, 1)
  })

  it('缺分辨率时退回 1080p 而不是发 0×0', () => {
    const media = relayMediaDeclaration(
      { ...profile(), resolution: undefined } as unknown as QualityProfile,
      { codec: 'vp8', audio: false }
    )
    assert.deepEqual(
      { width: media.formats[0].width, height: media.formats[0].height },
      { width: 1920, height: 1080 }
    )
  })

  it('编码取调用方指定的那一个（中继固定 vp8）', () => {
    assert.equal(
      relayMediaDeclaration(profile(), { codec: 'vp8', audio: false }).codec,
      'vp8'
    )
    assert.equal(
      relayMediaDeclaration(profile(), { codec: 'h264', audio: false }).codec,
      'h264'
    )
  })
})
