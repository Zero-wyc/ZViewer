import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearAllDragPrefs,
  clearDragPref,
  dragPrefKey,
  legacyDragKey,
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
  assert.equal(loadDragPref('小明', 's1', '', storage), null)
})

test('存进去能原样读回来', () => {
  const storage = memStorage()
  saveDragPref('小明', 's1', 0.12, -0.2, '', storage)
  const got = loadDragPref('小明', 's1', '', storage)
  assert.ok(got)
  assert.ok(Math.abs(got.x - 0.12) < 1e-6)
  assert.ok(Math.abs(got.y + 0.2) < 1e-6)
})

test('超出范围的旧值读取时会被夹回来', () => {
  const storage = memStorage(
    JSON.stringify({ [dragPrefKey('小明', 's1')]: { x: 9, y: -9 } })
  )
  const got = loadDragPref('小明', 's1', '', storage)
  assert.ok(got)
  assert.equal(got.x, LIVE2D_DRAG_LIMIT)
  assert.equal(got.y, -LIVE2D_DRAG_LIMIT)
})

test('记得住「完全拖出画面」的位置', () => {
  const storage = memStorage()
  saveDragPref('小明', 's1', 1.2, -1.4, '', storage)
  const got = loadDragPref('小明', 's1', '', storage)
  assert.ok(got)
  assert.ok(Math.abs(got.x - 1.2) < 1e-6)
  assert.ok(Math.abs(got.y + 1.4) < 1e-6)
})

test('保存时也夹一次（防上游传来非有限值）', () => {
  const storage = memStorage()
  saveDragPref('小明', 's1', Number.NaN, 99, '', storage)
  const got = loadDragPref('小明', 's1', '', storage)
  assert.ok(got)
  assert.equal(got.x, 0)
  assert.equal(got.y, LIVE2D_DRAG_LIMIT)
})

// 位置按人记账：别人和自己的角色都能拖，同一个人用不同模型不该互相搬家，
// 但两个人即使选了同一个模型也必须各记一份。
test('不同的人互不影响（哪怕用同一个模型）', () => {
  const storage = memStorage()
  saveDragPref('小明', 's1', 0.1, 0, '', storage)
  saveDragPref('小红', 's2', -0.1, 0, '', storage)
  assert.equal(loadDragPref('小明', 's1', '', storage)?.x, 0.1)
  assert.equal(loadDragPref('小红', 's2', '', storage)?.x, -0.1)
})

test('同一个人换模型后位置还在（位置跟人不跟模型）', () => {
  const storage = memStorage()
  saveDragPref('小明', 's1', 0.2, 0.1, '', storage)
  // 换了 sid（重连）仍然是同一个人：按显示名记账，照样读得到
  assert.equal(loadDragPref('小明', 's2', '', storage)?.x, 0.2)
})

test('没有名字时退回 sid（同连接内有效）', () => {
  const storage = memStorage()
  saveDragPref('', 'sid-1', 0.3, 0, '', storage)
  assert.equal(loadDragPref('', 'sid-1', '', storage)?.x, 0.3)
  assert.equal(loadDragPref('', 'sid-2', '', storage), null)
})

test('存的是原点时不当作偏好（避免进房空发一次偏移）', () => {
  const storage = memStorage()
  saveDragPref('小明', 's1', 0, 0, '', storage)
  assert.equal(loadDragPref('小明', 's1', '', storage), null)
})

test('clear 之后读不到，也不报错', () => {
  const storage = memStorage()
  saveDragPref('小明', 's1', 0.2, 0, '', storage)
  clearDragPref('小明', 's1', '', storage)
  assert.equal(loadDragPref('小明', 's1', '', storage), null)
  clearDragPref('小明', 's1', '', storage) // 重复清空不该抛
})

test('clearAllDragPrefs 一次清掉所有角色的站位', () => {
  const storage = memStorage()
  saveDragPref('小明', 's1', 0.2, 0, '', storage)
  saveDragPref('小红', 's2', -0.3, 0.1, '', storage)
  clearAllDragPrefs(storage)
  assert.equal(loadDragPref('小明', 's1', '', storage), null)
  assert.equal(loadDragPref('小红', 's2', '', storage), null)
  clearAllDragPrefs(storage) // 重复清空不该抛
})

test('坏数据不会炸，按没记过处理', () => {
  const storage = memStorage('{ not json')
  assert.equal(loadDragPref('小明', 's1', '', storage), null)
})

test('没有可用存储时静默降级', () => {
  assert.equal(loadDragPref('小明', 's1', '', null), null)
  saveDragPref('小明', 's1', 0.1, 0, '', null)
  clearDragPref('小明', 's1', '', null)
  clearAllDragPrefs(null)
})

test('空名字 + 空 sid 不会写出垃圾键', () => {
  const storage = memStorage()
  saveDragPref('  ', '', 0.1, 0, '', storage)
  assert.equal(storage.dump(), '')
})

test('条目超过上限时淘汰最久没写过的', () => {
  const storage = memStorage()
  for (let i = 0; i < 66; i += 1) {
    saveDragPref(`人${i}`, `s${i}`, 0.01, 0, '', storage)
  }
  // 前两个被挤掉，最近的还在
  assert.equal(loadDragPref('人0', 's0', '', storage), null)
  assert.equal(loadDragPref('人1', 's1', '', storage), null)
  assert.ok(loadDragPref('人65', 's65', '', storage))
  // 重新写一次会把它挪到队尾：再超上限时被淘汰的是别人
  saveDragPref('人2', 's2', 0.02, 0, '', storage)
  saveDragPref('人66', 's66', 0.03, 0, '', storage)
  assert.ok(loadDragPref('人2', 's2', '', storage))
})

// ---------------------------------------------------------------------------
// 老版本按模型记账的记录（`kind:modelId`）
// ---------------------------------------------------------------------------

test('老记录会迁移到按人记账，读完删掉老键', () => {
  const storage = memStorage(
    JSON.stringify({ 'builtin:hiyori': { x: 0.1, y: -0.2 } })
  )
  const legacy = legacyDragKey('builtin', 'hiyori')
  const pref = loadDragPref('小明', 's1', legacy, storage)
  assert.ok(pref)
  assert.ok(Math.abs(pref.x - 0.1) < 1e-6)

  const dumped = JSON.parse(storage.dump()) as Record<string, unknown>
  assert.deepEqual(dumped[dragPrefKey('小明', 's1')], { x: 0.1, y: -0.2 })
  assert.equal(dumped['builtin:hiyori'], undefined)
  // 迁移后不再需要 legacy：只读新键也能读到
  assert.equal(loadDragPref('小明', 's1', '', storage)?.x, 0.1)
})

test('老记录里的 top/bottom 被忽略，位置照常迁移', () => {
  const storage = memStorage(
    JSON.stringify({
      'builtin:m': { x: 0.1, y: -0.2, top: 0, bottom: 0.55 },
    })
  )
  const pref = loadDragPref(
    '小明',
    's1',
    legacyDragKey('builtin', 'm'),
    storage
  )
  assert.ok(pref)
  assert.ok(Math.abs(pref.x - 0.1) < 1e-6)
  assert.ok(Math.abs(pref.y - -0.2) < 1e-6)
})

test('迁移后「回到原位」不会被老记录复活', () => {
  const storage = memStorage(JSON.stringify({ 'builtin:m': { x: 0.1, y: 0 } }))
  const legacy = legacyDragKey('builtin', 'm')
  assert.ok(loadDragPref('小明', 's1', legacy, storage))
  clearDragPref('小明', 's1', legacy, storage)
  assert.equal(loadDragPref('小明', 's1', legacy, storage), null)

  // 反过来：先清新键、老键还在时也必须一并清掉（否则下次读取又会迁移回来）
  const storage2 = memStorage(JSON.stringify({ 'builtin:m': { x: 0.1, y: 0 } }))
  clearDragPref('小明', 's1', legacy, storage2)
  assert.equal(loadDragPref('小明', 's1', legacy, storage2), null)
})
