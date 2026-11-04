/**
 * 端点的编码回读与健康采样。
 *
 * 这两件事都是「浏览器说了什么」的取证：`setParameters` 只是请求，
 * 回读才知道浏览器改没改；`getStats` 的增量才知道编码器跟不跟得上。
 * 用假 PC 把两种「浏览器行为」写死，断言端点如实转述。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ShareEndpoint } from '../endpoint.ts'
import type {
  PiikClientMessage,
  PiikRouteUpdate,
} from '../../piik-signal/protocol.ts'
import type { QualityProfile } from '../../screen-sharing/core/quality'

const profile: QualityProfile = {
  resolution: { width: 1280, height: 720 },
  maxFramerate: 30,
  maxBitrate: 4_000_000,
  degradationPreference: 'balanced',
  maxAudioBitrate: 128_000,
}

/** 假视频 sender：按 `clampBitrate` 模拟「浏览器自行改小码率」。 */
class FakeVideoSender {
  private parameters = {
    transactionId: 'tx',
    encodings: [{} as RTCRtpEncodingParameters],
    codecs: [],
    headerExtensions: [],
  } as unknown as RTCRtpSendParameters

  private readonly clampBitrate: number | null
  readonly track: {
    kind: string
    getSettings: () => { width: number; height: number }
  }

  constructor(clampBitrate: number | null) {
    this.clampBitrate = clampBitrate
    this.track = {
      kind: 'video',
      getSettings: () => ({ width: 1920, height: 1080 }),
    }
  }

  getParameters(): RTCRtpSendParameters {
    return this.parameters
  }

  async setParameters(next: RTCRtpSendParameters): Promise<void> {
    if (this.clampBitrate !== null) {
      for (const encoding of next.encodings) {
        encoding.maxBitrate = Math.min(
          encoding.maxBitrate ?? this.clampBitrate,
          this.clampBitrate
        )
      }
    }
    this.parameters = next
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  connectionState = 'new'
  onicecandidate: ((event: { candidate: null }) => void) | null = null
  ontrack: ((event: { track: unknown }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  senders: FakeVideoSender[] = []
  stats = new Map<string, unknown>()

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  addTrack(): void {}
  getSenders(): FakeVideoSender[] {
    return this.senders
  }

  async getStats(): Promise<Map<string, unknown>> {
    return this.stats
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'm=video 9\r\n' }
  }

  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.connectionState = 'closed'
  }
}

class FakeStream {
  tracks: unknown[] = []
  addTrack(track: unknown): void {
    this.tracks.push(track)
  }
  getTracks(): unknown[] {
    return this.tracks
  }
}

function installFake(): () => void {
  const store = globalThis as unknown as Record<string, unknown>
  const previousPc = store.RTCPeerConnection
  const previousStream = store.MediaStream
  store.RTCPeerConnection = FakePeerConnection
  store.MediaStream = FakeStream
  FakePeerConnection.instances = []
  return () => {
    store.RTCPeerConnection = previousPc
    store.MediaStream = previousStream
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 让端点建一条出边（我是父，下游是 child）。 */
async function outboundEdge(): Promise<{
  endpoint: ShareEndpoint
  pc: FakePeerConnection
}> {
  const sent: PiikClientMessage[] = []
  const endpoint = new ShareEndpoint({ iceServers: [] }, null, {
    send: (message) => {
      sent.push(message)
      return true
    },
    onStream: () => {},
    onStateChange: () => {},
  })
  const update: PiikRouteUpdate = {
    type: 'route-update',
    revision: 2,
    phase: 'prepare',
    assignment: { upstream: undefined, childPeerIds: ['child'] },
    candidate: {
      childPeerId: 'child',
      connectionId: 'conn-1',
      transport: 'direct',
      qualityProbe: false,
    },
  }
  endpoint.handle(update)
  await flush()
  const pc = FakePeerConnection.instances[0]
  assert.ok(pc, '应当建出一条出边')
  return { endpoint, pc }
}

test('浏览器改小码率时，回读要如实报告', async () => {
  const restore = installFake()
  try {
    const { endpoint, pc } = await outboundEdge()
    pc.senders = [new FakeVideoSender(1_000_000)]

    const [readback] = await endpoint.applyEncoding(profile)
    assert.ok(readback, '每条出边都要有一份回读')
    assert.equal(readback.requested.maxBitrate, 4_000_000)
    assert.equal(readback.applied.maxBitrate, 1_000_000)
    assert.deepEqual(readback.mismatches, ['maxBitrate'])
    // 降采样是算出来的：1920/1280 = 1.5，用来在不重采集的前提下缩画面。
    assert.equal(readback.applied.scaleResolutionDownBy, 1.5)
  } finally {
    restore()
  }
})

test('浏览器照办时没有不一致', async () => {
  const restore = installFake()
  try {
    const { endpoint, pc } = await outboundEdge()
    pc.senders = [new FakeVideoSender(null)]

    const [readback] = await endpoint.applyEncoding(profile)
    assert.deepEqual(readback.mismatches, [])
    assert.equal(readback.applied.maxFramerate, 30)
    assert.equal(readback.applied.maxBitrate, 4_000_000)
  } finally {
    restore()
  }
})

test('采样取 outbound-rtp 的编码增量与 media-source 的采集帧数', async () => {
  const restore = installFake()
  try {
    const { endpoint, pc } = await outboundEdge()
    pc.stats = new Map<string, unknown>([
      [
        'out',
        {
          type: 'outbound-rtp',
          kind: 'video',
          id: 'out',
          framesEncoded: 120,
          mediaSourceId: 'src',
          qualityLimitationReason: 'bandwidth',
        },
      ],
      ['src', { type: 'media-source', frames: 150 }],
      // 音频那条不该被算进来。
      [
        'audio',
        {
          type: 'outbound-rtp',
          kind: 'audio',
          id: 'audio',
          framesEncoded: 999,
        },
      ],
    ])

    const [sample] = await endpoint.healthSamples()
    assert.equal(sample.connectionId, 'conn-1')
    assert.equal(sample.outboundId, 'out')
    assert.equal(sample.sourceId, 'src')
    assert.equal(sample.framesEncoded, 120)
    assert.equal(sample.sourceFrames, 150)
    assert.equal(sample.limitation, 'bandwidth')
  } finally {
    restore()
  }
})

test('没有出边时，采样与回读都是空数组', async () => {
  const restore = installFake()
  try {
    const endpoint = new ShareEndpoint({ iceServers: [] }, null, {
      send: () => true,
      onStream: () => {},
      onStateChange: () => {},
    })
    assert.deepEqual(await endpoint.healthSamples(), [])
    assert.deepEqual(await endpoint.applyEncoding(profile), [])
  } finally {
    restore()
  }
})
