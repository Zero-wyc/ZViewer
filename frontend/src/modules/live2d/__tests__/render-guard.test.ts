import assert from 'node:assert/strict'
import test from 'node:test'
import { guardModelRender, type GuardableModel } from '../core/render-guard.ts'

// 渲染异常必须被挡在模型内部：pixi 的 Ticker 是在监听器之后才排下一帧的，
// 漏一次异常出去，整个 Live2D 场景就定格、拖也拖不动。

test('正常渲染原样透传 renderer', () => {
  const seen: unknown[] = []
  const model: GuardableModel = {
    renderLive2D(renderer) {
      seen.push(renderer)
    },
  }
  const errors: unknown[] = []
  guardModelRender(model, (error) => errors.push(error))
  model.renderLive2D?.({ gl: 'ctx' })
  assert.deepEqual(seen, [{ gl: 'ctx' }])
  assert.equal(errors.length, 0)
})

test('渲染抛出的异常被吞掉，并通过 onError 上报', () => {
  const boom = new Error('shader 挂了')
  const model: GuardableModel = {
    renderLive2D() {
      throw boom
    },
  }
  const errors: unknown[] = []
  guardModelRender(model, (error) => errors.push(error))
  // 关键断言：调用方（pixi）不该收到异常
  assert.doesNotThrow(() => model.renderLive2D?.({}))
  assert.deepEqual(errors, [boom])
})

test('重复套壳不会让同一个异常被上报两次', () => {
  const model: GuardableModel = {
    renderLive2D() {
      throw new Error('boom')
    },
  }
  const errors: unknown[] = []
  const report = (error: unknown) => errors.push(error)
  guardModelRender(model, report)
  guardModelRender(model, report)
  model.renderLive2D?.({})
  assert.equal(errors.length, 1)
})

test('模型没有 renderLive2D（换过渲染后端）时安全跳过', () => {
  const model: GuardableModel = {}
  assert.doesNotThrow(() => guardModelRender(model, () => {}))
  assert.equal(model.renderLive2D, undefined)
})
