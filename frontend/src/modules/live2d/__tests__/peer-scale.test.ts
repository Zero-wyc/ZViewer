import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PEER_SCALE_MAX,
  PEER_SCALE_MIN,
  clearPeerScales,
  peerScaleKey,
  peerScaleOf,
  setPeerScale,
  type PeerScaleStorage,
} from '../core/peer-scale.ts'

// 「别人的角色多大」= 本机偏好。这里钉住三件事：按名字记账、越界被夹住、
// 坏数据不会把模型画成 0 或无穷大。

function fakeStorage(seed: Record<string, string> = {}): PeerScaleStorage & {
  dump(): Record<string, string>
} {
  const data = { ...seed }
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    },
    dump: () => data,
  }
}

describe('peerScaleKey', () => {
  it('显示名优先，没有名字退回 sid', () => {
    assert.equal(peerScaleKey('小明', 's1'), '小明')
    assert.equal(peerScaleKey('  ', 's1'), 'sid:s1')
    assert.equal(peerScaleKey(' 小明 ', 's1'), '小明')
  })
})

describe('peerScaleOf / setPeerScale', () => {
  it('没调过返回 null（渲染按 1 处理）', () => {
    const storage = fakeStorage()
    assert.equal(peerScaleOf('小明', 's1', storage), null)
  })

  it('写进去的读得出来，且换 session（换 sid）仍然命中', () => {
    const storage = fakeStorage()
    setPeerScale('小明', 's1', 1.4, storage)
    assert.equal(peerScaleOf('小明', 's1', storage), 1.4)
    // sid 是连接级的：重连换了 id，只要名字没变就还是这个比例
    assert.equal(peerScaleOf('小明', 's9', storage), 1.4)
  })

  it('不同的人互不影响', () => {
    const storage = fakeStorage()
    setPeerScale('小明', 's1', 1.4, storage)
    setPeerScale('小红', 's2', 0.7, storage)
    assert.equal(peerScaleOf('小明', 's1', storage), 1.4)
    assert.equal(peerScaleOf('小红', 's2', storage), 0.7)
  })

  it('越界与非数值被夹/丢弃，不会算出 0 倍或 Infinity', () => {
    const storage = fakeStorage()
    setPeerScale('大', 'a', 99, storage)
    setPeerScale('小', 'b', 0.01, storage)
    assert.equal(peerScaleOf('大', 'a', storage), PEER_SCALE_MAX)
    assert.equal(peerScaleOf('小', 'b', storage), PEER_SCALE_MIN)

    // 盘上的坏数据（手改、旧版本）：读取时按 1 兜底而不是崩掉
    const dirty = fakeStorage({
      'zviewer.live2d.peer-scales': JSON.stringify({
        坏: 'big',
        更好: Number.NaN,
      }),
    })
    assert.equal(peerScaleOf('坏', 'x', dirty), null)
    assert.equal(peerScaleOf('更好', 'y', dirty), null)
  })

  it('没名字也没 sid 时静默跳过', () => {
    const storage = fakeStorage()
    setPeerScale('', '', 1.5, storage)
    assert.equal(peerScaleOf('', '', storage), null)
  })
})

describe('clearPeerScales', () => {
  it('一次清掉所有人（重置时用）', () => {
    const storage = fakeStorage()
    setPeerScale('小明', 's1', 1.4, storage)
    setPeerScale('小红', 's2', 0.7, storage)
    clearPeerScales(storage)
    assert.equal(peerScaleOf('小明', 's1', storage), null)
    assert.equal(peerScaleOf('小红', 's2', storage), null)
  })

  it('没读过盘也清得掉（memo 为空不代表没有数据）', () => {
    const storage = fakeStorage({
      'zviewer.live2d.peer-scales': JSON.stringify({ 小明: 1.6 }),
    })
    // 不先调 peerScaleOf，直接清
    clearPeerScales(storage)
    assert.equal(peerScaleOf('小明', 's1', storage), null)
  })
})
