/**
 * 自动降档的判定逻辑（`ShareHealthMonitor`）。
 *
 * 这里只测「什么时候该降」，不管怎么降——降档动作在 hook 里（改发送参数）。
 * 用例都写成「窗口序列 → 结论」，因为判据本质是时间序列的稳态判断，
 * 单点断言看不出误判。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ShareHealthMonitor } from '../health.ts'
import type { ShareHealthSample } from '../endpoint.ts'

const TARGET_FPS = 30

/** 一个满帧窗口：1 秒内编码 30 帧、采集 30 帧。 */
function sample(
  connectionId: string,
  second: number,
  options: Partial<ShareHealthSample> = {}
): ShareHealthSample {
  return {
    connectionId,
    outboundId: 'out-1',
    sourceId: 'src-1',
    timestamp: second * 1_000,
    framesEncoded: second * 30,
    sourceFrames: second * 30,
    limitation: null,
    ...options,
  }
}

test('连续两个窗口编不动才降档', () => {
  const monitor = new ShareHealthMonitor()
  // 采集满帧（30/s），编码只有 10/s：编码器跟不上。
  const lagging = (second: number) =>
    sample('conn-1', second, {
      framesEncoded: second * 10,
    })

  assert.equal(
    monitor.observe([lagging(0)], TARGET_FPS),
    false,
    '第一个采样没有基线'
  )
  assert.equal(
    monitor.observe([lagging(1)], TARGET_FPS),
    false,
    '一个窗口还不够'
  )
  assert.equal(
    monitor.observe([lagging(2)], TARGET_FPS),
    true,
    '第二个窗口该降档'
  )
  assert.equal(monitor.downgradeCount, 1)
})

test('中间恢复一个满帧窗口就把计数清零', () => {
  const monitor = new ShareHealthMonitor()
  const seq = [
    sample('conn-1', 0, { framesEncoded: 0 }),
    sample('conn-1', 1, { framesEncoded: 10 }), // 饿 1
    sample('conn-1', 2, { framesEncoded: 40 }), // 恢复（窗口内 30 帧）
    sample('conn-1', 3, { framesEncoded: 50 }), // 又饿，但计数已清零
    sample('conn-1', 4, { framesEncoded: 60 }), // 第 2 个窗口
  ]
  const results = seq.map((item) => monitor.observe([item], TARGET_FPS))
  assert.deepEqual(
    results,
    [false, false, false, false, true],
    '恢复后必须重新数满两个窗口，否则等于没清零'
  )
  assert.equal(monitor.downgradeCount, 1)
})

test('每个代际最多降一档，到顶后不再返回 true', () => {
  const monitor = new ShareHealthMonitor({ maxDowngrades: 1 })
  const lagging = (second: number) =>
    sample('conn-1', second, { framesEncoded: second * 10 })

  monitor.observe([lagging(0)], TARGET_FPS)
  assert.equal(monitor.observe([lagging(1)], TARGET_FPS), false)
  assert.equal(monitor.observe([lagging(2)], TARGET_FPS), true)
  assert.equal(monitor.exhausted, true, '额度用完')
  // 继续饿也不会再降：降两档等于一次跨两个台阶。
  assert.equal(monitor.observe([lagging(3)], TARGET_FPS), false)
  assert.equal(monitor.observe([lagging(4)], TARGET_FPS), false)
  assert.equal(monitor.downgradeCount, 1)
})

test('CPU 受限是硬证据，不必等窗口凑满', () => {
  const monitor = new ShareHealthMonitor()
  monitor.observe([sample('conn-1', 0)], TARGET_FPS)
  assert.equal(
    monitor.observe([sample('conn-1', 1, { limitation: 'cpu' })], TARGET_FPS),
    false,
    '第一个 cpu 窗口只记一次'
  )
  assert.equal(
    monitor.observe([sample('conn-1', 2, { limitation: 'cpu' })], TARGET_FPS),
    true
  )
})

test('换流（outboundId 变了）不算饥饿窗口', () => {
  const monitor = new ShareHealthMonitor()
  monitor.observe([sample('conn-1', 0, { framesEncoded: 0 })], TARGET_FPS)
  // replaceTrack 之后计数器归零：这一窗口没有信息量。
  assert.equal(
    monitor.observe(
      [sample('conn-1', 1, { outboundId: 'out-2', framesEncoded: 3 })],
      TARGET_FPS
    ),
    false
  )
  assert.equal(
    monitor.observe(
      [sample('conn-1', 2, { outboundId: 'out-2', framesEncoded: 13 })],
      TARGET_FPS
    ),
    false
  )
  assert.equal(
    monitor.observe(
      [sample('conn-1', 3, { outboundId: 'out-2', framesEncoded: 23 })],
      TARGET_FPS
    ),
    true,
    '换流后重新开始数，两个窗口后才降'
  )
})

test('边消失后清掉基线，复用的 connectionId 不会误判', () => {
  const monitor = new ShareHealthMonitor()
  monitor.observe([sample('conn-a', 0, { framesEncoded: 0 })], TARGET_FPS)
  monitor.observe([sample('conn-a', 1, { framesEncoded: 10 })], TARGET_FPS) // 饿 1
  // 观众离开：这一轮只剩别人的边。
  monitor.observe([sample('conn-b', 2)], TARGET_FPS)
  // 同一个 connectionId 又被分配到新观众，计数器从头开始。
  assert.equal(
    monitor.observe([sample('conn-a', 3, { framesEncoded: 0 })], TARGET_FPS),
    false,
    '旧基线必须丢掉，否则一上来就判饥饿'
  )
  assert.equal(
    monitor.observe([sample('conn-a', 4, { framesEncoded: 10 })], TARGET_FPS),
    false
  )
  assert.equal(
    monitor.observe([sample('conn-a', 5, { framesEncoded: 20 })], TARGET_FPS),
    true
  )
})

test('多条边里只要有一条连续挨饿就降档，且一次只降一档', () => {
  const monitor = new ShareHealthMonitor()
  const healthy = (second: number) => sample('conn-good', second)
  const lagging = (second: number) =>
    sample('conn-bad', second, { framesEncoded: second * 10 })

  monitor.observe([healthy(0), lagging(0)], TARGET_FPS)
  assert.equal(monitor.observe([healthy(1), lagging(1)], TARGET_FPS), false)
  assert.equal(monitor.observe([healthy(2), lagging(2)], TARGET_FPS), true)
  assert.equal(monitor.downgradeCount, 1)
})

test('采集本身就不出帧时不算编码器饥饿', () => {
  const monitor = new ShareHealthMonitor()
  // 静止桌面：采集只出 2 帧/秒，编码同样只有 2 帧——这是正常现象。
  const idle = (second: number) =>
    sample('conn-1', second, {
      framesEncoded: second * 2,
      sourceFrames: second * 2,
    })
  monitor.observe([idle(0)], TARGET_FPS)
  assert.equal(monitor.observe([idle(1)], TARGET_FPS), false)
  assert.equal(monitor.observe([idle(2)], TARGET_FPS), false)
  assert.equal(monitor.observe([idle(3)], TARGET_FPS), false)
})
