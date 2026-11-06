/**
 * 自定义帧率的边界测试。
 *
 * 钉死的两件事：
 *  1. 上限按当前分辨率收窄（2K=144 / 4K=64），这是 H.264 宏块率预算的直接
 *     结果——越界的组合会让采集直接拒绝，界面上表现为「开始共享失败」。
 *  2. 输入框提交时越界值被夹到边界、非法值返回 null（调用方回退），
 *     绝不能悄悄按别的值发出去。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FRAME_RATE_OPTIONS } from '../constants.ts'
import {
  MAX_CUSTOM_FRAMERATE,
  MIN_CUSTOM_FRAMERATE,
  isPresetFramerate,
  maxFramerateForResolution,
  normalizeFramerateInput,
} from '../utils/frame-rate.ts'

describe('自定义帧率范围', () => {
  it('上下限与采集限制一致', () => {
    assert.equal(MIN_CUSTOM_FRAMERATE, 1)
    assert.equal(MAX_CUSTOM_FRAMERATE, 240)
  })

  it('每个分辨率档位的上限都由宏块预算决定', () => {
    assert.equal(maxFramerateForResolution('720p'), 240)
    assert.equal(maxFramerateForResolution('1080p'), 240)
    assert.equal(maxFramerateForResolution('2k'), 144)
    assert.equal(maxFramerateForResolution('4k'), 64)
    // native 不约束宽高，按全局上限
    assert.equal(maxFramerateForResolution('native'), 240)
  })
})

describe('帧率输入合法化', () => {
  it('区间内的整数原样通过', () => {
    assert.equal(normalizeFramerateInput('1'), 1)
    assert.equal(normalizeFramerateInput('120'), 120)
    assert.equal(normalizeFramerateInput(' 144 '), 144)
  })

  it('越界值夹到边界（按当前上限）', () => {
    assert.equal(normalizeFramerateInput('240', 144), 144)
    assert.equal(normalizeFramerateInput('0'), 1)
    assert.equal(normalizeFramerateInput('999'), 240)
  })

  it('小数四舍五入成整数', () => {
    assert.equal(normalizeFramerateInput('59.6'), 60)
  })

  it('空白与非数字返回 null，由调用方回退', () => {
    assert.equal(normalizeFramerateInput(''), null)
    assert.equal(normalizeFramerateInput('  '), null)
    assert.equal(normalizeFramerateInput('abc'), null)
  })

  it('预设档位判定与下拉选项同源', () => {
    for (const option of FRAME_RATE_OPTIONS) {
      assert.equal(isPresetFramerate(option.value), true)
    }
    assert.equal(isPresetFramerate(144), false)
    assert.equal(isPresetFramerate(1), false)
  })
})
