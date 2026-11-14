import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LIVE2D_DRAG_X_LIMIT,
  LIVE2D_DRAG_Y_MAX,
  LIVE2D_DRAG_Y_MIN,
  clampDragOffset,
} from '../core/drag.ts'

// 拖拽偏移的范围必须与后端 internal/room/live2d_state.go 的 live2dDrag*
// 常量一致：两端算不出同一个位置，各端看到的站位就会错开。

describe('clampDragOffset', () => {
  it('范围内的值原样保留（可以为负）', () => {
    assert.deepEqual(clampDragOffset(0.2, -0.3), { x: 0.2, y: -0.3 })
    assert.deepEqual(clampDragOffset(-0.45, -0.55), { x: -0.45, y: -0.55 })
  })

  it('横向越界夹到 ±45%', () => {
    assert.equal(clampDragOffset(9, 0).x, LIVE2D_DRAG_X_LIMIT)
    assert.equal(clampDragOffset(-9, 0).x, -LIVE2D_DRAG_X_LIMIT)
  })

  it('纵向只留很小的下沉余量', () => {
    assert.equal(clampDragOffset(0, 3).y, LIVE2D_DRAG_Y_MAX)
    assert.equal(clampDragOffset(0, -3).y, LIVE2D_DRAG_Y_MIN)
    // 向下几乎不给空间：模型的锚点在脚底，再往下就整只出画面了
    assert.ok(LIVE2D_DRAG_Y_MAX <= 0.1)
  })

  it('NaN/Infinity 归一为 0，不会把模型送到画面外', () => {
    assert.deepEqual(clampDragOffset(Number.NaN, Number.POSITIVE_INFINITY), {
      x: 0,
      y: 0,
    })
  })
})
