import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  faceMetrics,
  gazeFromMetrics,
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
