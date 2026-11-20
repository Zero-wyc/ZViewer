/**
 * playsvideo 纯音频容器支持回归测试。
 *
 * 背景：上游 demux 第一行就是 `if (!videoTrack) throw new Error('No video
 * track found')`，把「没有视频轨」当成致命错误。但整条管线本身是
 * track-agnostic 的——分段按时间切、mux 按存在的轨道建轨、MSE 认纯音频
 * fMP4。ZViewer 允许把纯音频文件当影片源挂载（一起看投播客/有声书、
 * 影片库里混入 m4a），硬报错会让这类源完全不可播。
 *
 * 修复涉及五处：
 * 1. demux：videoTrack / videoCodec / videoSink / videoDecoderConfig 可空，
 *    duration 回退到音频轨；
 * 2. getKeyframeIndex / collectPacketsInRange：sink 为 null 时返回空，
 *    而不是 `Cannot read properties of null`；
 * 3. segment-plan：无关键帧时按目标时长合成边界（音频帧都是同步点），
 *    否则整首歌退化成单个 segment，seek 要重取全长；
 * 4. mux：无视频包时不建视频轨；两者都空时给可读错误而非 muxer 内部异常；
 * 5. playback-selection：纯音频不再判 blocked，按音频-only 继续评估。
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
import { collectPacketsInRange, getKeyframeIndex } from '../vendor/playsvideo/dist/pipeline/demux.js'
import {
  buildSegmentPlan,
  synthesizeSegmentBoundaries,
} from '../vendor/playsvideo/dist/pipeline/segment-plan.js'
import { evaluatePlaybackOptions } from '../vendor/playsvideo/dist/playback-selection.js'

/** AAC-LC 48kHz 立体声的 AudioSpecificConfig */
const ASC = new Uint8Array([0x12, 0x10])
const AUDIO_DECODER_CONFIG = {
  codec: 'mp4a.40.2',
  numberOfChannels: 2,
  sampleRate: 48000,
  description: ASC,
}

/** 造一段假音频包（数据内容无关紧要，只需结构合法） */
function audioPackets(count, startSec = 0, duration = 0.02) {
  const data = new Uint8Array(64).fill(7)
  return Array.from({ length: count }, (_, i) =>
    new EncodedPacket(data, 'key', startSec + i * duration, duration)
  )
}

/** 读回 fMP4 init 段里的轨道类型 */
async function trackKinds(init) {
  const input = new Input({ source: new BufferSource(init), formats: ALL_FORMATS })
  try {
    const tracks = await input.getTracks()
    return tracks.map((t) =>
      t.isVideoTrack() ? 'video' : t.isAudioTrack() ? 'audio' : 'other'
    )
  } finally {
    input.dispose()
  }
}

// ── 分段边界合成 ─────────────────────────────────────────────

test('合成边界：20s / 4s 目标 → 5 段整齐切分', () => {
  assert.deepEqual(synthesizeSegmentBoundaries(20, 4), [0, 4, 8, 12, 16])
})

test('合成边界：短于一个目标时长 → 只有起点（整段一段）', () => {
  assert.deepEqual(synthesizeSegmentBoundaries(1.2, 4), [0])
})

test('合成边界：末尾余量不足时不产出极短尾段', () => {
  // 20.017s 若不设余量会多出 20.0 这个边界，归一化后得到 0.017s 的尾段，
  // 该段取不到任何包 → mux 抛「没有可封装的轨道」→ 整片失败
  const bounds = synthesizeSegmentBoundaries(20.017, 4)
  assert.equal(bounds[bounds.length - 1], 16, '最后一个边界应是 16 而不是 20')
})

test('合成边界：非法时长退化为单起点', () => {
  for (const bad of [0, -1, Number.NaN, Infinity]) {
    assert.deepEqual(synthesizeSegmentBoundaries(bad, 4), [0], `duration=${bad}`)
  }
})

test('合成边界喂给 buildSegmentPlan：覆盖全时长且不留极短尾段', () => {
  const duration = 20.017
  const plan = buildSegmentPlan({
    keyframeTimestampsSec: synthesizeSegmentBoundaries(duration, 4),
    durationSec: duration,
    targetSegmentDurationSec: 4,
  })
  assert.equal(plan.length, 5)
  assert.equal(plan[0].startSec, 0)
  const total = plan.reduce((sum, s) => sum + s.durationSec, 0)
  assert.ok(Math.abs(total - duration) < 1e-6, `总时长 ${total} 应等于 ${duration}`)
  for (const seg of plan) {
    assert.ok(seg.durationSec > 0.2, `段长 ${seg.durationSec}s 不应过短`)
  }
})

test('无关键帧且不合成时：整片退化成单段（对照组，说明为何要合成）', () => {
  const plan = buildSegmentPlan({
    keyframeTimestampsSec: [],
    durationSec: 20,
    targetSegmentDurationSec: 4,
  })
  assert.equal(plan.length, 1)
})

// ── 空 sink 的容错 ───────────────────────────────────────────

test('getKeyframeIndex(null)：返回空索引而不是抛错', async () => {
  const index = await getKeyframeIndex(null, 20)
  assert.equal(index.duration, 20)
  assert.deepEqual(index.keyframes, [])
})

test('collectPacketsInRange(null)：返回空数组而不是抛错', async () => {
  assert.deepEqual(await collectPacketsInRange(null, 0, 4), [])
  assert.deepEqual(await collectPacketsInRange(null, 0, 4, { startFromKeyframe: true }), [])
})

// ── 封装：无视频轨 ───────────────────────────────────────────

test('mux 纯音频：只建音频轨，不建视频轨', async () => {
  const res = await muxToFmp4({
    videoPackets: [],
    audioPackets: audioPackets(20),
    videoCodec: null,
    audioCodec: 'aac',
    videoDecoderConfig: null,
    audioDecoderConfig: AUDIO_DECODER_CONFIG,
  })
  assert.ok(res.init.byteLength > 0)
  assert.ok(res.media.length > 0)
  assert.deepEqual(await trackKinds(res.init), ['audio'])
})

test('mux 纯视频：只建视频轨（原有行为不回归）', async () => {
  const data = new Uint8Array(64).fill(7)
  const res = await muxToFmp4({
    videoPackets: [
      new EncodedPacket(data, 'key', 0, 0.04),
      new EncodedPacket(data, 'delta', 0.04, 0.04),
    ],
    audioPackets: [],
    videoCodec: 'avc',
    audioCodec: null,
    videoDecoderConfig: {
      codec: 'avc1.640028',
      codedWidth: 320,
      codedHeight: 240,
      description: new Uint8Array([
        0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28,
        0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80,
      ]),
    },
    audioDecoderConfig: null,
  })
  assert.deepEqual(await trackKinds(res.init), ['video'])
})

test('mux 两条轨都空：给可读错误，不外泄 muxer 内部异常', async () => {
  await assert.rejects(
    () =>
      muxToFmp4({
        videoPackets: [],
        audioPackets: [],
        videoCodec: null,
        audioCodec: null,
        videoDecoderConfig: null,
        audioDecoderConfig: null,
      }),
    /没有可封装的音视频轨/
  )
})

// ── 播放路径选择 ─────────────────────────────────────────────

/** 不依赖 hls.js 运行时的能力桩：MSE 全支持 */
const CAPS_ALL_SUPPORTED = {
  hlsSupported: true,
  pipelineProbe: {
    canPlayVideo: () => true,
    canPlayAudio: () => true,
  },
}

test('播放路径：纯音频（无视频轨）判为可播，不再是 missing-video-codec', () => {
  const evaluation = evaluatePlaybackOptions({
    options: [{ mode: 'hls' }],
    media: {
      sourceVideoCodec: null,
      sourceAudioCodec: 'aac',
      videoCodec: null,
      audioCodec: 'mp4a.40.2',
    },
    capabilities: CAPS_ALL_SUPPORTED,
  })
  assert.ok(evaluation.recommended, '纯音频应被推荐播放')
  assert.equal(evaluation.recommended.option.mode, 'hls')
  const codes = evaluation.evaluations[0].diagnostics.map((d) => d.code)
  assert.ok(codes.includes('hls-audio-only'), '诊断里应标明 audio-only')
  assert.ok(!codes.includes('hls-missing-video-codec'))
})

test('播放路径：音视频轨都没有时仍判不可播', () => {
  const evaluation = evaluatePlaybackOptions({
    options: [{ mode: 'hls' }],
    media: {
      sourceVideoCodec: null,
      sourceAudioCodec: null,
      videoCodec: null,
      audioCodec: null,
    },
    capabilities: CAPS_ALL_SUPPORTED,
  })
  assert.equal(evaluation.recommended, null)
  assert.equal(evaluation.evaluations[0].status, 'blocked')
})

test('播放路径：纯音频且音轨不支持转码时仍可播（降级为转码 AAC）', () => {
  const evaluation = evaluatePlaybackOptions({
    options: [{ mode: 'hls' }],
    media: {
      sourceVideoCodec: null,
      sourceAudioCodec: 'ac3',
      videoCodec: null,
      audioCodec: 'ac-3',
    },
    capabilities: {
      hlsSupported: true,
      pipelineProbe: { canPlayVideo: () => true, canPlayAudio: () => false },
    },
  })
  assert.ok(evaluation.recommended)
  assert.equal(evaluation.evaluations[0].pipelineAudioRequiresTranscode, true)
})

// ── 直通路径（本地纯音频文件） ───────────────────────────────

test('播放路径：本地纯音频文件可走 direct 直通（不强制进 HLS 管线）', () => {
  const evaluation = evaluatePlaybackOptions({
    options: [{ mode: 'direct-bytes', mimeType: 'audio/mp4', url: 'blob:x' }],
    media: {
      sourceVideoCodec: null,
      sourceAudioCodec: 'aac',
      videoCodec: null,
      audioCodec: 'mp4a.40.2',
    },
    capabilities: {
      hlsSupported: true,
      pipelineProbe: { canPlayVideo: () => true, canPlayAudio: () => true },
      canPlayType: () => 'probably',
    },
  })
  assert.ok(evaluation.recommended)
  assert.equal(evaluation.recommended.option.mode, 'direct-bytes')
})
