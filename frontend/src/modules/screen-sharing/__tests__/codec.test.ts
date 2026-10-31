/**
 * 共享协议编解码单测（node:test 原生运行）。
 *
 * 这些断言与服务端 `backend-go/internal/share/protocol_test.go` 一一对应：
 * 两侧的严格性必须同时成立，否则「服务端拒收客户端发的帧」这类问题
 * 只会在联调时才暴露。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SHARE_MAX_FRAME_BYTES,
  ShareProtocolError,
  decodeServerMessage,
  decodeServerMessageOrNull,
  encodeClientMessage,
  frameBytes,
} from '../protocol/codec.ts'

const snapshot = {
  t: 'share.snapshot',
  roomId: 'r1',
  shareGeneration: 'share_abc',
  revision: 3,
  paused: false,
  sharing: true,
  qualitySettings: {
    resolutionPreset: '1080p',
    frameRate: 30,
    maxBitrateMbps: 8,
  },
  participants: [
    {
      peerId: 'p1',
      socketId: 's1',
      role: 'host',
      displayName: '房主',
      mediaReady: true,
    },
  ],
}

describe('decodeServerMessage', () => {
  it('解码合法快照', () => {
    const message = decodeServerMessage(snapshot)
    assert.equal(message.t, 'share.snapshot')
    if (message.t !== 'share.snapshot') return
    assert.equal(message.roomId, 'r1')
    assert.equal(message.revision, 3)
    assert.equal(message.participants.length, 1)
    assert.equal(message.participants[0].role, 'host')
  })

  it('未知 t 被拒', () => {
    assert.throws(
      () => decodeServerMessage({ t: 'share.nope', roomId: 'r1' }),
      {
        name: 'ShareProtocolError',
      }
    )
  })

  it('缺 t 被拒', () => {
    assert.throws(() => decodeServerMessage({ roomId: 'r1' }))
  })

  it('非对象被拒', () => {
    assert.throws(() => decodeServerMessage(null))
    assert.throws(() => decodeServerMessage('share.snapshot'))
    assert.throws(() => decodeServerMessage([snapshot]))
  })

  it('未知字段被拒', () => {
    assert.throws(
      () => decodeServerMessage({ ...snapshot, extra: 1 }),
      /unknown field/
    )
  })

  it('缺必填字段被拒', () => {
    const withoutRevision = {
      t: 'share.snapshot',
      roomId: 'r1',
      shareGeneration: 'share_abc',
      paused: false,
      sharing: true,
      qualitySettings: snapshot.qualitySettings,
      participants: snapshot.participants,
    }
    assert.throws(() => decodeServerMessage(withoutRevision), /missing field/)
  })

  it('必填字段为 null 被拒', () => {
    assert.throws(() =>
      decodeServerMessage({ ...snapshot, participants: null })
    )
  })

  it('participants 元素形状错误被拒', () => {
    assert.throws(() =>
      decodeServerMessage({
        ...snapshot,
        participants: [
          { peerId: 'p1', socketId: 's1', role: 'ghost', mediaReady: false },
        ],
      })
    )
  })

  it('无效路由阶段被拒（"ready" 是 punch 子阶段，不是路由阶段）', () => {
    assert.throws(
      () =>
        decodeServerMessage({
          t: 'share.route',
          roomId: 'r1',
          revision: 1,
          phase: 'ready',
          assignment: { revision: 1, phase: 'prepare', candidates: [] },
        }),
      /invalid route phase/
    )
  })

  it('无效路由状态被拒', () => {
    assert.throws(
      () =>
        decodeServerMessage({
          t: 'share.status',
          roomId: 'r1',
          revision: 1,
          state: 'done',
          reason: 'route-exhausted',
        }),
      /invalid route status/
    )
  })

  it('错误帧允许省略 roomId', () => {
    const message = decodeServerMessage({
      t: 'share.error',
      code: 'INVALID_MESSAGE',
      message: '未知字段',
    })
    assert.equal(message.t, 'share.error')
  })

  it('decodeServerMessageOrNull 把失败折成 null', () => {
    assert.equal(decodeServerMessageOrNull({ t: 'share.nope' }), null)
    assert.notEqual(decodeServerMessageOrNull(snapshot), null)
  })
})

describe('encodeClientMessage', () => {
  it('编码 hello 且省略未设置的字段', () => {
    const text = encodeClientMessage({ t: 'share.hello', roomId: 'r1' })
    const parsed = JSON.parse(text) as Record<string, unknown>
    assert.equal(parsed.t, 'share.hello')
    assert.equal(parsed.roomId, 'r1')
    assert.equal('shareGeneration' in parsed, false)
  })

  it('带上 shareGeneration', () => {
    const text = encodeClientMessage({
      t: 'share.hello',
      roomId: 'r1',
      shareGeneration: 'share_abc',
    })
    assert.equal(
      (JSON.parse(text) as Record<string, unknown>).shareGeneration,
      'share_abc'
    )
  })

  it('超过 64KiB 抛错', () => {
    const message = {
      t: 'share.hello',
      roomId: 'r',
      shareGeneration: 'x'.repeat(SHARE_MAX_FRAME_BYTES),
    } as const
    assert.throws(() => encodeClientMessage(message), ShareProtocolError)
  })

  it('frameBytes 按 UTF-8 字节算（中文 3 字节）', () => {
    assert.equal(frameBytes('abc'), 3)
    assert.equal(frameBytes('房'), 3)
  })
})
