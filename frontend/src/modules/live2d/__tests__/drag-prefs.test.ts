import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearAllDragPrefs,
  clearDragPref,
  loadDragPref,
  saveDragPref,
  type DragPrefStorage,
} from '../core/drag-prefs.ts'
import { LIVE2D_DRAG_LIMIT } from '../core/drag.ts'

// 内存版存储：单测跑在 node 里，没有 localStorage。
function memStorage(seed?: string): DragPrefStorage & { dump: () => string } {
  const map = new Map<string, string>()
  if (seed !== undefined) map.set('zviewer.live2d.drag-prefs', seed)
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    dump: () => map.get('zviewer.live2d.drag-prefs') ?? '',
  }
}

test('没记过时返回 null', () => {
  const storage = memStorage()
  assert.equal(loadDragPref('builtin', 'hiyori', storage), null)
})

test('存进去能原样读回来', () => {
  const storage = memStorage()
  saveDragPref('room', 'm-1', 0.12, -0.2, storage)
  const got = loadDragPref('room', 'm-1', storage)
  assert.ok(got)
  assert.ok(Math.abs(got.x - 0.12) < 1e-6)
  assert.ok(Math.abs(got.y + 0.2) < 1e-6)
})

test('超出范围的旧值读取时会被夹回来', () => {
  const storage = memStorage(JSON.stringify({ 'builtin:m': { x: 9, y: -9 } }))
  const got = loadDragPref('builtin', 'm', storage)
  assert.ok(got)
  assert.equal(got.x, LIVE2D_DRAG_LIMIT)
  assert.equal(got.y, -LIVE2D_DRAG_LIMIT)
})

test('记得住「完全拖出画面」的位置', () => {
  const storage = memStorage()
  saveDragPref('builtin', 'm', 1.2, -1.4, storage)
  const got = loadDragPref('builtin', 'm', storage)
  assert.ok(got)
  assert.ok(Math.abs(got.x - 1.2) < 1e-6)
  assert.ok(Math.abs(got.y + 1.4) < 1e-6)
})

test('保存时也夹一次（防上游传来非有限值）', () => {
  const storage = memStorage()
  saveDragPref('builtin', 'm', Number.NaN, 99, storage)
  const got = loadDragPref('builtin', 'm', storage)
  assert.ok(got)
  assert.equal(got.x, 0)
  assert.equal(got.y, LIVE2D_DRAG_LIMIT)
})

test('不同来源的同名模型互不影响', () => {
  const storage = memStorage()
  saveDragPref('builtin', 'same', 0.1, 0, storage)
  saveDragPref('room', 'same', -0.1, 0, storage)
  assert.equal(loadDragPref('builtin', 'same', storage)?.x, 0.1)
  assert.equal(loadDragPref('room', 'same', storage)?.x, -0.1)
})

test('存的是原点时不当作偏好（避免进房空发一次偏移）', () => {
  const storage = memStorage()
  saveDragPref('builtin', 'm', 0, 0, storage)
  assert.equal(loadDragPref('builtin', 'm', storage), null)
})

test('clear 之后读不到，也不报错', () => {
  const storage = memStorage()
  saveDragPref('builtin', 'm', 0.2, 0, storage)
  clearDragPref('builtin', 'm', storage)
  assert.equal(loadDragPref('builtin', 'm', storage), null)
  clearDragPref('builtin', 'm', storage) // 重复清空不该抛
})

test('clearAllDragPrefs 一次清掉所有模型的站位', () => {
  const storage = memStorage()
  saveDragPref('builtin', 'a', 0.2, 0, storage)
  saveDragPref('room', 'b', -0.3, 0.1, storage)
  clearAllDragPrefs(storage)
  assert.equal(loadDragPref('builtin', 'a', storage), null)
  assert.equal(loadDragPref('room', 'b', storage), null)
  clearAllDragPrefs(storage) // 重复清空不该抛
})

test('坏数据不会炸，按没记过处理', () => {
  const storage = memStorage('{ not json')
  assert.equal(loadDragPref('builtin', 'm', storage), null)
})

test('没有可用存储时静默降级', () => {
  assert.equal(loadDragPref('builtin', 'm', null), null)
  saveDragPref('builtin', 'm', 0.1, 0, null)
  clearDragPref('builtin', 'm', null)
  clearAllDragPrefs(null)
})

test('条目超过上限时淘汰最久没写过的', () => {
  const storage = memStorage()
  for (let i = 0; i < 26; i += 1) {
    saveDragPref('builtin', `m${i}`, 0.01, 0, storage)
  }
  // 前两个（m0/m1）被挤掉，最近的还在
  assert.equal(loadDragPref('builtin', 'm0', storage), null)
  assert.equal(loadDragPref('builtin', 'm1', storage), null)
  assert.ok(loadDragPref('builtin', 'm25', storage))
  // 重新写一次会把它挪到队尾：再超上限时被淘汰的是别人
  saveDragPref('builtin', 'm2', 0.02, 0, storage)
  saveDragPref('builtin', 'm26', 0.03, 0, storage)
  assert.ok(loadDragPref('builtin', 'm2', storage))
})
