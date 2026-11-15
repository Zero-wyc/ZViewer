import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMotionGroups, pickPokeGroup } from '../core/motion-pick.ts'

// 「戳一下」该播哪个动作组。
//
// 这条规则以前写死成 tap_body：模型没导出这个组时，被戳的人只有本地抖动，
// 看着像"戳了没反应"。挑选顺序是 tap → flick → 任意非待机组。

test('优先 tap 语义的组', () => {
  assert.equal(
    pickPokeGroup({ Idle: [{}], Flick: [{}], TapBody: [{}] }),
    'TapBody'
  )
  assert.equal(pickPokeGroup({ tap_body: [{}], Flick: [{}] }), 'tap_body')
})

test('没有 tap 时退到 flick', () => {
  assert.equal(
    pickPokeGroup({ Idle: [{}], FlickHead: [{}], Wave: [{}] }),
    'FlickHead'
  )
})

test('都没有就用第一个非待机组', () => {
  assert.equal(pickPokeGroup({ Idle: [{}], Wave: [{}], Bow: [{}] }), 'Wave')
})

test('待机组永远不选：待机是呼吸循环，戳一下却开始待机等于没反应', () => {
  assert.equal(pickPokeGroup({ Idle: [{}], idle2: [{}] }), '')
  assert.equal(pickPokeGroup({ Idle_01: [{}] }), '')
})

test('空的组不算可用', () => {
  assert.equal(pickPokeGroup({ TapBody: [], Wave: [{}] }), 'Wave')
  assert.equal(pickPokeGroup({ TapBody: [] }), '')
})

test('模型还没加载 / 引擎没暴露 definitions 时返回空串', () => {
  assert.equal(pickPokeGroup(undefined), '')
  assert.equal(pickPokeGroup({}), '')
})

// ==================== 动作清单（右键菜单里的按钮） ====================

test('列出非待机动作组，保留原始组名与条数', () => {
  const groups = parseMotionGroups({
    FileReferences: {
      Motions: {
        Idle: [{}, {}],
        TapBody: [{}],
        FlickHead: [{}, {}, {}],
      },
    },
  })
  assert.deepEqual(groups, [
    { group: 'TapBody', count: 1 },
    { group: 'FlickHead', count: 3 },
  ])
})

test('没有动作字段时返回空数组', () => {
  assert.deepEqual(parseMotionGroups({}), [])
  assert.deepEqual(parseMotionGroups(null), [])
  assert.deepEqual(parseMotionGroups({ FileReferences: {} }), [])
  assert.deepEqual(parseMotionGroups({ FileReferences: { Motions: [] } }), [])
})

test('值为空数组的组不出按钮（点了什么都不会发生）', () => {
  assert.deepEqual(
    parseMotionGroups({ FileReferences: { Motions: { TapBody: [] } } }),
    []
  )
})
