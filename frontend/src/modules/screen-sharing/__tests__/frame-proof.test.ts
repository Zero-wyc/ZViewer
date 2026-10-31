/**
 * 首帧证明单测。
 *
 * 这里用假时钟推进采样：真实实现每 100ms 读一次 `getStats`，测试必须能在
 * 不进浏览器的情况下验证「>0 即证明」与「要求增长」两种模式。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { observeDecodedFrameProof } from '../core/frame-proof.ts'

/** 等到 pending 的 promise + 定时器都跑完。 */
function tick(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('observeDecodedFrameProof', () => {
  it('解出帧（>0）即证明并自动停止', async () => {
    let proofs = 0
    let frames = 0
    const stop = observeDecodedFrameProof({
      readFramesDecoded: async () => frames,
      owns: () => true,
      onProof: () => {
        proofs += 1
        return true
      },
    })
    frames = 3
    await tick()
    stop()
    assert.equal(proofs, 1)
  })

  it('一直 0 帧时不证明', async () => {
    let proofs = 0
    const stop = observeDecodedFrameProof({
      readFramesDecoded: async () => 0,
      owns: () => true,
      onProof: () => {
        proofs += 1
        return true
      },
    })
    await tick()
    stop()
    assert.equal(proofs, 0)
  })

  it('requireProgress 时要求帧数增长（切源后计数继承旧值）', async () => {
    let proofs = 0
    let frames = 100
    const stop = observeDecodedFrameProof({
      readFramesDecoded: async () => frames,
      owns: () => true,
      requireProgress: true,
      onProof: () => {
        proofs += 1
        return true
      },
    })
    await tick(150)
    // 计数没动：不能算证明。
    assert.equal(proofs, 0)
    frames = 101
    await tick(250)
    stop()
    assert.equal(proofs, 1)
  })

  it('onProof 返回 false 时继续观测', async () => {
    let calls = 0
    const stop = observeDecodedFrameProof({
      readFramesDecoded: async () => 5,
      owns: () => true,
      onProof: () => {
        calls += 1
        return calls > 1
      },
    })
    await tick(400)
    stop()
    assert.ok(calls >= 2)
  })

  it('所有权丢失后停止采样', async () => {
    let reads = 0
    let owned = true
    observeDecodedFrameProof({
      readFramesDecoded: async () => {
        reads += 1
        return 0
      },
      owns: () => owned,
      onProof: () => true,
    })
    await tick(150)
    owned = false
    const before = reads
    await tick(300)
    assert.equal(reads, before)
  })

  it('读统计抛错不影响继续采样', async () => {
    let reads = 0
    let proofs = 0
    const stop = observeDecodedFrameProof({
      readFramesDecoded: async () => {
        reads += 1
        if (reads === 1) throw new Error('stats unavailable')
        return 2
      },
      owns: () => true,
      onProof: () => {
        proofs += 1
        return true
      },
    })
    await tick(300)
    stop()
    assert.equal(proofs, 1)
  })

  it('停止函数幂等', () => {
    const stop = observeDecodedFrameProof({
      readFramesDecoded: async () => 0,
      owns: () => true,
      onProof: () => true,
    })
    stop()
    stop()
  })
})
