/**
 * waitForConnectionOperation 单测。
 *
 * 这段逻辑的存在理由：`pc.close()` **不会**让 createOffer 之类的 promise settle。
 * 没有它，观众断开后房主的协商队列会永久卡住（表现为「一直转圈、日志无错」）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { waitForConnectionOperation } from '../core/connection-op.ts'

describe('waitForConnectionOperation', () => {
  it('正常完成时返回结果', async () => {
    const controller = new AbortController()
    const result = await waitForConnectionOperation(
      controller.signal,
      async () => 42
    )
    assert.equal(result, 42)
  })

  it('已经在飞时 abort，用 signal.reason 拒绝', async () => {
    const controller = new AbortController()
    const reason = new Error('closed')
    // 一个永远不 settle 的操作，模拟 createOffer 在 pc.close() 之后的行为。
    const pending = waitForConnectionOperation(
      controller.signal,
      () => new Promise<never>(() => {})
    )
    controller.abort(reason)
    await assert.rejects(pending, (error) => error === reason)
  })

  it('进入时已 abort 直接拒绝，不执行操作', async () => {
    const controller = new AbortController()
    controller.abort(new Error('already'))
    let called = false
    await assert.rejects(
      waitForConnectionOperation(controller.signal, async () => {
        called = true
        return 1
      })
    )
    assert.equal(called, false)
  })

  it('操作本身抛错时原样透出', async () => {
    const controller = new AbortController()
    await assert.rejects(
      waitForConnectionOperation(controller.signal, async () => {
        throw new Error('boom')
      }),
      /boom/
    )
  })

  it('完成后 abort 不再影响已 resolve 的结果', async () => {
    const controller = new AbortController()
    const result = await waitForConnectionOperation(
      controller.signal,
      async () => 'ok'
    )
    controller.abort(new Error('late'))
    assert.equal(result, 'ok')
    assert.equal(controller.signal.aborted, true)
  })
})
