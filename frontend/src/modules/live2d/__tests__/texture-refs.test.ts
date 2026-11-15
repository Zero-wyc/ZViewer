import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  releaseTextureRefs,
  retainTextureRefs,
  type RefCountedTexture,
} from '../core/texture-refs.ts'

// 贴图跨模型共享：同 URL 的第二个模型拿到的是同一个 Texture 实例
// （Pixi 的 Assets 按绝对 URL 缓存）。共享本身是引擎做好的事，这里的
// 责任只有一个 —— **别把别人的贴图销毁掉**，也别永远不释放。

interface FakeTexture extends RefCountedTexture {
  id: string
}

function tex(id: string): FakeTexture {
  return { id, destroyed: false }
}

test('两个人用同一张图：先走的那个不释放', () => {
  const refs = new Map<FakeTexture, number>()
  const shared = tex('t')
  const a = { textures: [shared] }
  const b = { textures: [shared] }

  retainTextureRefs(refs, a.textures)
  retainTextureRefs(refs, b.textures)
  assert.equal(refs.get(shared), 2)

  // a 换模型 → 计数降到 1，b 的画面必须不受影响
  assert.deepEqual(releaseTextureRefs(refs, a.textures, true), [])
  assert.equal(refs.get(shared), 1)
  assert.equal(refs.has(shared), true)
})

test('最后一个人走了才释放', () => {
  const refs = new Map<FakeTexture, number>()
  const shared = tex('t')
  retainTextureRefs(refs, [shared])
  retainTextureRefs(refs, [shared])

  releaseTextureRefs(refs, [shared], true)
  assert.deepEqual(releaseTextureRefs(refs, [shared], true), [shared])
  assert.equal(refs.has(shared), false)
})

test('独享的贴图走了就释放', () => {
  const refs = new Map<FakeTexture, number>()
  const solo = tex('solo')
  retainTextureRefs(refs, [solo])
  assert.deepEqual(releaseTextureRefs(refs, [solo], true), [solo])
})

test('超时迟到的模型不能减别人的计数', () => {
  const refs = new Map<FakeTexture, number>()
  const shared = tex('t')
  // 别人已经加载完了
  retainTextureRefs(refs, [shared])

  // 我这份从没登记过（加载超时，之后才落地）→ 释放时既不能减计数，
  // 也不能销毁这张图
  assert.deepEqual(releaseTextureRefs(refs, [shared], false), [])
  assert.equal(refs.get(shared), 1)
})

test('超时迟到且没人用：孤儿贴图要释放', () => {
  const refs = new Map<FakeTexture, number>()
  const orphan = tex('orphan')
  // 一次都没登记（拒绝时它自己也没登记过）
  assert.deepEqual(releaseTextureRefs(refs, [orphan], false), [orphan])
})

test('已销毁的贴图跳过，不重复释放也不报错', () => {
  const refs = new Map<FakeTexture, number>()
  const dead = tex('dead')
  dead.destroyed = true
  retainTextureRefs(refs, [dead])
  assert.equal(refs.size, 0)
  assert.deepEqual(releaseTextureRefs(refs, [dead], true), [])
})

test('一张模型多张图集：各自独立计数', () => {
  const refs = new Map<FakeTexture, number>()
  const t1 = tex('1')
  const t2 = tex('2')
  retainTextureRefs(refs, [t1, t2])
  retainTextureRefs(refs, [t2])

  assert.deepEqual(releaseTextureRefs(refs, [t1, t2], true), [t1])
  assert.equal(refs.get(t2), 1)
  assert.deepEqual(releaseTextureRefs(refs, [t2], true), [t2])
})
