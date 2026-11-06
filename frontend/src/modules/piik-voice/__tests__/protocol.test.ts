/**
 * Piik 语音协议里那些「错了只会表现为没声音」的判定。
 *
 * 这些函数没有副作用，但每一条都对应一次现场故障：offer 方向判反、把不
 * 属于自己的边当成自己的、转发时取错音轨来源。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SIGNALING_PROTOCOL,
  decodeServerMessage,
  isOfferer,
  myConnections,
  publicationOwner,
  type PiikVoiceConnection,
  type PiikVoiceState,
} from '../protocol.ts'

function connection(
  overrides: Partial<PiikVoiceConnection> = {}
): PiikVoiceConnection {
  return {
    connectionId: 'conn-1',
    parentPeerId: 'host',
    childPeerId: 'viewer',
    transport: 'peer',
    pending: false,
    revision: 1,
    send: [],
    receive: [],
    ...overrides,
  }
}

test('父端是发起方，子端不是', () => {
  const edge = connection()
  assert.equal(isOfferer(edge, 'host'), true)
  assert.equal(isOfferer(edge, 'viewer'), false)
})

test('SFU 边永远不由客户端发起', () => {
  const edge = connection({
    transport: 'sfu',
    parentPeerId: undefined,
    childPeerId: 'viewer',
  })
  assert.equal(isOfferer(edge, 'viewer'), false)
})

test('只保留自己参与的边', () => {
  const state: PiikVoiceState = {
    type: 'room-voice-state',
    revision: 3,
    enabled: true,
    hostPeerId: 'host',
    members: [],
    publications: [],
    connections: [
      connection({
        connectionId: 'mine-as-parent',
        parentPeerId: 'me',
        childPeerId: 'a',
      }),
      connection({
        connectionId: 'mine-as-child',
        parentPeerId: 'b',
        childPeerId: 'me',
      }),
      connection({
        connectionId: 'not-mine',
        parentPeerId: 'x',
        childPeerId: 'y',
      }),
    ],
    unavailable: [],
  }
  assert.deepEqual(
    myConnections(state, 'me').map((item) => item.connectionId),
    ['mine-as-parent', 'mine-as-child']
  )
})

test('没有状态时不返回任何边', () => {
  assert.deepEqual(myConnections(null, 'me'), [])
})

test('publication 的归属决定转发时从哪里取音轨', () => {
  const state: PiikVoiceState = {
    type: 'room-voice-state',
    revision: 1,
    enabled: true,
    hostPeerId: 'host',
    members: [],
    publications: [
      { id: 'pub-host', peerId: 'host' },
      { id: 'pub-a', peerId: 'a' },
    ],
    connections: [],
    unavailable: [],
  }
  assert.equal(publicationOwner(state, 'pub-host'), 'host')
  assert.equal(publicationOwner(state, 'pub-a'), 'a')
  assert.equal(publicationOwner(state, 'pub-unknown'), null)
})

test('无法解析的帧被丢弃而不是抛错', () => {
  assert.equal(decodeServerMessage('not json'), null)
  assert.equal(decodeServerMessage('null'), null)
  assert.equal(decodeServerMessage('{"no":"type"}'), null)
  assert.deepEqual(decodeServerMessage('{"type":"room-closed"}'), {
    type: 'room-closed',
  })
})

test('协议版本与服务端一致', () => {
  // 服务端 `protocol.SignalingProtocol` 改版本时这里必须同步，否则
  // authenticate 会被判非法而客户端只看到一条 close。
  assert.equal(SIGNALING_PROTOCOL, 'piik-v24')
})
