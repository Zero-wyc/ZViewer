import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Live2DPeer } from '../types.ts'
import {
  captureSmooth,
  clearScene,
  getEntry,
  restoreSmooth,
  setLocalDrag,
  setVoiceMouth,
  upsertPeer,
} from '../core/scene.ts'

// 全量快照重拉时「画面不许瞬移」。
//
// 服务端的快照是 clearScene + 逐行重建：新条目的平滑状态全是初值。
// 重连、live2d-request 补拉都会走这条路，如果不把旧连续量套回去，
// 所有人的模型会瞬移回默认槽位、表情瞬间归中性。

function peer(sid: string, patch: Partial<Live2DPeer> = {}): Live2DPeer {
  return {
    sid,
    name: sid,
    kind: 'builtin',
    modelId: 'm',
    scale: 1,
    ord: 0,
    x: 0.5,
    y: 0.5,
    ar: 1.6,
    mouth: 0,
    eyes: 1,
    form: 0.5,
    brow: 0.5,
    roll: 0.5,
    dragX: 0,
    dragY: 0,
    ...patch,
  }
}

/** 模拟一次「快照重放」：capture → clear → 重建 → restore。 */
function replay(payload: Live2DPeer[]): void {
  const prev = captureSmooth()
  clearScene()
  for (const item of payload) upsertPeer(item)
  restoreSmooth(prev)
}

test('重拉快照不把平滑后的拖拽位置打回原点', () => {
  clearScene()
  const entry = upsertPeer(peer('a'))
  // 拖动中：目标与当前都推到某处
  setLocalDrag('a', 0.2, -0.1)
  assert.equal(entry.currentDragX, 0.2)

  replay([peer('a')])
  const next = getEntry('a')
  assert.ok(next)
  // 当前值保住 —— 画面上不会从记忆位置瞬移回槽位
  assert.equal(next.currentDragX, 0.2)
  assert.equal(next.currentDragY, -0.1)
  // 目标值以名册为准（服务端这次给的还是 0，随后会被 d 行纠正）
  assert.equal(next.targetDragX, 0)
})

test('重拉快照保留视线与面部中间值', () => {
  clearScene()
  const entry = upsertPeer(peer('b'))
  entry.currentX = 0.31
  entry.currentY = 0.77
  entry.currentMouth = 0.62
  entry.currentVoiceMouth = 0.4
  setVoiceMouth('b', 0.8)

  replay([peer('b')])
  const next = getEntry('b')
  assert.ok(next)
  assert.equal(next.currentX, 0.31)
  assert.equal(next.currentY, 0.77)
  assert.equal(next.currentMouth, 0.62)
  assert.equal(next.currentVoiceMouth, 0.4)
  // 时间戳也要回来：否则「正在说话」会在重拉的那一帧断成中性
  assert.equal(next.voiceAt, entry.voiceAt)
})

test('快照里新出现的人不会被上一份的残留状态污染', () => {
  clearScene()
  upsertPeer(peer('a'))
  setLocalDrag('a', 0.3, 0.3)

  // 快照里换成了另一个人
  replay([peer('z', { dragX: 0.1, dragY: 0.05 })])
  const next = getEntry('z')
  assert.ok(next)
  // 新条目：当前值来自名册本身，不是从 a 抄过来的
  assert.equal(next.currentDragX, 0.1)
  assert.equal(next.currentDragY, 0.05)
  assert.equal(getEntry('a'), undefined)
})

test('名册部分用服务端的新值，不被旧快照顶回去', () => {
  clearScene()
  upsertPeer(peer('a', { modelId: 'old', scale: 1 }))
  setLocalDrag('a', 0.4, 0)

  replay([peer('a', { modelId: 'new', scale: 1.5 })])
  const next = getEntry('a')
  assert.ok(next)
  // 名册：服务端刚发的那一份说了算
  assert.equal(next.peer.modelId, 'new')
  assert.equal(next.peer.scale, 1.5)
  // 连续量：还是旧的，画面不会因为这行名册抖一下
  assert.equal(next.currentDragX, 0.4)
})

test('空快照重放也不会把场景搞成半截状态', () => {
  clearScene()
  upsertPeer(peer('a'))
  replay([])
  assert.equal(getEntry('a'), undefined)
})
