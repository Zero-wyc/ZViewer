import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LIVE2D_DRAG_LIMIT, clampDragOffset } from '../core/drag.ts'

// 偏移已经不再和任何人对齐（位置不同步），所以这里的断言只管两件事：
// 合法的值原样保留、越界/非法值被收进一个「仍然能拖动」的范围。

describe('clampDragOffset', () => {
  it('范围内的值原样保留（可以为负）', () => {
    assert.deepEqual(clampDragOffset(0.2, -0.3), { x: 0.2, y: -0.3 })
    assert.deepEqual(clampDragOffset(-1, 1), { x: -1, y: 1 })
  })

  it('足够把角色拖到看不见：上限超过一整个视口', () => {
    assert.ok(LIVE2D_DRAG_LIMIT > 1)
    assert.equal(clampDragOffset(9, 0).x, LIVE2D_DRAG_LIMIT)
    assert.equal(clampDragOffset(-9, 0).x, -LIVE2D_DRAG_LIMIT)
    // 纵向不再有「只给一点点下沉余量」的旧规则：向下也能整只推出画面
    assert.equal(clampDragOffset(0, 3).y, LIVE2D_DRAG_LIMIT)
    assert.equal(clampDragOffset(0, -3).y, -LIVE2D_DRAG_LIMIT)
  })

  it('NaN/Infinity 归一为 0，不会把模型扔到奇怪的位置', () => {
    assert.deepEqual(clampDragOffset(Number.NaN, Number.POSITIVE_INFINITY), {
      x: 0,
      y: 0,
    })
  })
})
