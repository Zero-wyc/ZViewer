/**
 * 共享端点的换父行为。
 *
 * 父节点掉线后，Piik 的 controller 会把子树重新分配。子节点这一侧能观察到的
 * 只有一个东西：`route-update` 里自己的 `assignment.upstream` 换了人。
 * 这时必须
 *   1. 关掉旧父的边（否则旧 MediaStream 一直占着，画面冻在最后一帧）；
 *   2. **不要**发 `route-failed`（报了会把刚做好的重新分配判死）；
 *   3. 等新父的 offer 再建边。
 *
 * 这里用最小的假 RTCPeerConnection 复现这三个断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ShareEndpoint } from '../endpoint.ts'
import type {
  PiikClientMessage,
  PiikRouteUpdate,
} from '../../piik-signal/protocol.ts'

class FakeStream {
  tracks: unknown[] = []
  addTrack(track: unknown): void {
    if (!this.tracks.includes(track)) this.tracks.push(track)
  }
  getTracks(): unknown[] {
    return this.tracks
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  connectionState = 'new'
  closed = false
  senders: { track: unknown }[] = []
  onicecandidate: ((event: { candidate: null }) => void) | null = null
  ontrack: ((event: { track: unknown }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  addTrack(track: unknown): void {
    this.senders.push({ track })
  }

  getSenders(): { track: unknown }[] {
    return this.senders
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'm=video 9\r\n' }
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'm=video 9\r\n' }
  }

  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
  }

  /** 测试驱动：把连接推到某个状态并触发回调。 */
  reach(state: string): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
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

function prepare(
  revision: number,
  childPeerId: string,
  connectionId: string,
  upstream: PiikRouteUpdate['assignment']['upstream'],
  childPeerIds: string[] = []
): PiikRouteUpdate {
  return {
    type: 'route-update',
    revision,
    phase: 'prepare',
    assignment: { upstream, childPeerIds },
    candidate: {
      childPeerId,
      connectionId,
      transport: 'direct',
      qualityProbe: false,
    },
  }
}

function active(
  revision: number,
  upstream: PiikRouteUpdate['assignment']['upstream'],
  childPeerIds: string[] = []
): PiikRouteUpdate {
  return {
    type: 'route-update',
    revision,
    phase: 'active',
    assignment: { upstream, childPeerIds },
  }
}

function offer(connectionId: string, fromPeerId: string) {
  return {
    type: 'signal',
    fromPeerId,
    payload: {
      connectionId,
      kind: 'description',
      // 共享的 signal 用的是服务端那套 `{ type, sdp }`；
      // 语音的 `room-voice-signal` 才是 `{ revision, sdp: {...}, tracks }`。
      description: { type: 'offer', sdp: 'm=video 9\r\n' },
    },
  }
}

function harness() {
  const sent: PiikClientMessage[] = []
  const states: { connectionId: string; state: string }[] = []
  const endpoint = new ShareEndpoint({ iceServers: [] }, null, {
    send: (message) => {
      sent.push(message)
      return true
    },
    onStream: () => {},
    onStateChange: (connectionId, state) =>
      states.push({ connectionId, state }),
  })
  return { endpoint, sent, states }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('换父：关掉旧父的边，且不报 route-failed', async () => {
  const restore = installFake()
  try {
    const { endpoint, sent, states } = harness()

    // 我挂在 host 下面。
    endpoint.handle(
      prepare(2, 'me', 'conn-old', { kind: 'peer', peerId: 'host' })
    )
    endpoint.handle(offer('conn-old', 'host') as never)
    await flush()
    const oldPc = FakePeerConnection.instances[0]
    assert.ok(oldPc)

    oldPc.reach('connected')
    const settled = sent.filter((m) => m.type === 'route-ready')
    assert.equal(settled.length, 1, '连上后要结算一次')

    // host 掉线，controller 把我挂到 viewer-3 下面。
    endpoint.handle(
      prepare(3, 'me', 'conn-new', { kind: 'peer', peerId: 'viewer-3' })
    )

    assert.equal(oldPc.closed, true, '旧父的边必须关掉')
    assert.deepEqual(
      sent.filter((m) => m.type === 'route-failed'),
      [],
      '换父不该上报失败，否则 controller 会把重新分配判死'
    )
    assert.ok(
      states.some((item) => item.connectionId === 'conn-old'),
      '关边要通知上层，界面才知道旧画面已经没了'
    )

    // 新父的 offer 到了才建新边。
    endpoint.handle(offer('conn-new', 'viewer-3') as never)
    await flush()
    const newPc = FakePeerConnection.instances[1]
    assert.ok(newPc, '新父 offer 到达后应建边')
    newPc.reach('connected')
    assert.equal(
      sent.filter((m) => m.type === 'route-ready').length,
      2,
      '新边连上后同样要结算'
    )
  } finally {
    restore()
  }
})

test('上游仍是它时，边失败要上报 route-failed', async () => {
  const restore = installFake()
  try {
    const { endpoint, sent } = harness()
    endpoint.handle(
      prepare(2, 'me', 'conn-1', { kind: 'peer', peerId: 'host' })
    )
    endpoint.handle(offer('conn-1', 'host') as never)
    await flush()

    const pc = FakePeerConnection.instances[0]
    pc.reach('failed')

    const failed = sent.filter((m) => m.type === 'route-failed')
    assert.equal(failed.length, 1, '当前上游失败要报给 controller')
    assert.equal(
      (failed[0] as { connectionId?: string }).connectionId,
      'conn-1'
    )
  } finally {
    restore()
  }
})

test('已经换到新父之后，旧边再断不报失败', async () => {
  const restore = installFake()
  try {
    const { endpoint, sent } = harness()
    endpoint.handle(
      prepare(2, 'me', 'conn-old', { kind: 'peer', peerId: 'host' })
    )
    endpoint.handle(offer('conn-old', 'host') as never)
    await flush()
    const oldPc = FakePeerConnection.instances[0]

    // active 广播先到（controller 已经改完拓扑），旧边随后才断。
    endpoint.handle(active(4, { kind: 'peer', peerId: 'viewer-3' }))
    oldPc.reach('failed')

    assert.deepEqual(
      sent.filter((m) => m.type === 'route-failed'),
      [],
      '换父之后的旧边断线是预期内的，不该再报'
    )
  } finally {
    restore()
  }
})

test('作为父节点时，下游候选会主动 offer 并挂上游流转发', async () => {
  const restore = installFake()
  try {
    const sent: PiikClientMessage[] = []
    const endpoint = new ShareEndpoint({ iceServers: [] }, null, {
      send: (message) => {
        sent.push(message)
        return true
      },
      onStream: () => {},
      onStateChange: () => {},
    })

    // 先当子节点收到 host 的流。
    endpoint.handle(
      prepare(2, 'me', 'conn-up', { kind: 'peer', peerId: 'host' })
    )
    endpoint.handle(offer('conn-up', 'host') as never)
    await flush()
    const upPc = FakePeerConnection.instances[0]
    const video = { kind: 'video', readyState: 'live' }
    upPc.ontrack?.({ track: video })
    assert.equal(upPc.senders.length, 0, '子节点不该往上游发东西')

    // controller 让 viewer-4 挂到我下面。
    endpoint.handle(
      prepare(5, 'viewer-4', 'conn-down', { kind: 'peer', peerId: 'host' }, [
        'viewer-4',
      ])
    )
    await flush()
    const downPc = FakePeerConnection.instances[1]
    assert.ok(downPc, '我是父时要主动建边')
    assert.deepEqual(
      downPc.senders.map((s) => s.track),
      [video],
      '中间节点挂的是上游推来的轨，不是本地流'
    )
    assert.ok(
      sent.some(
        (m) =>
          m.type === 'signal' &&
          (m as { payload?: { kind?: string } }).payload?.kind === 'description'
      ),
      '父节点要发 offer'
    )
  } finally {
    restore()
  }
})
