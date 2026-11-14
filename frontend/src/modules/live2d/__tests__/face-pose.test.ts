import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  faceBlendFromScores,
  faceMetrics,
  gazeFromMetrics,
  FACE_BLEND_NAME,
  FACE_LANDMARK,
} from '../core/face-pose.ts'

// 人脸关键点 → 注视点：这里是纯几何，可以在没有摄像头、没有 wasm 的环境里验。

/** 造一组最小关键点：只有三个下标会被读到，其余留空。 */
function marks(opts: {
  leftEyeX?: number
  rightEyeX?: number
  eyeY?: number
  noseX?: number
  noseY?: number
}) {
  const {
    leftEyeX = 0.4,
    rightEyeX = 0.6,
    eyeY = 0.5,
    noseX = (leftEyeX + rightEyeX) / 2,
    noseY = 0.62,
  } = opts
  const list: Array<{ x: number; y: number }> = []
  list[FACE_LANDMARK.EYE_LEFT_IN_IMAGE] = { x: leftEyeX, y: eyeY }
  list[FACE_LANDMARK.EYE_RIGHT_IN_IMAGE] = { x: rightEyeX, y: eyeY }
  list[FACE_LANDMARK.NOSE_TIP] = { x: noseX, y: noseY }
  return list
}

test('正对镜头：yaw 为 0，鼻尖在眼睛下方', () => {
  const m = faceMetrics(marks({}))
  assert.ok(m)
  assert.equal(m.yaw, 0)
  assert.ok(m.vert > 0, '鼻尖应低于两眼中点')
  assert.ok(Math.abs(m.scale - 0.2) < 1e-9)
})

test('鼻尖偏向图像右侧时 yaw 为正', () => {
  const m = faceMetrics(marks({ noseX: 0.55 }))
  assert.ok(m)
  assert.ok(m.yaw > 0)
  // 偏移 0.05 / 眼距 0.2 = 0.25
  assert.ok(Math.abs(m.yaw - 0.25) < 1e-9)
})

test('减掉基线后就回到画面中心', () => {
  const neutral = faceMetrics(marks({ noseX: 0.55 }))!
  const gaze = gazeFromMetrics(neutral, neutral)
  assert.ok(Math.abs(gaze.x - 0.5) < 1e-9)
  assert.ok(Math.abs(gaze.y - 0.5) < 1e-9)
})

test('偏移会被映射并夹在 0~1 之间', () => {
  const neutral = faceMetrics(marks({}))!
  const right = gazeFromMetrics(faceMetrics(marks({ noseX: 0.9 }))!, neutral)
  const left = gazeFromMetrics(faceMetrics(marks({ noseX: 0.1 }))!, neutral)
  assert.equal(right.x, 1)
  assert.equal(left.x, 0)
  // 垂直方向同理
  const up = gazeFromMetrics(faceMetrics(marks({ noseY: 0.3 }))!, neutral)
  assert.equal(up.y, 0)
})

test('没人脸/脸太小/关键点缺失时返回 null', () => {
  assert.equal(faceMetrics([]), null)
  assert.equal(faceMetrics(marks({ leftEyeX: 0.5, rightEyeX: 0.505 })), null)
  const broken = marks({})
  broken[FACE_LANDMARK.NOSE_TIP] = { x: Number.NaN, y: 0.6 }
  assert.equal(faceMetrics(broken), null)
})

// ---- blendshape → 嘴型/睁眼程度 ----

test('闭嘴的底噪不会让模型一直半张嘴', () => {
  const idle = faceBlendFromScores({
    [FACE_BLEND_NAME.JAW_OPEN]: 0.05,
    [FACE_BLEND_NAME.EYE_BLINK_LEFT]: 0.02,
    [FACE_BLEND_NAME.EYE_BLINK_RIGHT]: 0.03,
  })
  assert.ok(idle)
  assert.equal(idle.mouth, 0)
  assert.ok(idle.eyes > 0.95, `睁眼程度应接近 1，实际 ${idle.eyes}`)
})

test('张大嘴时 mouth 拉满，闭眼时 eyes 归零', () => {
  const open = faceBlendFromScores({
    [FACE_BLEND_NAME.JAW_OPEN]: 0.8,
    [FACE_BLEND_NAME.EYE_BLINK_LEFT]: 1,
    [FACE_BLEND_NAME.EYE_BLINK_RIGHT]: 1,
  })
  assert.ok(open)
  assert.equal(open.mouth, 1)
  assert.equal(open.eyes, 0)
})

test('单眼眨取平均：只闭一半，不会把两只眼一起闭上', () => {
  const wink = faceBlendFromScores({
    [FACE_BLEND_NAME.JAW_OPEN]: 0.1,
    [FACE_BLEND_NAME.EYE_BLINK_LEFT]: 1,
    [FACE_BLEND_NAME.EYE_BLINK_RIGHT]: 0,
  })
  assert.ok(wink)
  assert.equal(wink.eyes, 0.5)
})

test('没有 blendshape 数据时返回 null，调用方才会整帧跳过', () => {
  assert.equal(faceBlendFromScores({}), null)
  assert.equal(faceBlendFromScores({ someOther: 0.5 }), null)
  // 关键点用的键名不是 blendshape 名，同样视为没有
  assert.equal(faceBlendFromScores({ jaw_open: 0.5 }), null)
})

test('越界与 NaN 分数被夹住/忽略', () => {
  const weird = faceBlendFromScores({
    [FACE_BLEND_NAME.JAW_OPEN]: Number.NaN,
    [FACE_BLEND_NAME.EYE_BLINK_LEFT]: -1,
    [FACE_BLEND_NAME.EYE_BLINK_RIGHT]: 9,
  })
  assert.ok(weird)
  // jawOpen 是 NaN：当作没读到，嘴闭着（不是 0.5 那种「半个张嘴」）
  assert.equal(weird.mouth, 0)
  // -1 夹成 0、9 夹成 1，平均 0.5 → 半睁
  assert.equal(weird.eyes, 0.5)
})
