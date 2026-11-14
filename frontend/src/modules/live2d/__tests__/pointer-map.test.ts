import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  alphaForDelta,
  clamp01,
  mapPointerToAspect,
  normalizePointer,
  roundCoord,
  smooth,
} from '../core/pointer-map.ts'

// 这些函数决定了「别人看到的视线方向对不对」，是纯计算，最适合用单测钉住。

describe('normalizePointer', () => {
  it('视口坐标归一化并带出宽高比', () => {
    assert.deepEqual(normalizePointer(1200, 400, 1600, 800), {
      x: 0.75,
      y: 0.5,
      ar: 2,
    })
  })

  it('越界坐标被夹到 0~1', () => {
    const p = normalizePointer(-10, 999, 1600, 800)
    assert.equal(p.x, 0)
    assert.equal(p.y, 1)
  })

  it('尺寸为 0 时不产生 NaN/Infinity', () => {
    const p = normalizePointer(10, 10, 0, 0)
    assert.ok(
      Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.ar)
    )
  })
})

describe('mapPointerToAspect', () => {
  it('宽屏发送者的横向偏移在窄屏被压缩', () => {
    const out = mapPointerToAspect({ x: 1, y: 0.5, ar: 2.4 }, 1.6)
    assert.ok(out.x > 0.5 && out.x < 0.95, `期望压缩到 0.5~0.95，实际 ${out.x}`)
    assert.equal(out.y, 0.5)
  })

  it('高屏发送者的纵向偏移在宽屏被压缩', () => {
    const out = mapPointerToAspect({ x: 0.5, y: 1, ar: 1.2 }, 2.4)
    assert.equal(out.x, 0.5)
    assert.ok(out.y > 0.5 && out.y < 0.95)
  })

  it('中心点在任何比例下都不动', () => {
    assert.deepEqual(mapPointerToAspect({ x: 0.5, y: 0.5, ar: 3 }, 1.2), {
      x: 0.5,
      y: 0.5,
    })
  })

  it('比例相同就是恒等映射', () => {
    const out = mapPointerToAspect({ x: 0.2, y: 0.8, ar: 1.78 }, 1.78)
    assert.ok(Math.abs(out.x - 0.2) < 1e-9)
    assert.ok(Math.abs(out.y - 0.8) < 1e-9)
  })
})

describe('smooth / alphaForDelta', () => {
  it('指数平滑单调收敛到目标', () => {
    let v = 0
    for (let i = 0; i < 60; i += 1) v = smooth(v, 1, 0.25)
    assert.ok(v > 0.99, `60 帧后应接近 1，实际 ${v}`)
  })

  it('非有限值不会污染状态', () => {
    assert.equal(smooth(0.3, Number.NaN, 0.5), 0.3)
    assert.equal(smooth(Number.NaN, 0.7, 0.5), 0.7)
  })

  it('低帧率下单帧 alpha 更大，保证收敛速度与帧率无关', () => {
    const slow = alphaForDelta(0.25, 66)
    const fast = alphaForDelta(0.25, 16)
    assert.ok(
      slow > fast,
      `30fps 的单帧 alpha 应大于 60fps，实际 ${slow} / ${fast}`
    )
    assert.ok(slow <= 1 && fast > 0)
  })
})

describe('clamp01 / roundCoord', () => {
  it('NaN 归一为 0', () => {
    assert.equal(clamp01(Number.NaN), 0)
  })

  it('保留 3 位小数（发送前压缩精度）', () => {
    assert.equal(roundCoord(0.123456), 0.123)
    assert.equal(roundCoord(2), 1)
  })
})
