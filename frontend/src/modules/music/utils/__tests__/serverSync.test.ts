/**
 * needsMusicAlign 单测（node:test 原生运行，node --test）。
 *
 * 覆盖观众同曲进度对齐判定：阈值边界、非法输入防御。
 * 场景背景：服务器心跳每 2s 广播一次外推后的权威进度，偏差 ≤2s 时让音频
 * 自然播放（避免频繁 seek 抖动），超过阈值才 seek 对齐。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { needsMusicAlign } from '../serverSync.ts'

describe('needsMusicAlign', () => {
  it('偏差在阈值内（≤2s）返回 false，自然播放', () => {
    assert.equal(needsMusicAlign(10, 12, 2), false)
    assert.equal(needsMusicAlign(12, 10, 2), false)
    // 恰好等于阈值：不 seek（> 严格比较）
    assert.equal(needsMusicAlign(10, 12.001, 2), true)
    assert.equal(needsMusicAlign(10, 12, 2), false)
  })

  it('偏差超过阈值返回 true', () => {
    assert.equal(needsMusicAlign(10, 12.1, 2), true)
    assert.equal(needsMusicAlign(10, 7, 2), true)
    assert.equal(needsMusicAlign(0, 120, 2), true)
  })

  it('自定义阈值生效', () => {
    assert.equal(needsMusicAlign(10, 11.5, 1), true)
    assert.equal(needsMusicAlign(10, 11.5, 2), false)
    assert.equal(needsMusicAlign(10, 11.5, 3), false)
  })

  it('默认阈值为 2 秒', () => {
    assert.equal(needsMusicAlign(10, 11.9), false)
    assert.equal(needsMusicAlign(10, 12.1), true)
  })

  it('非法输入返回 false（不触发 seek）', () => {
    assert.equal(needsMusicAlign(Number.NaN, 10, 2), false)
    assert.equal(needsMusicAlign(10, Number.NaN, 2), false)
    assert.equal(needsMusicAlign(Number.POSITIVE_INFINITY, 10, 2), false)
    assert.equal(needsMusicAlign(10, Number.NEGATIVE_INFINITY, 2), false)
  })

  it('负进度（服务器未开播/重置态）仍可正常判定', () => {
    // target 为 0（未播放）与本地 10s 差距超阈值 → 需要 seek 回 0
    assert.equal(needsMusicAlign(10, 0, 2), true)
  })
})
