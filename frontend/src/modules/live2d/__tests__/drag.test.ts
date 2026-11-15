import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LIVE2D_DRAG_X_LIMIT,
  LIVE2D_DRAG_Y_MAX,
  LIVE2D_DRAG_Y_MIN,
  LIVE2D_KEEP_X_RATIO,
  LIVE2D_KEEP_Y_RATIO,
  clampBoxToView,
  clampDragOffset,
  clampDragToView,
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

// 视口比例的硬边界管不住「模型被推出画面」：同一个 0.55 的偏移，对高度
// 只占 42% 视口的角色就是把整个人推出去。真正的边界必须按模型包围盒算。
describe('clampBoxToView', () => {
  const VIEW_W = 1000
  const VIEW_H = 600

  it('完全在画面内的包围盒不动', () => {
    const box = { x: 400, y: 300, width: 200, height: 300 }
    assert.deepEqual(clampBoxToView(box, VIEW_W, VIEW_H), { dx: 0, dy: 0 })
  })

  it('整只跑出下边时拉回来，至少保留 KEEP_Y 比例可见', () => {
    const box = { x: 400, y: 2000, width: 200, height: 300 }
    const { dy } = clampBoxToView(box, VIEW_W, VIEW_H)
    const top = box.y + dy
    const visible = Math.min(top + 300, VIEW_H) - Math.max(top, 0)
    assert.ok(visible >= 300 * LIVE2D_KEEP_Y_RATIO - 1e-6)
    assert.ok(dy < 0)
  })

  it('上移过头（只剩一个头）会被拉回来，头顶不许出屏', () => {
    // 模型高 252（0.42 视口），被推上去 450px → 头顶跑到 -198
    const box = { x: 400, y: 600 - 252 - 450, width: 200, height: 252 }
    const { dy } = clampBoxToView(box, VIEW_W, VIEW_H)
    assert.equal(box.y + dy, 0)
    assert.ok(dy > 0)
  })

  it('放得下时允许向上浮动（头顶贴住视口顶为止）', () => {
    const box = { x: 400, y: 100, width: 200, height: 252 }
    assert.deepEqual(clampBoxToView(box, VIEW_W, VIEW_H), { dx: 0, dy: 0 })
  })

  it('高过视口的模型只保证 3/4 视口有内容', () => {
    const box = { x: 400, y: 900, width: 200, height: 900 }
    const { dy } = clampBoxToView(box, VIEW_W, VIEW_H)
    const top = box.y + dy
    const visible = Math.min(top + 900, VIEW_H) - Math.max(top, 0)
    assert.ok(visible >= VIEW_H * LIVE2D_KEEP_Y_RATIO - 1e-6)
  })

  it('左右出界时至少留一半宽度', () => {
    const right = clampBoxToView(
      { x: 5000, y: 100, width: 240, height: 300 },
      VIEW_W,
      VIEW_H
    )
    const left = clampBoxToView(
      { x: -5000, y: 100, width: 240, height: 300 },
      VIEW_W,
      VIEW_H
    )
    assert.ok(right.dx < 0)
    assert.ok(left.dx > 0)
    const rightVisible = VIEW_W - (5000 + right.dx)
    const leftVisible = 0 + left.dx + 240 - 0
    assert.ok(rightVisible >= 240 * LIVE2D_KEEP_X_RATIO - 1e-6)
    assert.ok(leftVisible >= 240 * LIVE2D_KEEP_X_RATIO - 1e-6)
  })

  it('尺寸非法时不动（模型还没加载出来）', () => {
    assert.deepEqual(
      clampBoxToView({ x: 0, y: 0, width: 0, height: 0 }, VIEW_W, VIEW_H),
      { dx: 0, dy: 0 }
    )
  })
})

describe('clampDragToView', () => {
  const VIEW_W = 1000
  const VIEW_H = 600
  // 单人槽位在正中，锚点（脚底中点）落在视口底边；模型高 0.42 视口
  const BASE = { baseX: 500, baseY: 600, width: 240, height: 252 }

  it('原位不受影响', () => {
    const out = clampDragToView({
      ...BASE,
      offset: { x: 0, y: 0 },
      viewW: VIEW_W,
      viewH: VIEW_H,
    })
    assert.deepEqual(out, { x: 0, y: 0 })
  })

  it('大幅上移会被压回，头顶不出屏', () => {
    // 高 480 的模型站在底边，向上拖 0.55 视口（330px）→ 头顶 -210
    const big = { baseX: 500, baseY: 600, width: 300, height: 480 }
    const out = clampDragToView({
      ...big,
      offset: { x: 0, y: -0.55 },
      viewW: VIEW_W,
      viewH: VIEW_H,
    })
    const top = big.baseY + out.y * VIEW_H - big.height
    assert.ok(Math.abs(top) < 1e-6)
    assert.ok(out.y > -0.55)
  })

  it('结果仍然落在后端硬边界内（服务端会按同一组值再截一次）', () => {
    const out = clampDragToView({
      ...BASE,
      offset: { x: 9, y: 9 },
      viewW: VIEW_W,
      viewH: VIEW_H,
    })
    assert.ok(out.x <= LIVE2D_DRAG_X_LIMIT && out.x >= -LIVE2D_DRAG_X_LIMIT)
    assert.ok(out.y <= LIVE2D_DRAG_Y_MAX && out.y >= LIVE2D_DRAG_Y_MIN)
  })

  it('模型尺寸未知时退回视口比例边界', () => {
    const out = clampDragToView({
      offset: { x: 9, y: -9 },
      baseX: 0,
      baseY: 0,
      width: 0,
      height: 0,
      viewW: VIEW_W,
      viewH: VIEW_H,
    })
    assert.deepEqual(out, { x: LIVE2D_DRAG_X_LIMIT, y: LIVE2D_DRAG_Y_MIN })
  })
})
