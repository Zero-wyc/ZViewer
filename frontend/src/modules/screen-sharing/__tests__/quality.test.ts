/**
 * 采集/编码档位单测。
 *
 * 这里只测纯逻辑（约束拼装、上限推导、回读比对），不碰真实浏览器 API：
 * 真假 sender 已经足够覆盖「参数被浏览器改写」这条判定。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_QUALITY_PROFILE,
  MAX_AUDIO_SEND_BITRATE,
  SCREEN_AUDIO_BITRATES,
  STARTUP_VIDEO_ENCODED_FRAMES,
  audioSenderCeiling,
  captureConstraints,
  captureFramerateCeiling,
  configureAudioSender,
  configureVideoSender,
  needsStartupVideoProfile,
  profileFromSettings,
  qualityNeedsCaptureUpdate,
  qualitySettingsEqual,
  screenAudioBitrate,
  senderParameterReadback,
  startupVideoProfile,
  supportsCaptureProfile,
  videoQualitySettingsEqual,
  type QualityProfile,
} from '../core/quality.ts'

const profile: QualityProfile = { ...DEFAULT_QUALITY_PROFILE }

/** 拼一份完整的 RTCRtpSendParameters（DOM 类型要求 headerExtensions/rtcp 齐全）。 */
function sendParameters(
  encodings: RTCRtpEncodingParameters[],
  codecs: RTCRtpCodecParameters[] = []
): RTCRtpSendParameters {
  return {
    transactionId: 't1',
    encodings,
    codecs,
    headerExtensions: [],
    rtcp: {},
  } as unknown as RTCRtpSendParameters
}

/** 一路 Opus 编码定义。 */
function opus(sdpFmtpLine: string): RTCRtpCodecParameters {
  return {
    payloadType: 111,
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    sdpFmtpLine,
  } as RTCRtpCodecParameters
}

/** 假 sender：`setParameters` 之后立刻能读回，可选择性地改写参数模拟浏览器行为。 */
function fakeSender(
  rewrite?: (parameters: RTCRtpSendParameters) => void,
  codecs: RTCRtpCodecParameters[] = []
) {
  let current = sendParameters([{}], codecs)
  return {
    track: undefined,
    getParameters: () => current,
    setParameters: async (next: RTCRtpSendParameters) => {
      current = {
        ...next,
        encodings: next.encodings.map((item) => ({ ...item })),
      }
      rewrite?.(current)
    },
  } as unknown as RTCRtpSender
}

describe('captureConstraints', () => {
  it('宽高只下发上限，不下发目标值', () => {
    const constraints = captureConstraints({
      ...profile,
      resolution: { width: 1920, height: 1080 },
      maxFramerate: 60,
    })
    // 用 ideal 会让采集器裁剪画面去凑尺寸，必须只有 max。
    assert.deepEqual(constraints.width, { max: 1920 })
    assert.deepEqual(constraints.height, { max: 1080 })
    assert.deepEqual(constraints.frameRate, { ideal: 60, max: 60 })
  })

  it('native 档位不下发宽高', () => {
    const constraints = captureConstraints({ ...profile, resolution: null })
    assert.equal(constraints.width, undefined)
    assert.equal(constraints.height, undefined)
  })
})

describe('captureFramerateCeiling', () => {
  it('1080p 能跑到 240fps 上限之内', () => {
    assert.equal(captureFramerateCeiling({ width: 1920, height: 1080 }), 240)
  })

  it('8K 面积超限直接拒绝', () => {
    assert.equal(captureFramerateCeiling({ width: 7680, height: 4320 }), 0)
  })

  it('奇数边长被拒（编码器要求偶数）', () => {
    assert.equal(captureFramerateCeiling({ width: 1281, height: 720 }), 0)
  })
})

describe('supportsCaptureProfile', () => {
  it('合法档位通过', () => {
    assert.equal(supportsCaptureProfile(profile), true)
  })

  it('码率不再参与校验（屏幕共享不设上限）', () => {
    assert.equal(
      supportsCaptureProfile({
        ...profile,
        // 老调用方可能还带着这个字段：不该因此被拒。
        ...({ maxBitrate: 10_000 } as Record<string, number>),
      }),
      true
    )
  })

  it('帧率超过该尺寸的上限被拒', () => {
    assert.equal(
      supportsCaptureProfile({
        ...profile,
        resolution: { width: 7680, height: 4320 },
        maxFramerate: 60,
      }),
      false
    )
  })

  it('音频码率超过发送上限被拒', () => {
    assert.equal(
      supportsCaptureProfile({
        ...profile,
        maxAudioBitrate: MAX_AUDIO_SEND_BITRATE + 1,
      }),
      false
    )
  })
})

describe('启动保护', () => {
  it('非 maintain-resolution 的档位需要启动保护', () => {
    assert.equal(needsStartupVideoProfile(profile), true)
  })

  it('启动档位强制 maintain-resolution，且不改其它字段', () => {
    const startup = startupVideoProfile(profile)
    assert.equal(startup.degradationPreference, 'maintain-resolution')
    assert.equal(startup.maxFramerate, profile.maxFramerate)
  })

  it('已经是 maintain-resolution 的档位不需要再降级', () => {
    const fixed: QualityProfile = {
      ...profile,
      degradationPreference: 'maintain-resolution',
    }
    assert.equal(needsStartupVideoProfile(fixed), false)
    assert.equal(startupVideoProfile(fixed), fixed)
  })

  it('5 帧才允许切档', () => {
    assert.equal(STARTUP_VIDEO_ENCODED_FRAMES, 5)
  })
})

describe('screenAudioBitrate', () => {
  it('缺省取 music 档', () => {
    assert.equal(screenAudioBitrate(undefined), SCREEN_AUDIO_BITRATES.music)
  })

  it('解析缺省值，但不在这里钳制（钳制属协商层）', () => {
    assert.equal(screenAudioBitrate(999_999), 999_999)
  })
})

describe('audioSenderCeiling', () => {
  it('没有 Opus 码率信息时按发送上限', () => {
    assert.equal(audioSenderCeiling(sendParameters([{}]), 128_000), 128_000)
  })

  it('协商的 maxaveragebitrate 比请求低时取协商值', () => {
    const codecs = [opus('stereo=1;maxaveragebitrate=64000')]
    assert.equal(
      audioSenderCeiling(sendParameters([{}], codecs), 192_000),
      64_000
    )
  })

  it('没写 maxaveragebitrate 时按 libwebrtc 默认推导，而不是当成无上限', () => {
    const codecs = [opus('')]
    // 48kHz 单声道默认 32kbps。
    assert.equal(
      audioSenderCeiling(sendParameters([{}], codecs), 128_000),
      32_000
    )
  })

  it('立体声翻倍', () => {
    const codecs = [opus('stereo=1')]
    assert.equal(
      audioSenderCeiling(sendParameters([{}], codecs), 128_000),
      64_000
    )
  })
})

describe('configureVideoSender', () => {
  it('写入帧率/降级策略并读回一致', async () => {
    const sender = fakeSender()
    const readback = await configureVideoSender(sender, {
      ...profile,
      resolution: null,
      maxFramerate: 30,
    })
    assert.deepEqual(readback.mismatches, [])
    assert.equal(readback.applied.maxFramerate, 30)
    assert.equal(readback.applied.degradationPreference, 'balanced')
  })

  it('不下发码率上限：sender 上残留的 maxBitrate 也被清掉', async () => {
    const sender = fakeSender()
    // 模拟 sender 复用：上一次设置留下的上限必须被删掉。
    // 固定返回同一个对象——configure 直接改它，再交给 setParameters。
    const stale = sendParameters([{ maxBitrate: 4_000_000 }])
    ;(
      sender as unknown as { getParameters: () => RTCRtpSendParameters }
    ).getParameters = () => stale
    await configureVideoSender(sender, profile)
    assert.equal(stale.encodings[0]!.maxBitrate, undefined)
  })

  it('浏览器改写参数时能被读回发现', async () => {
    const sender = fakeSender((parameters) => {
      // 模拟浏览器把帧率改回去。
      parameters.encodings[0]!.maxFramerate = 15
    })
    const readback = await configureVideoSender(sender, profile)
    assert.deepEqual(readback.mismatches, ['maxFramerate'])
  })

  it('多编码层时只改最后一层（simulcast 的全尺寸层）', async () => {
    const sender = fakeSender(undefined)
    ;(
      sender as unknown as { getParameters: () => RTCRtpSendParameters }
    ).getParameters = () => sendParameters([{ maxBitrate: 100_000 }, {}])
    const readback = await configureVideoSender(sender, profile)
    assert.equal(readback.requested.maxFramerate, profile.maxFramerate)
    // 单层才设 scaleResolutionDownBy；两层时不该出现在请求里。
    assert.equal(readback.requested.scaleResolutionDownBy, null)
  })

  it('carrierScale 存在时不设帧率上限（帧节拍由 producer 掌握）', async () => {
    const sender = fakeSender()
    const readback = await configureVideoSender(sender, profile, 2)
    assert.equal(readback.requested.maxFramerate, null)
    assert.equal(readback.requested.scaleResolutionDownBy, 2)
    assert.equal(readback.requested.degradationPreference, 'maintain-framerate')
  })
})

describe('qualityNeedsCaptureUpdate', () => {
  const base: QualityProfile = { ...DEFAULT_QUALITY_PROFILE }

  it('首次下发（没有旧档位）必须下发采集约束', () => {
    assert.equal(qualityNeedsCaptureUpdate(null, base), true)
  })

  it('只改帧率也要重下发采集约束', () => {
    // 采集阶段的 frameRate.max 是硬上限：不算进来就永远调不到更高帧率。
    assert.equal(
      qualityNeedsCaptureUpdate(base, { ...base, maxFramerate: 60 }),
      true
    )
    assert.equal(
      qualityNeedsCaptureUpdate(base, { ...base, maxFramerate: 15 }),
      true
    )
  })

  it('改分辨率要重下发采集约束', () => {
    assert.equal(
      qualityNeedsCaptureUpdate(base, {
        ...base,
        resolution: { width: 1280, height: 720 },
      }),
      true
    )
    assert.equal(
      qualityNeedsCaptureUpdate(base, { ...base, resolution: null }),
      true
    )
  })

  it('只改画面偏好/音频码率不碰采集', () => {
    assert.equal(
      qualityNeedsCaptureUpdate(base, {
        ...base,
        degradationPreference: 'maintain-framerate',
      }),
      false
    )
    assert.equal(
      qualityNeedsCaptureUpdate(base, { ...base, maxAudioBitrate: 64_000 }),
      false
    )
  })
})

describe('configureAudioSender', () => {
  it('下发协商上限而不是用户请求值', async () => {
    const sender = fakeSender()
    const readback = await configureAudioSender(
      sender,
      MAX_AUDIO_SEND_BITRATE + 100_000
    )
    assert.equal(readback.appliedMaxBitrate, MAX_AUDIO_SEND_BITRATE)
    assert.equal(readback.requestedMaxBitrate, MAX_AUDIO_SEND_BITRATE + 100_000)
    // 请求值与实际值不同即视为浏览器改写，必须回报。
    assert.equal(readback.mismatch, true)
  })
})

describe('senderParameterReadback', () => {
  it('scaleResolutionDownBy 用容差比较', () => {
    const requested = {
      maxFramerate: 30,
      scaleResolutionDownBy: 2,
      degradationPreference: 'balanced' as RTCDegradationPreference,
      scalabilityMode: null,
    }
    const applied = { ...requested, scaleResolutionDownBy: 2.0000001 }
    assert.deepEqual(senderParameterReadback(requested, applied).mismatches, [])
  })

  it('请求里没有 scalabilityMode 时忽略实际值', () => {
    const requested = {
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
      degradationPreference: 'balanced' as RTCDegradationPreference,
      scalabilityMode: null,
    }
    const applied = { ...requested, scalabilityMode: 'L1T3' }
    assert.deepEqual(senderParameterReadback(requested, applied).mismatches, [])
  })
})

describe('档位比较与拼装', () => {
  it('分辨率相同但帧率不同视为不同档位', () => {
    assert.equal(
      videoQualitySettingsEqual(profile, { ...profile, maxFramerate: 60 }),
      false
    )
  })

  it('音频码率不同也算档位变化', () => {
    assert.equal(
      qualitySettingsEqual(profile, { ...profile, maxAudioBitrate: 64_000 }),
      false
    )
  })

  it('只拼分辨率/帧率/偏好，不带码率', () => {
    const built = profileFromSettings({
      frameRate: 60,
      resolution: { width: 1920, height: 1080 },
    })
    assert.equal(built.maxFramerate, 60)
    assert.equal(built.degradationPreference, 'balanced')
    assert.equal(
      (built as unknown as Record<string, unknown>).maxBitrate,
      undefined,
      '档位不该再带码率上限'
    )
  })
})
