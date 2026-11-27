/**
 * 连接日志的产出：ICEServer 事件要真的被记录成面板能显示的行。
 *
 * 纯函数（候选摘要、选中候选对）另有 connection-log.test.ts 覆盖；这里盯的是
 * 「endpoint 有没有把事件接上」——尤其是 `icecandidateerror` 这条，它决定了
 * 面板能不能回答「为什么没有公网候选」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ShareEndpoint } from '../endpoint.ts'
import type { ConnectionLogEntry } from '../connection-log.ts'

interface FakeCandidate {
  toJSON: () => { candidate: string }
  type: string
  protocol: string
  address: string
  port: number
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  connectionState = 'new'
  remoteDescriptions: unknown[] = []
  onicecandidate:
    ((event: { candidate: FakeCandidate | null }) => void) | null = null
  onicecandidateerror:
    | ((event: { url: string; errorCode: number; errorText?: string }) => void)
    | null = null
  oniceconnectionstatechange: (() => void) | null = null
  ontrack: ((event: { track: unknown }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  iceConnectionState = 'new'

  constructor() {
    FakePeerConnection.instances.push(this)
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'm=video 9\r\n' }
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescriptions.push(description)
  }

  async addIceCandidate(): Promise<void> {}

  getSenders(): unknown[] {
    return []
  }

  async getStats(): Promise<Map<string, unknown>> {
    return new Map()
  }

  close(): void {
    this.connectionState = 'closed'
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

function harness() {
  const logs: ConnectionLogEntry[] = []
  const endpoint = new ShareEndpoint({ iceServers: [] }, null, {
    send: () => true,
    onStream: () => {},
    onStateChange: () => {},
    onLog: (entry) => logs.push(entry),
  })
  return { endpoint, logs }
}

test('观众建边、候选与 STUN 失败都写进日志', async () => {
  const restore = installFake()
  try {
    const { endpoint, logs } = harness()
    endpoint.handle({
      type: 'signal',
      fromPeerId: 'host-1',
      payload: {
        kind: 'description',
        connectionId: 'c1',
        description: { type: 'offer', sdp: 'v=0' },
      },
    } as never)
    await flush()

    const pc = FakePeerConnection.instances[0]
    assert.ok(pc, '收到 offer 应建边')
    assert.ok(
      logs.some((entry) => entry.message === '开始建立直连（接收方）'),
      '建边应记一条'
    )

    pc.onicecandidate?.({
      candidate: {
        toJSON: () => ({
          candidate: 'candidate:1 1 udp 1 192.168.1.5 5000 typ host',
        }),
        type: 'host',
        protocol: 'udp',
        address: '192.168.1.5',
        port: 5000,
      },
    })
    const local = logs.find(
      (entry) => entry.message === '收集到本地候选：{{candidate}}'
    )
    assert.equal(local?.vars?.candidate, 'host/udp 192.168.1.5:5000')

    pc.onicecandidateerror?.({
      url: 'stun:stun.l.google.com:19302',
      errorCode: 701,
      errorText: 'TURN host lookup received error',
    })
    const stun = logs.find(
      (entry) => entry.message === 'STUN 服务器不可达：{{url}}'
    )
    assert.equal(stun?.level, 'warn')
    assert.equal(stun?.vars?.url, 'stun:stun.l.google.com:19302')
    assert.match(stun?.detail ?? '', /701/)
  } finally {
    restore()
  }
})

test('日志只留给接了 onLog 的调用方，不影响协商', async () => {
  const restore = installFake()
  try {
    const endpoint = new ShareEndpoint({ iceServers: [] }, null, {
      send: () => true,
      onStream: () => {},
      onStateChange: () => {},
    })
    endpoint.handle({
      type: 'signal',
      fromPeerId: 'host-1',
      payload: {
        kind: 'description',
        connectionId: 'c2',
        description: { type: 'offer', sdp: 'v=0' },
      },
    } as never)
    await flush()
    assert.equal(
      FakePeerConnection.instances.length,
      1,
      '不传 onLog 也要正常建边'
    )
  } finally {
    restore()
  }
})
