/**
 * 共享端点的 SFU 中转行为。
 *
 * 服务端按「直连优先、sfu 兜底」下发候选。sfu 候选本身没有 SDP：
 *   - 房主收到 `sfu-config` 后自己 offer，并声明单层媒体；
 *   - 观众收到的是服务端推来的 offer，只负责 answer；
 *   - 连上后仍由观众发 `route-ready` 结算；
 *   - SFU 失败只关本地连接，**不**上报 `route-failed`（服务端按超时判定）。
 *
 * 这里用最小的假 RTCPeerConnection 覆盖这几条。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ShareEndpoint } from '../endpoint.ts'
import type {
  PiikClientMessage,
  PiikRouteUpdate,
  PiikSfuSignalMessage,
} from '../../piik-signal/protocol.ts'

interface FakeTrack {
  kind: string
  getSettings: () => { width?: number; height?: number }
}

class FakeSender {
  track: FakeTrack | null

  constructor(track: FakeTrack | null) {
    this.track = track
  }

  async replaceTrack(track: FakeTrack | null): Promise<void> {
    this.track = track
  }
}

class FakeTransceiver {
  direction: string
  sender: FakeSender
  receiver: { track: FakeTrack }

  constructor(track: FakeTrack, direction: string) {
    this.direction = direction
    this.sender = new FakeSender(track)
    this.receiver = { track }
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  connectionState = 'new'
  closed = false
  transceivers: FakeTransceiver[] = []
  remoteDescriptions: { type: string; sdp: string }[] = []
  iceCandidates: unknown[] = []
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null
  ontrack: ((event: { track: FakeTrack }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  addTransceiver(track: FakeTrack, init: { direction: string }): void {
    this.transceivers.push(new FakeTransceiver(track, init.direction))
  }

  getTransceivers(): FakeTransceiver[] {
    return this.transceivers
  }

  getSenders(): FakeSender[] {
    return this.transceivers.map((item) => item.sender)
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'm=video 9\r\n' }
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'm=video 9\r\n' }
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(description: {
    type: string
    sdp: string
  }): Promise<void> {
    this.remoteDescriptions.push(description)
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    this.iceCandidates.push(candidate)
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }

  reach(state: string): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
}

class FakeStream {
  tracks: unknown[] = []

  addTrack(track: unknown): void {
    if (!this.tracks.includes(track)) this.tracks.push(track)
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

function sfuPrepare(
  revision: number,
  publicationGeneration: string,
  connectionId: string,
  role: 'publisher' | 'subscriber'
): PiikRouteUpdate {
  return {
    type: 'route-update',
    revision,
    phase: 'prepare',
    assignment: {
      upstream: role === 'subscriber' ? { kind: 'sfu' } : { kind: 'none' },
      childPeerIds: role === 'publisher' ? ['viewer-1'] : [],
      sfuPublicationGeneration: publicationGeneration,
    },
    candidate: {
      childPeerId: role === 'publisher' ? 'viewer-1' : 'me',
      connectionId,
      transport: 'sfu',
      qualityProbe: false,
    },
  }
}

function harness(localStream: MediaStream | null = null) {
  const sent: PiikClientMessage[] = []
  const states: { connectionId: string; state: string }[] = []
  const streams: { connectionId: string; stream: unknown }[] = []
  const endpoint = new ShareEndpoint({ iceServers: [] }, localStream, {
    send: (message) => {
      sent.push(message)
      return true
    },
    onStream: (connectionId, stream) => streams.push({ connectionId, stream }),
    onStateChange: (connectionId, state) =>
      states.push({ connectionId, state }),
  })
  return { endpoint, sent, states, streams }
}

function sfuMessages(sent: PiikClientMessage[]): PiikSfuSignalMessage[] {
  return sent.filter(
    (message) => message.type === 'sfu-signal'
  ) as PiikSfuSignalMessage[]
}

test('房主收到 sfu-config 后推视频并声明单层媒体', async () => {
  const restore = installFake()
  try {
    const video: FakeTrack = {
      kind: 'video',
      getSettings: () => ({ width: 1280, height: 720 }),
    }
    const local = new FakeStream()
    local.addTrack(video)
    const { endpoint, sent } = harness(local as unknown as MediaStream)

    endpoint.handle(sfuPrepare(7, 'gen-1', 'conn-viewer', 'publisher'))
    endpoint.handle({
      type: 'sfu-config',
      revision: 7,
      publicationGeneration: 'gen-1',
      connectionId: 'gen-1',
    } as never)
    await flush()

    const pc = FakePeerConnection.instances[0]
    assert.ok(pc, '收到 sfu-config 后应建发布连接')
    assert.equal(pc.transceivers.length, 1)
    assert.equal(pc.transceivers[0].direction, 'sendonly')
    assert.equal(pc.transceivers[0].sender.track, video)

    const [offer] = sfuMessages(sent)
    assert.ok(offer, '房主要自己发 offer')
    assert.equal(offer.kind, 'description')
    assert.equal(offer.description?.type, 'offer')
    assert.equal(offer.revision, 7)
    assert.equal(offer.publicationGeneration, 'gen-1')
    assert.equal(offer.connectionId, 'gen-1')
    assert.equal(offer.media?.codec, 'vp8')
    assert.deepEqual(offer.media?.layers, [
      { rid: '', width: 1280, height: 720, bitrate: 4_000_000 },
    ])
    assert.equal(offer.media?.audio, false)
    assert.equal(offer.media?.audioBitrate, 0)
  } finally {
    restore()
  }
})

test('房主本地候选走 sfu-signal，answer 前收到的候选先攒着', async () => {
  const restore = installFake()
  try {
    const video: FakeTrack = {
      kind: 'video',
      getSettings: () => ({ width: 640, height: 360 }),
    }
    const local = new FakeStream()
    local.addTrack(video)
    const { endpoint, sent } = harness(local as unknown as MediaStream)

    endpoint.handle(sfuPrepare(7, 'gen-1', 'conn-viewer', 'publisher'))
    endpoint.handle({
      type: 'sfu-config',
      revision: 7,
      publicationGeneration: 'gen-1',
      connectionId: 'gen-1',
    } as never)
    await flush()
    const pc = FakePeerConnection.instances[0]

    pc.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: 'candidate:1', sdpMid: '0' }) },
    })
    const candidates = sfuMessages(sent).filter(
      (message) => message.kind === 'candidate'
    )
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].connectionId, 'gen-1')
    assert.deepEqual(candidates[0].candidate, {
      candidate: 'candidate:1',
      sdpMid: '0',
    })

    // answer 还没到：候选先入队，不直接下发给连接。
    endpoint.handle({
      type: 'sfu-signal',
      revision: 7,
      publicationGeneration: 'gen-1',
      connectionId: 'gen-1',
      kind: 'candidate',
      candidate: { candidate: 'candidate:2', sdpMid: '0' },
    } as never)
    assert.equal(pc.iceCandidates.length, 0)

    endpoint.handle({
      type: 'sfu-signal',
      revision: 7,
      publicationGeneration: 'gen-1',
      connectionId: 'gen-1',
      kind: 'description',
      description: { type: 'answer', sdp: 'answer-sdp' },
    } as never)
    await flush()

    assert.equal(pc.remoteDescriptions[0].type, 'answer')
    assert.equal(pc.iceCandidates.length, 1, 'answer 到达后要补发攒下的候选')
  } finally {
    restore()
  }
})

test('观众应答服务端的 offer，并把轨道接到 onStream', async () => {
  const restore = installFake()
  try {
    const { endpoint, sent, streams } = harness()

    endpoint.handle(sfuPrepare(9, 'gen-1', 'conn-sub', 'subscriber'))
    endpoint.handle({
      type: 'sfu-config',
      revision: 9,
      publicationGeneration: 'gen-1',
      connectionId: 'conn-sub',
    } as never)
    await flush()
    assert.equal(
      FakePeerConnection.instances.length,
      0,
      '观众拿到配置后不主动建连接，等服务端 offer'
    )

    endpoint.handle({
      type: 'sfu-signal',
      revision: 9,
      publicationGeneration: 'gen-1',
      connectionId: 'conn-sub',
      kind: 'description',
      description: { type: 'offer', sdp: 'offer-sdp' },
    } as never)
    await flush()

    const pc = FakePeerConnection.instances[0]
    assert.ok(pc, '服务端 offer 到达后应建订阅连接')
    assert.equal(pc.remoteDescriptions[0].type, 'offer')

    const answer = sfuMessages(sent).find(
      (message) => message.kind === 'description'
    )
    assert.ok(answer)
    assert.equal(answer.description?.type, 'answer')
    assert.equal(answer.revision, 9)
    assert.equal(answer.publicationGeneration, 'gen-1')
    assert.equal(answer.connectionId, 'conn-sub')
    assert.equal(answer.media, undefined, 'answer 不许带 media')

    const video: FakeTrack = { kind: 'video', getSettings: () => ({}) }
    pc.ontrack?.({ track: video })
    assert.equal(streams.length, 1)
    assert.equal(streams[0].connectionId, 'conn-sub')

    pc.reach('connected')
    const ready = sent.filter((message) => message.type === 'route-ready')
    assert.equal(ready.length, 1, '订阅端连上要结算一次')
    assert.equal(
      (ready[0] as { revision?: number }).revision,
      9,
      'revision 用 sfu 消息里的门闩'
    )
  } finally {
    restore()
  }
})

test('SFU 失败只关本地连接，不上报 route-failed', async () => {
  const restore = installFake()
  try {
    const { endpoint, sent, states } = harness()
    endpoint.handle(sfuPrepare(3, 'gen-2', 'conn-sub', 'subscriber'))
    endpoint.handle({
      type: 'sfu-signal',
      revision: 3,
      publicationGeneration: 'gen-2',
      connectionId: 'conn-sub',
      kind: 'description',
      description: { type: 'offer', sdp: 'offer-sdp' },
    } as never)
    await flush()

    const pc = FakePeerConnection.instances[0]
    pc.reach('failed')

    assert.equal(pc.closed, true)
    assert.deepEqual(
      sent.filter((message) => message.type === 'route-failed'),
      [],
      '重复上报会把服务端的重分配判死'
    )
    assert.ok(states.some((item) => item.state === 'closed'))
  } finally {
    restore()
  }
})

test('close() 会关掉 SFU 连接', async () => {
  const restore = installFake()
  try {
    const video: FakeTrack = { kind: 'video', getSettings: () => ({}) }
    const local = new FakeStream()
    local.addTrack(video)
    const { endpoint } = harness(local as unknown as MediaStream)
    endpoint.handle(sfuPrepare(1, 'gen-3', 'gen-3', 'publisher'))
    endpoint.handle({
      type: 'sfu-config',
      revision: 1,
      publicationGeneration: 'gen-3',
      connectionId: 'gen-3',
    } as never)
    await flush()

    const pc = FakePeerConnection.instances[0]
    endpoint.close()
    assert.equal(pc.closed, true)
  } finally {
    restore()
  }
})
