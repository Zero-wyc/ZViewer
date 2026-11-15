import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickVisiblePeers, resolveEffectiveModel } from '../core/visibility.ts'

// 这一组用例锁的是「删除 / 统一角色 / 同屏裁剪」三者的口径。
//
// 它们之所以值得单独测：这套判断先后把"没有角色"表达成 `myModelId=''`、
// 带 roomId 的隐藏记录，于是出现「恢复了回不到原模型」「进别的房间也没有
// 角色」「房主一切统一角色隐藏标记还阴魂不散」。纯函数 + 用例是最省事的回归网。

const base = {
  unified: false,
  unifiedKind: undefined,
  unifiedId: undefined,
  myKind: 'builtin' as const,
  myModelId: 'hiyori',
  removed: false,
}

test('没有删除时直接用我的选择', () => {
  const eff = resolveEffectiveModel(base)
  assert.equal(eff.modelId, 'hiyori')
  assert.equal(eff.kind, 'builtin')
  assert.equal(eff.unified, false)
  assert.equal(eff.removed, false)
})

test('删除角色后生效模型为空，但仍知道自己选的是什么', () => {
  const eff = resolveEffectiveModel({ ...base, removed: true })
  assert.equal(eff.modelId, '')
  assert.equal(eff.removed, true)
  // 关键：删除不动我的选择，重新选一次就能恢复，选择器也要继续高亮它
  assert.equal(base.myModelId, 'hiyori')
})

test('统一角色压过删除', () => {
  const eff = resolveEffectiveModel({
    ...base,
    unified: true,
    unifiedKind: 'room',
    unifiedId: 'unified-1',
    removed: true,
  })
  assert.equal(eff.modelId, 'unified-1')
  assert.equal(eff.kind, 'room')
  assert.equal(eff.unified, true)
  // removed 必须是 false：统一角色期间模型由房主决定，我不该因为自己删过
  // 角色就在统一角色里缺席。删除标记本身不动，关掉统一后我仍然没有角色。
  assert.equal(eff.removed, false)
})

test('统一开着但没给模型时退回个人选择（旧客户端/半成品策略）', () => {
  const eff = resolveEffectiveModel({ ...base, unified: true, unifiedId: '' })
  assert.equal(eff.modelId, 'hiyori')
  assert.equal(eff.unified, false)

  // 同一条兜底路径对「已删除」同样成立：不会因为房主开了个空策略就冒出角色
  const removedEff = resolveEffectiveModel({
    ...base,
    unified: true,
    unifiedId: '',
    removed: true,
  })
  assert.equal(removedEff.modelId, '')
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
//
// 另一个口径是**一个用户在一屏上只能有一个角色**：名册按 socket 唯一，但
// 重连窗口里同一人会有两条记录，画出来就是"同一个人站在两个位置"。

const sidOf = <T extends { sid: string }>(p: T) => p.sid
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

test('自己根本不在名册里（已删除角色）时不动裁剪结果', () => {
  const picked = pickVisiblePeers(roster(8), 'nobody', 6, sidOf)
  assert.deepEqual(picked.map(sidOf), ['s1', 's2', 's3', 's4', 's5', 's6'])
})

test('上限为 0 时不渲染任何人', () => {
  assert.deepEqual(pickVisiblePeers(roster(3), 's1', 0, sidOf), [])
})

test('同一个 sid 重复出现时只保留第一条（一人一屏一个角色）', () => {
  const dupes = [
    { sid: 's1', model: 'a' },
    { sid: 's2', model: 'b' },
    { sid: 's1', model: 'c' },
    { sid: 's3', model: 'd' },
  ]
  const picked = pickVisiblePeers(dupes, 's2', 6, sidOf)
  assert.deepEqual(
    picked.map((p) => p.model),
    ['a', 'b', 'd']
  )
})

test('去重优先于裁剪：重复项不能白占渲染名额', () => {
  const dupes = [
    { sid: 's1' },
    { sid: 's1' },
    { sid: 's1' },
    { sid: 's2' },
    { sid: 's3' },
  ]
  const picked = pickVisiblePeers(dupes, 's3', 3, sidOf)
  assert.deepEqual(picked.map(sidOf), ['s1', 's2', 's3'])
})

test('空 sid 的记录一律丢弃（服务端不该有，但脏数据不该画出无名角色）', () => {
  const dirty = [{ sid: '' }, { sid: 's1' }, { sid: '' }]
  assert.deepEqual(pickVisiblePeers(dirty, 's1', 6, sidOf).map(sidOf), ['s1'])
})
