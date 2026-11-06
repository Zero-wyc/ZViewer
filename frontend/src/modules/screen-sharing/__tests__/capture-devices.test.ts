/**
 * 摄像头采集约束单测。
 *
 * 这里钉的是三条「错了就没画面或者换错设备」的规则：
 *  1. 尺寸用 `ideal`（摄像头的固定格式列表匹配 `max` 容易回落到最差档）；
 *  2. 二次下发（换档位）**不能**带 deviceId / facingMode——那等于换设备；
 *  3. `resizeMode: exact 'none'` 失败时要有去掉它的降级路径。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cameraCaptureConstraints,
  cameraFallbackConstraints,
  cameraTrackConstraints,
} from '../core/capture-devices.ts'

describe('cameraCaptureConstraints', () => {
  it('指定设备时用 exact deviceId，不再带 facingMode', () => {
    const constraints = cameraCaptureConstraints(
      { width: 1280, height: 720 },
      30,
      'cam-1'
    )
    assert.deepEqual(constraints.deviceId, { exact: 'cam-1' })
    assert.equal(constraints.facingMode, undefined)
  })

  it('不指定设备时按后置优先（桌面端会被忽略）', () => {
    const constraints = cameraCaptureConstraints(
      { width: 1280, height: 720 },
      30
    )
    assert.deepEqual(constraints.facingMode, { ideal: 'environment' })
    assert.equal(constraints.deviceId, undefined)
  })

  it('尺寸用 ideal，帧率用 ideal + max（摄像头的硬上限）', () => {
    const constraints = cameraCaptureConstraints(
      { width: 1920, height: 1080 },
      60
    )
    assert.deepEqual(constraints.width, { ideal: 1920 })
    assert.deepEqual(constraints.height, { ideal: 1080 })
    assert.deepEqual(constraints.frameRate, { ideal: 60, max: 60 })
  })

  it('native 档位（null）不下发宽高，交给驱动决定', () => {
    const constraints = cameraCaptureConstraints(null, 30)
    assert.equal(constraints.width, undefined)
    assert.equal(constraints.height, undefined)
    assert.deepEqual(constraints.frameRate, { ideal: 30, max: 30 })
  })

  it('要求不裁剪：resizeMode 恒为 exact none', () => {
    assert.deepEqual(cameraCaptureConstraints(null, 30).resizeMode, {
      exact: 'none',
    })
  })
})

describe('cameraTrackConstraints', () => {
  it('换档位时不能带设备选择（否则会换摄像头或判成没变化）', () => {
    const constraints = cameraTrackConstraints({ width: 1280, height: 720 }, 30)
    assert.equal(constraints.deviceId, undefined)
    assert.equal(constraints.facingMode, undefined)
    assert.deepEqual(constraints.width, { ideal: 1280 })
  })
})

describe('cameraFallbackConstraints', () => {
  it('去掉 resizeMode，其余约束原样保留', () => {
    const primary = cameraCaptureConstraints(
      { width: 640, height: 480 },
      15,
      'a'
    )
    const fallback = cameraFallbackConstraints(primary)
    assert.equal((fallback as { resizeMode?: unknown }).resizeMode, undefined)
    assert.deepEqual(fallback.deviceId, { exact: 'a' })
    assert.deepEqual(fallback.frameRate, { ideal: 15, max: 15 })
  })
})
