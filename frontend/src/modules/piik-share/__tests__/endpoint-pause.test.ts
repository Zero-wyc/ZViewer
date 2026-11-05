/**
 * 暂停共享时，出边必须真的停发。
 *
 * 服务端的 `set-sharing-paused` 只挂起路由树，直连边上的媒体不经过它，
 * 它停不了包。如果发送端只发消息不摘轨，房主界面显示「已暂停」，观众
 * 那边画面照旧在动——这是真机上最容易漏掉的一条。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ShareEndpoint } from '../endpoint.ts'
import type { PiikRouteUpdate } from '../../piik-signal/protocol.ts'

class FakeSender {
  track: { kind: string } | null
  calls: Array<string | null> = []

  constructor(track: { kind: string }) {
    this.track = track
  }

  async replaceTrack(track: { kind: string } | null): Promise<void> {
    this.calls.push(track?.kind ?? null)
    this.track = track
  }
}

class FakeTransceiver {
  direction = 'sendonly'
  sender: FakeSender
  receiver: { track: { kind: string } }

  constructor(kind: string) {
    this.sender = new FakeSender({ kind })
    this.receiver = { track: { kind } }
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  connectionState = 'new'
  onicecandidate: ((event: { candidate: null }) => void) | null = null
  ontrack: ((event: { track: unknown }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  transceivers: FakeTransceiver[] = []

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  addTrack(track: { kind: string }): void {
    this.transceivers.push(new FakeTransceiver(track.kind))
  }

  getSenders(): FakeSender[] {
    return this.transceivers.map((item) => item.sender)
  }

  getTransceivers(): FakeTransceiver[] {
    return this.transceivers
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'm=video 9\r\n' }
  }

  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  async getStats(): Promise<Map<string, unknown>> {
    return new Map()
  }
  close(): void {
    this.connectionState = 'closed'
  }
}

class FakeStream {
  tracks: Array<{ kind: string }> = []
  addTrack(track: { kind: string }): void {
    this.tracks.push(track)
  }
  getTracks(): Array<{ kind: string }> {
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

const source = {
  getTracks: () => [{ kind: 'video' }, { kind: 'audio' }],
}

/** 建一条出边（我是父）。 */
async function outbound(): Promise<{
  endpoint: ShareEndpoint
  pc: FakePeerConnection
}> {
  const endpoint = new ShareEndpoint({ iceServers: [] }, source as never, {
    send: () => true,
    onStream: () => {},
    onStateChange: () => {},
  })
  const update: PiikRouteUpdate = {
    type: 'route-update',
    revision: 1,
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

test('暂停时把视频与音频轨都摘掉', async () => {
  const restore = installFake()
  try {
    const { endpoint, pc } = await outbound()
    assert.equal(pc.transceivers.length, 2, '视频与音频各一条 sender')

    await endpoint.setSending(true)
    for (const transceiver of pc.transceivers) {
      assert.equal(transceiver.sender.track, null)
      assert.deepEqual(transceiver.sender.calls, [null])
    }
  } finally {
    restore()
  }
})

test('恢复时换回当前流里对应的轨', async () => {
  const restore = installFake()
  try {
    const { endpoint, pc } = await outbound()
    await endpoint.setSending(true)
    await endpoint.setSending(false)
    const kinds = pc.transceivers.map((item) => item.sender.track?.kind)
    assert.deepEqual(kinds, ['video', 'audio'])
  } finally {
    restore()
  }
})

test('暂停期间新建的边立刻停发', async () => {
  const restore = installFake()
  try {
    const { endpoint } = await outbound()
    await endpoint.setSending(true)

    endpoint.handle({
      type: 'route-update',
      revision: 2,
      phase: 'prepare',
      assignment: { upstream: undefined, childPeerIds: ['child', 'child2'] },
      candidate: {
        childPeerId: 'child2',
        connectionId: 'conn-2',
        transport: 'direct',
        qualityProbe: false,
      },
    } as PiikRouteUpdate)
    await flush()

    const second = FakePeerConnection.instances[1]
    assert.ok(second, '第二条边应当建出来')
    for (const transceiver of second.transceivers) {
      assert.equal(transceiver.sender.track, null)
    }
  } finally {
    restore()
  }
})

test('暂停中换源不会把画面挂回去，恢复后才用新流', async () => {
  const restore = installFake()
  try {
    const { endpoint, pc } = await outbound()
    await endpoint.setSending(true)

    const replaced = { getTracks: () => [{ kind: 'video' }] }
    await endpoint.replaceLocalStream(replaced as never)
    assert.equal(
      pc.transceivers[0].sender.track,
      null,
      '暂停中换源不该恢复发送'
    )

    await endpoint.setSending(false)
    assert.equal(pc.transceivers[0].sender.track?.kind, 'video')
    // 新流里没有音频，音频那条保持静音而不是硬塞旧轨。
    assert.equal(pc.transceivers[1].sender.track, null)
  } finally {
    restore()
  }
})
