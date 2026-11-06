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
  }
}

describe('matchQualityPreset', () => {
  it('每个档位都能被自己命中', () => {
    for (const preset of QUALITY_PRESETS) {
      assert.equal(matchQualityPreset(settingsOf(preset)), preset.id)
    }
  })

  it('改到没有档位的组合就不再命中', () => {
    const hd = QUALITY_PRESETS.find((item) => item.id === 'hd')!
    // 1080p@60 正好是「高帧」档，不算自定义——这里要一个表里没有的组合。
    assert.equal(matchQualityPreset({ ...settingsOf(hd), frameRate: 15 }), null)
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
  // 档位是「分辨率 + 帧率」一整套：屏幕共享不设码率上限（带宽交给浏览器
  // 拥塞控制），所以档位表里也不该再出现 Mbps 字段。
  it('档位不含码率，避免重新引入上限', () => {
    for (const preset of QUALITY_PRESETS) {
      assert.equal(
        (preset as unknown as Record<string, unknown>).maxBitrateMbps,
        undefined,
        `${preset.id} 不该带码率`
      )
    }
  })

  it('每个档位的分辨率+帧率组合唯一', () => {
    const keys = QUALITY_PRESETS.map(
      (preset) => `${preset.resolutionPreset}@${preset.frameRate}`
    )
    assert.equal(new Set(keys).size, keys.length)
  })

  it('id 唯一且帧率合法', () => {
    const ids = new Set(QUALITY_PRESETS.map((preset) => preset.id))
    assert.equal(ids.size, QUALITY_PRESETS.length)
    for (const preset of QUALITY_PRESETS) {
      assert.ok(preset.frameRate >= 1 && preset.frameRate <= 240)
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
