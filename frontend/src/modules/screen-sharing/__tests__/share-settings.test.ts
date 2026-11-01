/**
 * 共享参数卡片的纯逻辑测试。
 *
 * 档位匹配是最容易出错的一处：用户改了一项就不再是那个档位，但界面很容易
 * 继续高亮旧档位——那会让人以为「点了没生效」。这里把判定钉死。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AUDIO_BITRATE_OPTIONS,
  DEGRADATION_OPTIONS,
  QUALITY_PRESETS,
  matchQualityPreset,
  type QualityPresetOption,
} from '../constants.ts'

function settingsOf(preset: QualityPresetOption) {
  return {
    resolutionPreset: preset.resolutionPreset,
    frameRate: preset.frameRate,
    maxBitrateMbps: preset.maxBitrateMbps,
  }
}

describe('matchQualityPreset', () => {
  it('每个档位都能被自己命中', () => {
    for (const preset of QUALITY_PRESETS) {
      assert.equal(matchQualityPreset(settingsOf(preset)), preset.id)
    }
  })

  it('改任意一项都不再命中', () => {
    const hd = QUALITY_PRESETS.find((item) => item.id === 'hd')!
    assert.equal(matchQualityPreset({ ...settingsOf(hd), frameRate: 60 }), null)
    assert.equal(
      matchQualityPreset({ ...settingsOf(hd), maxBitrateMbps: 6 }),
      null
    )
    assert.equal(
      matchQualityPreset({ ...settingsOf(hd), resolutionPreset: '2k' }),
      null
    )
  })

  it('只比档位名不比尺寸：1080p 与 2k 不是同一档', () => {
    const hd = QUALITY_PRESETS.find((item) => item.id === 'hd')!
    assert.equal(
      matchQualityPreset({
        ...settingsOf(hd),
        resolutionPreset: '2160p' as never,
      }),
      null
    )
  })
})

describe('QUALITY_PRESETS', () => {
  // 档位是「分辨率 + 帧率 + 码率」一整套：只改其中一项会得到自相矛盾的组合。
  // 这里只保证它们内部自洽（码率递增、在输入框范围内），不套用 1080p 的推荐
  // 码率公式——720p 用 1080p 的推荐值当门槛只会把「流畅」档逼成高清。
  it('码率随档位递增，且落在输入框允许的范围内', () => {
    const bitrates = QUALITY_PRESETS.map((preset) => preset.maxBitrateMbps)
    assert.deepEqual(
      bitrates,
      [...bitrates].sort((a, b) => a - b)
    )
    for (const bitrate of bitrates) {
      assert.ok(bitrate >= 0.5 && bitrate <= 50, `${bitrate}Mbps 超出输入范围`)
    }
  })

  it('高帧档给足高帧率所需的码率', () => {
    const highFps = QUALITY_PRESETS.find((preset) => preset.id === 'high-fps')!
    const recommended = Math.max(2, Math.round(highFps.frameRate * 0.267))
    assert.ok(highFps.maxBitrateMbps >= recommended)
  })

  it('id 唯一且档位名合法', () => {
    const ids = new Set(QUALITY_PRESETS.map((preset) => preset.id))
    assert.equal(ids.size, QUALITY_PRESETS.length)
    for (const preset of QUALITY_PRESETS) {
      assert.ok(preset.frameRate >= 1 && preset.frameRate <= 240)
      assert.ok(preset.maxBitrateMbps > 0)
    }
  })
})

describe('参数选项表', () => {
  it('画面偏好覆盖浏览器支持的三个取值', () => {
    assert.deepEqual(DEGRADATION_OPTIONS.map((option) => option.value).sort(), [
      'balanced',
      'maintain-framerate',
      'maintain-resolution',
    ])
  })

  it('音频档位按码率递增，且不超过发送上限', () => {
    const bitrates = AUDIO_BITRATE_OPTIONS.map((option) => option.value)
    assert.deepEqual(
      bitrates,
      [...bitrates].sort((a, b) => a - b)
    )
    for (const bitrate of bitrates) assert.ok(bitrate <= 320_000)
  })
})
