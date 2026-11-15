import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LIVE2D_RENDER_MAX_RESOLUTION,
  LIVE2D_RESOLUTION_STEP,
  resolutionForViewport,
  shouldUpdateResolution,
} from '../core/render-resolution.ts'

// 画布超采样倍率：渲染器本身要 WebGL，没法在这里跑，把这段判定抽出来单独钉住。

describe('resolutionForViewport', () => {
  it('按像素预算给倍率：小窗口多采、大窗口少采', () => {
    const small = resolutionForViewport(1440, 900)
    const large = resolutionForViewport(2560, 1440)
    assert.ok(small > large, '小窗口的倍率必须更大')
    // 1440×900 → sqrt(4.2M / 1.296M) ≈ 1.8
    assert.ok(Math.abs(small - 1.8) < 0.01)
  })

  it('夹在 1x ~ 2x：再小的窗口不超 2 倍，4K 窗口不低过 1 倍', () => {
    assert.equal(resolutionForViewport(800, 600), LIVE2D_RENDER_MAX_RESOLUTION)
    assert.equal(resolutionForViewport(3840, 2160), 1)
  })

  it('尺寸取不到时按 720p 兜底（不能算出 Infinity 把 canvas 撑爆）', () => {
    const fallback = resolutionForViewport(1280, 720)
    assert.equal(resolutionForViewport(0, 0), fallback)
    assert.equal(
      resolutionForViewport(Number.NaN, 900),
      resolutionForViewport(1280, 900)
    )
  })
})

describe('shouldUpdateResolution', () => {
  it('只有跨过档位才重设（改倍率会重建 framebuffer）', () => {
    assert.equal(shouldUpdateResolution(1.8, 1.8), false)
    assert.equal(shouldUpdateResolution(1.8, 1.6), false)
    // 2 与 1.75 都是二进制可精确表示的，差值正好等于档位
    assert.equal(shouldUpdateResolution(2, 2 - LIVE2D_RESOLUTION_STEP), true)
    assert.equal(shouldUpdateResolution(1.2, 2), true)
  })

  it('取不到当前值时不动', () => {
    assert.equal(shouldUpdateResolution(Number.NaN, 1.5), false)
  })
})
