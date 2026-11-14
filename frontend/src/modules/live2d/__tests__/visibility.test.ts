import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  pickVisiblePeers,
  resolveEffectiveModel,
  type Live2DHidden,
} from '../core/visibility.ts'

// 这一组用例锁的是「隐藏 / 显示 / 统一角色」三者的优先级。
//
// 它们之所以值得单独测：这套判断曾经把"隐藏"表达成 `myModelId=''`，
// 于是恢复不回原模型、进别的房间也没有角色、房主一切统一角色隐藏标记还
// 阴魂不散。纯函数 + 用例是最省事的回归网。

const base = {
  roomId: 'ROOM_A',
  unified: false,
  unifiedKind: undefined,
  unifiedId: undefined,
  myKind: 'builtin' as const,
  myModelId: 'hiyori',
  hidden: null as Live2DHidden | null,
}

test('没有隐藏时直接用我的选择', () => {
  const eff = resolveEffectiveModel(base)
  assert.equal(eff.modelId, 'hiyori')
  assert.equal(eff.kind, 'builtin')
  assert.equal(eff.unified, false)
  assert.equal(eff.hidden, false)
})

test('本房间隐藏时生效模型为空，但仍知道自己选的是什么', () => {
  const eff = resolveEffectiveModel({
    ...base,
    hidden: { roomId: 'ROOM_A', kind: 'room', modelId: 'ds-001' },
  })
  assert.equal(eff.modelId, '')
  assert.equal(eff.hidden, true)
  // 关键：隐藏不改我的选择，显示后应当回到 hiyori 而不是"没选过"
  assert.equal(base.myModelId, 'hiyori')
})

test('别的房间的隐藏记录不影响本房间', () => {
  const eff = resolveEffectiveModel({
    ...base,
    hidden: { roomId: 'ROOM_B', kind: 'builtin', modelId: 'hiyori' },
  })
  assert.equal(eff.modelId, 'hiyori')
  assert.equal(eff.hidden, false)
})

test('统一角色压过隐藏', () => {
  const eff = resolveEffectiveModel({
    ...base,
    unified: true,
    unifiedKind: 'room',
    unifiedId: 'unified-1',
    hidden: { roomId: 'ROOM_A', kind: 'builtin', modelId: 'hiyori' },
  })
  assert.equal(eff.modelId, 'unified-1')
  assert.equal(eff.kind, 'room')
  assert.equal(eff.unified, true)
  // hidden 必须是 false：调用方靠它来清掉那条记录，否则房主一关统一，
  // 角色又会莫名其妙消失
  assert.equal(eff.hidden, false)
})

test('统一开着但没给模型时退回个人选择（旧客户端/半成品策略）', () => {
  const eff = resolveEffectiveModel({ ...base, unified: true, unifiedId: '' })
  assert.equal(eff.modelId, 'hiyori')
  assert.equal(eff.unified, false)
})

test('统一角色没有 kind 时按内置处理', () => {
  const eff = resolveEffectiveModel({
    ...base,
    unified: true,
    unifiedId: 'x',
    unifiedKind: undefined,
  })
  assert.equal(eff.kind, 'builtin')
})

// ---- 同屏裁剪 ----
//
// 名册能到 12 人，但只画 6 个。裁剪规则若只看 ord，排第 7 的人就彻底看不到
// 自己——画面上没有任何东西能说明"你的角色在，只是没画出来"。

const sidOf = (p: { sid: string }) => p.sid
const roster = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ sid: `s${i + 1}` }))

test('人数没超上限时原样返回', () => {
  const list = roster(3)
  assert.deepEqual(pickVisiblePeers(list, 's1', 6, sidOf), list)
})

test('自己在裁剪范围内时按 ord 取前 N', () => {
  const picked = pickVisiblePeers(roster(8), 's9', 6, sidOf)
  assert.deepEqual(picked.map(sidOf), ['s1', 's2', 's3', 's4', 's5', 's6'])
})

test('自己排在第 N 位之后时替换掉最后一个名额', () => {
  const picked = pickVisiblePeers(roster(8), 's8', 6, sidOf)
  // 总数不变、自己一定在
  assert.equal(picked.length, 6)
  assert.deepEqual(picked.map(sidOf), ['s1', 's2', 's3', 's4', 's5', 's8'])
})

test('自己根本不在名册里（没选模型/隐藏中）时不动裁剪结果', () => {
  const picked = pickVisiblePeers(roster(8), 'nobody', 6, sidOf)
  assert.deepEqual(picked.map(sidOf), ['s1', 's2', 's3', 's4', 's5', 's6'])
})

test('上限为 0 时不渲染任何人', () => {
  assert.deepEqual(pickVisiblePeers(roster(3), 's1', 0, sidOf), [])
})
