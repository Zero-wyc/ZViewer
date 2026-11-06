/**
 * 应答方上行轨的回归测试。
 *
 * 曾经的事故：`receiveSignal` 在回 answer 前会调 `syncSenders` 挂上自己的
 * 发送轨，但用的是成员字段 `this.sourceTrack`，而 `reconcile` 只是把解析器
 * 当参数往下传、从没赋过这个字段。结果空解析器把所有 sender 的 track 设成
 * null，观众「能听见房主，房主听不见我」。
 *
 * 这里用最小的假 RTCPeerConnection 复现那条路径：先 reconcile 建立连接，
 * 再收到服务端 offer，断言 sender 上仍然挂着本地轨。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { VoiceEndpoint } from '../endpoint.ts'
import type { PiikVoiceState } from '../protocol.ts'

class FakeSender {
  track: MediaStreamTrack | null = null
  streams: MediaStream[] = []
  async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
    this.track = track
  }
  setStreams(...streams: MediaStream[]): void {
    this.streams = streams
  }
}

class FakeTransceiver {
  sender = new FakeSender()
  receiver = { track: null }
  direction = 'sendrecv'
  mid: string | null = null
  currentDirection: string | null = 'sendrecv'
  stopped = false
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  transceivers: FakeTransceiver[] = []
  connectionState = 'new'
  signalingState = 'stable'
  localDescription: unknown = null
  closed = false

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  addTrack(track: MediaStreamTrack): FakeSender {
    const transceiver = new FakeTransceiver()
    transceiver.sender.track = track
    transceiver.mid = String(this.transceivers.length)
    this.transceivers.push(transceiver)
    return transceiver.sender
  }

  removeTrack(sender: FakeSender): void {
    sender.track = null
  }

  getSenders(): FakeSender[] {
    return this.transceivers.map((t) => t.sender)
  }

  getTransceivers(): FakeTransceiver[] {
    return this.transceivers
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0' }
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0' }
  }

  async setLocalDescription() {
    this.signalingState = 'stable'
  }

  async setRemoteDescription(description: { type: string; sdp: string }) {
    // 服务端 offer 的 m-line 决定本地要有几条 transceiver：一条音频。
    const mids = (description.sdp.match(/^m=/gm) ?? []).length
    for (let i = this.transceivers.length; i < mids; i += 1) {
      const transceiver = new FakeTransceiver()
      transceiver.mid = String(i)
      transceiver.direction = 'recvonly'
      this.transceivers.push(transceiver)
    }

    this.signalingState = 'stable'
  }

  async addIceCandidate() {}

  addEventListener() {}

  removeEventListener() {}

  close() {
    this.closed = true
  }

  async getStats() {
    return new Map()
  }
}

function installFake() {
  const store = globalThis as unknown as Record<string, unknown>
  const previous = store.RTCPeerConnection
  const previousStream = store.MediaStream
  store.RTCPeerConnection = FakePeerConnection
  // syncSenders 用 `new MediaStream([track])` 给 sender 绑定流，node 没有这个构造器。
  store.MediaStream = class {
    tracks: MediaStreamTrack[]
    constructor(tracks: MediaStreamTrack[] = []) {
      this.tracks = tracks
    }
  }
  FakePeerConnection.instances = []
  return () => {
    store.RTCPeerConnection = previous
    store.MediaStream = previousStream
  }
}

function track(): MediaStreamTrack {
  return {
    kind: 'audio',
    readyState: 'live',
    enabled: true,
  } as MediaStreamTrack
}

function state(send: string[], receive: string[]): PiikVoiceState {
  return {
    type: 'room-voice-state',
    revision: 1,
    enabled: true,
    hostPeerId: 'host-peer',
    members: [],
    publications: [],
    unavailable: [],
    connections: [
      {
        connectionId: 'conn-1',
        parentPeerId: 'host-peer',
        childPeerId: 'me',
        transport: 'peer',
        pending: false,
        revision: 1,
        send,
        receive,
      },
    ],
  }
}

test('观众在回 answer 前把本地麦克风挂到发送轨上', async () => {
  const restore = installFake()
  try {
    const endpoint = new VoiceEndpoint(
      { iceServers: [] },
      {
        signal: () => true,
        report: () => {},
        onTrack: () => {},
        onTrackRemoved: () => {},
        onChange: () => {},
      }
    )
    const mic = track()
    endpoint.setState(state(['my-mic'], ['host-mic']), 'me')
    await endpoint.reconcile(() => mic)

    const pc = FakePeerConnection.instances[0] as unknown as FakePeerConnection
    assert.equal(pc.getSenders()[0].track, mic, 'reconcile 之后应已挂轨')

    // 服务端下发 offer，应答方必须保住这条轨，而不是被空解析器摘掉。
    await endpoint.receive({
      type: 'room-voice-signal',
      connectionId: 'conn-1',
      description: {
        revision: 1,
        sdp: { type: 'offer', sdp: 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
        tracks: [{ mid: '0', publicationId: 'host-mic' }],
      },
    })

    const senders = pc.getSenders()
    assert.ok(
      senders.some((sender) => sender.track === mic),
      '回 answer 之后发送轨不能为空，否则房主听不见观众'
    )
  } finally {
    restore()
  }
})

test('服务端没给 send 授权时不挂轨', async () => {
  const restore = installFake()
  try {
    const endpoint = new VoiceEndpoint(
      { iceServers: [] },
      {
        signal: () => true,
        report: () => {},
        onTrack: () => {},
        onTrackRemoved: () => {},
        onChange: () => {},
      }
    )
    const mic = track()
    endpoint.setState(state([], ['host-mic']), 'me')
    await endpoint.reconcile(() => mic)

    const pc = FakePeerConnection.instances[0] as unknown as FakePeerConnection
    assert.ok(pc.getSenders().every((sender) => sender.track === null))
  } finally {
    restore()
  }
})
