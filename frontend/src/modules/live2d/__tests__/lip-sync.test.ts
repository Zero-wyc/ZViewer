import assert from 'node:assert/strict'
import test from 'node:test'
import { LIVE2D_VOICE_NOISE_GATE, micLevelToMouth } from '../core/lip-sync.ts'

// 语音口型的映射函数：只关心「门限以下闭嘴」「单调递增」「夹到 1」这三件事。
// 曲线形状（开根号）不值得断言具体数值——调曲线是调手感，写死数字只会让
// 以后每次微调都变成改测试。

test('噪声门以下一律闭嘴', () => {
  assert.equal(micLevelToMouth(0), 0)
  assert.equal(micLevelToMouth(LIVE2D_VOICE_NOISE_GATE), 0)
  assert.equal(micLevelToMouth(LIVE2D_VOICE_NOISE_GATE / 2), 0)
  // 底噪的典型量级：不说话时房间里的风扇/键盘
  assert.equal(micLevelToMouth(0.03), 0)
})

test('门限以上单调递增，且夹在 0~1', () => {
  let prev = -1
  for (let level = 0; level <= 1.0001; level += 0.05) {
    const mouth = micLevelToMouth(level)
    assert.ok(mouth >= 0 && mouth <= 1, `越界：${level} → ${mouth}`)
    assert.ok(mouth >= prev, `非单调：${level} → ${mouth}`)
    prev = mouth
  }
  assert.equal(micLevelToMouth(1), 1)
})

test('中低音量就有可见口型（开根号的意义）', () => {
  // 归一化后 0.25 的响度若线性映射只有 0.25，开根号后是 0.5：
  // 小声说话时嘴要能看出在动，而不是"几乎不张嘴、一提音量就张满"
  const quarter = LIVE2D_VOICE_NOISE_GATE + (1 - LIVE2D_VOICE_NOISE_GATE) * 0.25
  assert.ok(Math.abs(micLevelToMouth(quarter) - 0.5) < 1e-6)
})

test('非法输入当作静音', () => {
  assert.equal(micLevelToMouth(Number.NaN), 0)
  assert.equal(micLevelToMouth(Number.POSITIVE_INFINITY), 0)
  assert.equal(micLevelToMouth(-1), 0)
})
