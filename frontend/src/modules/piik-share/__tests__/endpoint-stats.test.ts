/**
 * 端点的逐边统计。
 *
 * 统计面板从「一条 PC」换成「每条边」之后，最容易错的是**基线共享**：
 * 两条边的累计计数器各走各的，共用一份基线会互相减出负数，帧率和码率直接
 * 变成荒唐值。这里用假 PC 把两条边摆出来，断言它们各自独立。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ShareEndpoint } from '../endpoint.ts'
import type { PiikRouteUpdate } from '../../piik-signal/protocol.ts'

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  connectionState = 'connected'
  onicecandidate: ((event: { candidate: null }) => void) | null = null
  ontrack: ((event: { track: unknown }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  stats = new Map<string, unknown>()

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  addTrack(): void {}
  getSenders(): unknown[] {
    return []
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
  addTrack(): void {}
  getTracks(): unknown[] {
    return []
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

/** 一条出边（我是父，下游是观众），按给定的候选建 PC。 */
function makeEndpoint(): ShareEndpoint {
  return new ShareEndpoint({ iceServers: [] }, null, {
    send: () => true,
    onStream: () => {},
    onStateChange: () => {},
  })
}

async function addOutboundEdge(
  endpoint: ShareEndpoint,
  connectionId: string,
  childPeerId: string
): Promise<void> {
  const update: PiikRouteUpdate = {
    type: 'route-update',
    revision: 2,
    phase: 'prepare',
    assignment: { upstream: undefined, childPeerIds: [childPeerId] },
    candidate: {
      childPeerId,
      connectionId,
      transport: 'direct',
      qualityProbe: false,
    },
  }
  endpoint.handle(update)
  await flush()
}

/** 一份出边统计：累计计数器 + 观众回传的接收报告。 */
function outboundReport(options: {
  bytesSent: number
  framesEncoded: number
  packetsSent: number
  packetsLost: number
  timestamp: number
  roundTripTime: number
}): Map<string, unknown> {
  return new Map<string, unknown>([
    [
      'out',
      {
        type: 'outbound-rtp',
        kind: 'video',
        id: 'out',
        bytesSent: options.bytesSent,
        framesEncoded: options.framesEncoded,
        packetsSent: options.packetsSent,
        timestamp: options.timestamp,
        frameWidth: 1920,
        frameHeight: 1080,
        qualityLimitationReason: 'none',
      },
    ],
    [
      'pair',
      {
        type: 'candidate-pair',
        id: 'pair',
        nominated: true,
        state: 'succeeded',
        currentRoundTripTime: options.roundTripTime,
      },
    ],
    [
      'rem',
      {
        type: 'remote-inbound-rtp',
        kind: 'video',
        id: 'rem',
        localId: 'out',
        packetsLost: options.packetsLost,
        jitter: 0.004,
        roundTripTime: options.roundTripTime,
      },
    ],
  ])
}

test('第一次采样只建基线，第二次才给出窗口速率', async () => {
  const restore = installFake()
  try {
    const endpoint = makeEndpoint()
    await addOutboundEdge(endpoint, 'conn-1', 'viewer-1')
    const pc = FakePeerConnection.instances[0]
    assert.ok(pc)

    pc.stats = outboundReport({
      bytesSent: 1_000,
      framesEncoded: 10,
      packetsSent: 100,
      packetsLost: 2,
      timestamp: 1_000,
      roundTripTime: 0.05,
    })
    const [first] = await endpoint.stats()
    assert.equal(first.connectionId, 'conn-1')
    assert.equal(first.direction, 'outbound')
    assert.equal(first.state, 'connected')
    // 没有上一份基线，窗口值只能是 null——不能拿累计值冒充速率。
    assert.equal(first.stats.bitrate, null)
    assert.equal(first.stats.frameRate, null)
    assert.equal(first.stats.rttMs, 50)
    assert.equal(first.stats.resolution?.width, 1920)
    assert.equal(first.quality?.packetsLost, 2)

    // 1 秒后：+225KB（1.8 Mbps）、+30 帧（30 fps）、+300 包、+3 丢包。
    pc.stats = outboundReport({
      bytesSent: 226_000,
      framesEncoded: 40,
      packetsSent: 400,
      packetsLost: 5,
      timestamp: 2_000,
      roundTripTime: 0.06,
    })
    const [second] = await endpoint.stats()
    assert.equal(second.stats.bitrate, 1_800_000)
    assert.equal(second.stats.frameRate, 30)
    assert.equal(second.stats.rttMs, 60)
    // 观众回传的丢包：3 / (300 + 3)。
    assert.ok(
      Math.abs((second.quality?.packetLossRate ?? 0) - 3 / 303) < 1e-9,
      `丢包率应为 3/303，实际 ${second.quality?.packetLossRate}`
    )
  } finally {
    restore()
  }
})

test('两条边的基线互不干扰', async () => {
  const restore = installFake()
  try {
    const endpoint = makeEndpoint()
    await addOutboundEdge(endpoint, 'conn-1', 'viewer-1')
    await addOutboundEdge(endpoint, 'conn-2', 'viewer-2')
    const [pc1, pc2] = FakePeerConnection.instances
    assert.ok(pc1 && pc2)

    // 两位观众的连接建立时间不同：一条已经发了 10 秒，另一条刚开。
    pc1.stats = outboundReport({
      bytesSent: 10_000_000,
      framesEncoded: 300,
      packetsSent: 10_000,
      packetsLost: 1,
      timestamp: 10_000,
      roundTripTime: 0.04,
    })
    pc2.stats = outboundReport({
      bytesSent: 100,
      framesEncoded: 5,
      packetsSent: 20,
      packetsLost: 9,
      // 时间戳也差得多：共用基线会把这条边的窗口算成 9 秒。
      timestamp: 1_000,
      roundTripTime: 0.2,
    })
    await endpoint.stats()

    pc1.stats = outboundReport({
      bytesSent: 10_250_000,
      framesEncoded: 330,
      packetsSent: 10_300,
      packetsLost: 1,
      timestamp: 11_000,
      roundTripTime: 0.04,
    })
    pc2.stats = outboundReport({
      bytesSent: 250_100,
      framesEncoded: 35,
      packetsSent: 320,
      packetsLost: 9,
      timestamp: 2_000,
      roundTripTime: 0.2,
    })
    const list = await endpoint.stats()
    const a = list.find((item) => item.connectionId === 'conn-1')
    const b = list.find((item) => item.connectionId === 'conn-2')
    assert.ok(a && b)
    // 两条边各 1 秒窗口：1.8 Mbps / 30 fps，与「谁先连上」无关。
    assert.equal(a.stats.bitrate, 2_000_000)
    assert.equal(a.stats.frameRate, 30)
    assert.equal(b.stats.bitrate, 2_000_000)
    assert.equal(b.stats.frameRate, 30)
  } finally {
    restore()
  }
})
