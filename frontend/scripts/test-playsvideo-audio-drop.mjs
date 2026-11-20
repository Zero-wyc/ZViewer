/**
 * playsvideo 音轨降级回归测试（对应 GitHub issue #47）。
 *
 * 症状：多数 remux 影片（Dolby TrueHD/Atmos 音轨）开启「浏览器转码」后
 * 整片播放失败，报
 *   `TypeError: Audio chunk metadata must be provided.`
 *
 * 根因（第一种形态，mediabunny ≤1.38）：未登记的容器 CodecID（Matroska
 * `A_TRUEHD` 等）会让音轨「存在但 codec 为 null」，`getDecoderConfig()`
 * 返回 null；上游仍按「有音轨」继续，doTranscode 因 `audioCodec !== null`
 * 前置条件为 false，最终把无 decoderConfig 的音频包送进 fMP4 muxer，
 * 建轨时抛错，整段失败。
 *
 * 根因（第二种形态，mediabunny ≥1.66）：上游认了 `truehd`（decoderConfig
 * codec 为 `mlpa`），配置非空 ⇒ doTranscode = true ⇒ 送进只有 audio tier 的
 * wasm ffmpeg ⇒ `Full ffmpeg tier is not currently enabled`，同样整段失败。
 *
 * 修复：demux 阶段按「codec 可识别 + 有 decoderConfig + 在管线可处理白名单内」
 * 择优（跳过不可用音轨），全部不可用时按「无音轨」降级；mux 阶段只在
 * 「有音频包 且 有 decoderConfig」时建音轨。
 *
 * 运行：npm run test:playsvideo -w frontend
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacket,
  Input,
} from '../vendor/mediabunny/dist/modules/src/index.js'
import { muxToFmp4 } from '../vendor/playsvideo/dist/pipeline/mux.js'
import { pickPlayableAudioTrack } from '../vendor/playsvideo/dist/pipeline/demux.js'

/** 最小可用的 AVCDecoderConfigurationRecord（muxer 建轨只需要结构合法） */
const AVCC = new Uint8Array([
  0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28,
  0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80,
])
/** AAC-LC 48kHz 立体声的 AudioSpecificConfig */
const ASC = new Uint8Array([0x12, 0x10])

const VIDEO_DECODER_CONFIG = {
  codec: 'avc1.640028',
  codedWidth: 320,
  codedHeight: 240,
  description: AVCC,
}
const AUDIO_DECODER_CONFIG = {
  codec: 'mp4a.40.2',
  numberOfChannels: 2,
  sampleRate: 48000,
  description: ASC,
}

/** 假音轨：模拟 mediabunny 的 InputAudioTrack 可用属性 */
function fakeTrack({ codec, internalCodecId = null, throws = false, config }) {
  return {
    codec,
    internalCodecId,
    async getDecoderConfig() {
      if (throws) throw new Error('malformed track')
      if (config !== undefined) return config
      return codec ? AUDIO_DECODER_CONFIG : null
    },
  }
}

/** mediabunny 1.66 对 TrueHD 给出的真实形态：codec 已识别，config 为 mlpa */
const TRUEHD_DECODER_CONFIG = {
  codec: 'mlpa',
  numberOfChannels: 8,
  sampleRate: 48000,
}

function makePackets() {
  const data = new Uint8Array(64).fill(7)
  return {
    video: [
      new EncodedPacket(data, 'key', 0, 0.04),
      new EncodedPacket(data, 'delta', 0.04, 0.04),
    ],
    audio: [new EncodedPacket(data, 'key', 0, 0.021)],
  }
}

/** 解析 init 段，返回轨道类型序列（video / audio / subtitle） */
async function trackKinds(init) {
  const input = new Input({ source: new BufferSource(init), formats: ALL_FORMATS })
  try {
    const tracks = await input.getTracks()
    return tracks.map((t) =>
      t.isVideoTrack() ? 'video' : t.isAudioTrack() ? 'audio' : 'subtitle'
    )
  } finally {
    input.dispose()
  }
}

test('主音轨为 TrueHD（codec 未知）时退到后续 AC-3 兼容轨', async () => {
  const truehd = fakeTrack({ codec: null, internalCodecId: 'A_TRUEHD' })
  const ac3 = fakeTrack({ codec: 'ac3', internalCodecId: 'A_AC3' })
  const picked = await pickPlayableAudioTrack([truehd, ac3])
  assert.equal(picked.track, ac3)
  assert.equal(picked.config.codec, 'mp4a.40.2')
  assert.deepEqual(picked.unsupportedCodecIds, ['A_TRUEHD'])
})

test('全部音轨不可用时返回 null 并记录原始 CodecID', async () => {
  const tracks = [
    fakeTrack({ codec: null, internalCodecId: 'A_TRUEHD' }),
    fakeTrack({ codec: null, internalCodecId: 'A_MLP' }),
  ]
  const picked = await pickPlayableAudioTrack(tracks)
  assert.equal(picked.track, null)
  assert.equal(picked.config, null)
  assert.deepEqual(picked.unsupportedCodecIds, ['A_TRUEHD', 'A_MLP'])
})

test('getDecoderConfig 抛错的音轨被跳过而非拖垮 demux', async () => {
  const broken = fakeTrack({ codec: 'ac3', throws: true })
  const ok = fakeTrack({ codec: 'eac3', internalCodecId: 'A_EAC3' })
  const picked = await pickPlayableAudioTrack([broken, ok])
  assert.equal(picked.track, ok)
  assert.deepEqual(picked.unsupportedCodecIds, ['ac3'])
})

test('无音轨时返回 null 且不产生 codecIds', async () => {
  const picked = await pickPlayableAudioTrack([])
  assert.equal(picked.track, null)
  assert.deepEqual(picked.unsupportedCodecIds, [])
})

test('mediabunny 1.66 形态：TrueHD 有 decoderConfig 仍被判不可用', async () => {
  // 上游认了 truehd 且给出 mlpa 配置，仅凭「有配置」会误判为可转码，
  // 实际 wasm ffmpeg 只有 audio tier（无 truehd）→ 转码必失败
  const truehd = fakeTrack({
    codec: 'truehd',
    internalCodecId: 'A_TRUEHD',
    config: TRUEHD_DECODER_CONFIG,
  })
  const picked = await pickPlayableAudioTrack([truehd])
  assert.equal(picked.track, null)
  assert.equal(picked.config, null)
  assert.deepEqual(picked.unsupportedCodecIds, ['A_TRUEHD'])
})

test('TrueHD + AC-3 双轨：跳过 TrueHD，选中 AC-3', async () => {
  const tracks = [
    fakeTrack({
      codec: 'truehd',
      internalCodecId: 'A_TRUEHD',
      config: TRUEHD_DECODER_CONFIG,
    }),
    fakeTrack({ codec: 'ac3', internalCodecId: 'A_AC3' }),
  ]
  const picked = await pickPlayableAudioTrack(tracks)
  assert.equal(picked.track, tracks[1])
  assert.deepEqual(picked.unsupportedCodecIds, ['A_TRUEHD'])
})

test('管线可处理的编码全部能被选中', async () => {
  for (const codec of ['aac', 'opus', 'mp3', 'flac', 'ac3', 'eac3', 'dts']) {
    const track = fakeTrack({ codec })
    const picked = await pickPlayableAudioTrack([track])
    assert.equal(picked.track, track, `${codec} 应可用`)
  }
})

test('白名单外编码（vorbis / PCM）跳过，不送进没有解码器的转码链', async () => {
  const tracks = [fakeTrack({ codec: 'vorbis' }), fakeTrack({ codec: 'pcm-s16' })]
  const picked = await pickPlayableAudioTrack(tracks)
  assert.equal(picked.track, null)
  assert.deepEqual(picked.unsupportedCodecIds, ['vorbis', 'pcm-s16'])
})

test('音频包存在但无 decoderConfig：mux 不抛错，产出纯视频 fMP4', async () => {
  const { video, audio } = makePackets()
  const result = await muxToFmp4({
    videoPackets: video,
    audioPackets: audio,
    videoCodec: 'avc',
    audioCodec: 'aac',
    videoDecoderConfig: VIDEO_DECODER_CONFIG,
    audioDecoderConfig: null,
  })
  assert.ok(result.init.byteLength > 0)
  assert.ok(result.media.length > 0)
  assert.deepEqual(await trackKinds(result.init), ['video'])
})

test('有 decoderConfig 时正常建音轨（对照组）', async () => {
  const { video, audio } = makePackets()
  const result = await muxToFmp4({
    videoPackets: video,
    audioPackets: audio,
    videoCodec: 'avc',
    audioCodec: 'aac',
    videoDecoderConfig: VIDEO_DECODER_CONFIG,
    audioDecoderConfig: AUDIO_DECODER_CONFIG,
  })
  assert.deepEqual(await trackKinds(result.init), ['video', 'audio'])
})
