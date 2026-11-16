import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Live2DPeer } from '../types.ts'
import {
  clearScene,
  isVoiceActive,
  isVoiceSpeaking,
  setVoiceMouth,
  upsertPeer,
} from '../core/scene.ts'

// 名字标签的「谁在说话」判定。
//
// 关键区别：开麦但不说话时，对方仍会推一帧嘴型 0（把状态收尾），
// 光看「数据新鲜」会把所有开麦的人都算成在说话。

function peer(sid: string): Live2DPeer {
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
    headX: 0.5,
    headY: 0.5,
    offX: 0.5,
    offY: 0.5,
    depth: 0.5,
    gazeX: 0.5,
    gazeY: 0.5,
    eyeLeft: 1,
    eyeRight: 1,
    headActive: false,
    eyeActive: false,
  }
}

const TTL = 1200

test('有声才高亮：嘴型大于零且数据新鲜', () => {
  clearScene()
  const entry = upsertPeer(peer('a'))
  setVoiceMouth('a', 0.7)
  assert.equal(isVoiceActive(entry, TTL), true)
  assert.equal(isVoiceSpeaking(entry, TTL), true)
})

test('开麦但不说话时不算在说话', () => {
  clearScene()
  const entry = upsertPeer(peer('a'))
  setVoiceMouth('a', 0)
  // 数据是新鲜的（刚推过一帧闭嘴），但嘴型为 0 —— 不该高亮
  assert.equal(isVoiceActive(entry, TTL), true)
  assert.equal(isVoiceSpeaking(entry, TTL), false)
})

test('从没收到过语音帧的人不算在说话', () => {
  clearScene()
  const entry = upsertPeer(peer('b'))
  assert.equal(isVoiceSpeaking(entry, TTL), false)
})

test('数据过期就不再算在说话（防止一直亮着）', () => {
  clearScene()
  const entry = upsertPeer(peer('a'))
  setVoiceMouth('a', 0.8)
  // 把时间戳往回推：真实场景里是对端停止上报后自然过期
  entry.voiceAt = Date.now() - TTL - 1
  assert.equal(isVoiceSpeaking(entry, TTL), false)
})

test('写入不存在的 sid 不会抛', () => {
  clearScene()
  setVoiceMouth('missing', 0.5)
  const entry = upsertPeer(peer('c'))
  assert.equal(isVoiceSpeaking(entry, TTL), false)
})
