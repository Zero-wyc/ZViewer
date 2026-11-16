import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  alignSign,
  eyeGazeFromLandmarks,
  faceBlendFromScores,
  faceExtrasFromScores,
  faceMetrics,
  gazeFromMetrics,
  headPoseFromMatrix,
  headPoseFromRaw,
  headRollFromLandmarks,
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

// ---- 歪头 ----

/** 造一组只有两个眼角的关键点。 */
function eyeMarks(leftY: number, rightY: number) {
  const list: Array<{ x: number; y: number }> = []
  list[FACE_LANDMARK.EYE_LEFT_IN_IMAGE] = { x: 0.4, y: leftY }
  list[FACE_LANDMARK.EYE_RIGHT_IN_IMAGE] = { x: 0.6, y: rightY }
  return list
}

test('两眼等高时歪头角为 0', () => {
  assert.equal(headRollFromLandmarks(eyeMarks(0.5, 0.5)), 0)
})

test('右眼更低时为正（画面里顺时针）', () => {
  const roll = headRollFromLandmarks(eyeMarks(0.5, 0.6))
  assert.ok(roll !== null && roll > 0.5, `应为明显正值，实际 ${roll}`)
})

test('歪头角被夹在 -1~1', () => {
  const up = headRollFromLandmarks(eyeMarks(1, 0))
  const down = headRollFromLandmarks(eyeMarks(0, 1))
  assert.equal(up, -1)
  assert.equal(down, 1)
})

test('关键点缺失或坐标非法时返回 null', () => {
  assert.equal(headRollFromLandmarks([]), null)
  assert.equal(
    headRollFromLandmarks([
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ]),
    null
  )
  const broken = eyeMarks(0.5, 0.5)
  broken[FACE_LANDMARK.EYE_RIGHT_IN_IMAGE] = { x: Number.NaN, y: 0.5 }
  assert.equal(headRollFromLandmarks(broken), null)
})

// ---- 嘴形 / 眉毛 ----

test('微笑时嘴形为正，撇嘴时为负', () => {
  const smile = faceExtrasFromScores({
    [FACE_BLEND_NAME.MOUTH_SMILE_LEFT]: 0.5,
    [FACE_BLEND_NAME.MOUTH_SMILE_RIGHT]: 0.5,
  })
  assert.ok(smile)
  assert.ok(smile.form > 0.8, `笑应接近满值，实际 ${smile.form}`)

  const frown = faceExtrasFromScores({
    [FACE_BLEND_NAME.MOUTH_FROWN_LEFT]: 0.5,
    [FACE_BLEND_NAME.MOUTH_FROWN_RIGHT]: 0.5,
  })
  assert.ok(frown)
  assert.ok(frown.form < -0.8, `撇嘴应接近负满值，实际 ${frown.form}`)
})

test('中性底噪被死区吃掉，不会一直挂着笑', () => {
  const neutral = faceExtrasFromScores({
    [FACE_BLEND_NAME.MOUTH_SMILE_LEFT]: 0.05,
    [FACE_BLEND_NAME.MOUTH_SMILE_RIGHT]: 0.06,
    [FACE_BLEND_NAME.BROW_INNER_UP]: 0.04,
  })
  assert.ok(neutral)
  assert.equal(neutral.form, 0)
  assert.equal(neutral.brow, 0)
})

test('挑眉为正、皱眉为负', () => {
  const up = faceExtrasFromScores({
    [FACE_BLEND_NAME.BROW_OUTER_UP_LEFT]: 0.6,
    [FACE_BLEND_NAME.BROW_OUTER_UP_RIGHT]: 0.6,
  })
  assert.ok(up && up.brow > 0.8)

  const down = faceExtrasFromScores({
    [FACE_BLEND_NAME.BROW_DOWN_LEFT]: 0.6,
    [FACE_BLEND_NAME.BROW_DOWN_RIGHT]: 0.6,
  })
  assert.ok(down && down.brow < -0.8)
})

test('完全没有相关 blendshape 时返回 null', () => {
  assert.equal(faceExtrasFromScores({}), null)
  assert.equal(faceExtrasFromScores({ jawOpen: 0.5 }), null)
})

test('嘴形与眉毛互不影响（一侧缺数据不拖累另一侧）', () => {
  const onlySmile = faceExtrasFromScores({
    [FACE_BLEND_NAME.MOUTH_SMILE_LEFT]: 0.5,
  })
  assert.ok(onlySmile)
  assert.ok(onlySmile.form > 0)
  assert.equal(onlySmile.brow, 0)
})

// ---- 3D 头部 / 6DOF ----

/**
 * 造一个 4x4 位姿：绕 Y 轴转 yaw，再平移 t。
 *
 * `columnMajor` 控制铺开顺序——同一份姿态按两种布局各铺一遍，用来验证
 * headPoseFromMatrix 的布局自动判定（真实运行时确实两种都存在）。
 */
function poseMatrix(
  yawRad: number,
  t: [number, number, number],
  columnMajor = true
): number[] {
  const c = Math.cos(yawRad)
  const s = Math.sin(yawRad)
  const m = [
    [c, 0, s, t[0]],
    [0, 1, 0, t[1]],
    [-s, 0, c, t[2]],
    [0, 0, 0, 1],
  ]
  const data = new Array<number>(16).fill(0)
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      const index = columnMajor ? j * 4 + i : i * 4 + j
      data[index] = m[i][j]
    }
  }
  return data
}

test('位姿矩阵：列主序与行主序都能解出同一个偏航角', () => {
  const yaw = Math.PI / 6
  const col = headPoseFromMatrix(poseMatrix(yaw, [0, 0, 50], true))
  const row = headPoseFromMatrix(poseMatrix(yaw, [0, 0, 50], false))
  assert.ok(col)
  assert.ok(row)
  assert.ok(Math.abs(col.yaw - yaw) < 1e-6, `列主序 yaw=${col.yaw}`)
  assert.ok(Math.abs(row.yaw - yaw) < 1e-6, `行主序 yaw=${row.yaw}`)
  assert.ok(Math.abs(col.tz - 50) < 1e-9)
  assert.ok(Math.abs(row.tz - 50) < 1e-9)
  // 只绕 Y 转，俯仰与滚转都该是 0
  assert.ok(Math.abs(col.pitch) < 1e-9)
  assert.ok(Math.abs(col.roll) < 1e-9)
})

test('位姿矩阵：数据缺失/含 NaN/距离为 0 时返回 null', () => {
  assert.equal(headPoseFromMatrix(null), null)
  assert.equal(headPoseFromMatrix([1, 0, 0, 0]), null)
  const bad = poseMatrix(0.2, [0, 0, 50])
  bad[5] = Number.NaN
  assert.equal(headPoseFromMatrix(bad), null)
  // tz = 0：后面所有比例都无意义
  assert.equal(headPoseFromMatrix(poseMatrix(0, [0, 0, 0])), null)
})

test('归一化：偏航 40° 拉满，减掉基线后正对镜头为 0', () => {
  const raw = { yaw: 0.3, pitch: 0.1, roll: 0.05, tx: 0, ty: 0, tz: 50 }
  const neutral = {
    yaw: 0.1,
    pitch: 0.08,
    roll: 0.02,
    txRatio: 0,
    tyRatio: 0,
    tz: 50,
  }
  const sample = headPoseFromRaw(raw, neutral, { yaw: 1, pitch: 1, roll: 1 })
  assert.ok(sample)
  // (0.3 - 0.1) / 0.698 ≈ 0.29
  assert.ok(Math.abs(sample.yaw - 0.2865) < 1e-3)
  // 超出 40° 会被钳到 1
  const far = headPoseFromRaw({ ...raw, yaw: 0.1 + Math.PI }, neutral, {
    yaw: 1,
    pitch: 1,
    roll: 1,
  })
  assert.equal(far?.yaw, 1)
})

test('归一化：平移用 tx/tz 比例，深度用相对距离', () => {
  const neutral = {
    yaw: 0,
    pitch: 0,
    roll: 0,
    txRatio: 0,
    tyRatio: 0,
    tz: 50,
  }
  const sample = headPoseFromRaw(
    { yaw: 0, pitch: 0, roll: 0, tx: 15, ty: -7.5, tz: 40 },
    neutral,
    { yaw: 1, pitch: 1, roll: 1 }
  )
  assert.ok(sample)
  // tx/tz = 0.375 → /0.3 已超 1，钳满
  assert.equal(sample.offX, 1)
  // ty/tz = -0.1875 → /0.3 ≈ -0.625
  assert.ok(Math.abs(sample.offY + 0.625) < 1e-3)
  // 50/40 - 1 = 0.25 → /0.3 ≈ 0.833
  assert.ok(Math.abs(sample.depth - 0.8333) < 1e-3)
})

test('符号对齐：同向为 +1，反向为 -1，样本为空时按 +1', () => {
  assert.equal(
    alignSign([
      [0.2, 0.1],
      [0.1, 0.3],
    ]),
    1
  )
  assert.equal(
    alignSign([
      [0.2, -0.1],
      [0.1, -0.3],
    ]),
    -1
  )
  assert.equal(alignSign([]), 1)
  // NaN 不参与：只剩一个有效样本，仍按它的方向判
  assert.equal(
    alignSign([
      [Number.NaN, 1],
      [-0.5, 0.5],
    ]),
    -1
  )
})

// ---- 眼球（虹膜） ----

/** 造 478 个点，只填两只眼与虹膜，其余堆在原点。 */
function irisMarks(shiftX = 0, shiftY = 0) {
  const list = new Array(478).fill(null).map(() => ({ x: 0, y: 0 }))
  // 图像左侧眼睛：外眼角 0.40 → 内眼角 0.46，眼高 0.48~0.52
  list[FACE_LANDMARK.EYE_LEFT_IN_IMAGE] = { x: 0.4, y: 0.5 }
  list[FACE_LANDMARK.EYE_LEFT_INNER] = { x: 0.46, y: 0.5 }
  list[FACE_LANDMARK.EYE_LEFT_UPPER] = { x: 0.43, y: 0.48 }
  list[FACE_LANDMARK.EYE_LEFT_LOWER] = { x: 0.43, y: 0.52 }
  list[FACE_LANDMARK.IRIS_LEFT] = { x: 0.43 + shiftX, y: 0.5 + shiftY }
  // 图像右侧眼睛：内眼角 0.54 → 外眼角 0.60
  list[FACE_LANDMARK.EYE_RIGHT_INNER] = { x: 0.54, y: 0.5 }
  list[FACE_LANDMARK.EYE_RIGHT_IN_IMAGE] = { x: 0.6, y: 0.5 }
  list[FACE_LANDMARK.EYE_RIGHT_UPPER] = { x: 0.57, y: 0.48 }
  list[FACE_LANDMARK.EYE_RIGHT_LOWER] = { x: 0.57, y: 0.52 }
  list[FACE_LANDMARK.IRIS_RIGHT] = { x: 0.57 + shiftX, y: 0.5 + shiftY }
  return list
}

test('虹膜居中时眼球方向为 0，向右移时为正', () => {
  const center = eyeGazeFromLandmarks(irisMarks())
  assert.ok(center)
  assert.ok(Math.abs(center.x) < 1e-9)
  assert.ok(Math.abs(center.y) < 1e-9)

  // 右移 0.012 = 眼宽的 20% → (0.7-0.5)*2*2.2 ≈ 0.88
  const right = eyeGazeFromLandmarks(irisMarks(0.012, 0))
  assert.ok(right)
  assert.ok(right.x > 0.8 && right.x < 0.95, `实际 ${right?.x}`)
  // 两眼对称：浮点末位会差 1e-15，按近似比
  assert.ok(Math.abs(right.left.x - right.right.x) < 1e-9)
})

test('虹膜偏下时 y 为正（几何直觉：图像坐标向下）', () => {
  const down = eyeGazeFromLandmarks(irisMarks(0, 0.008))
  assert.ok(down)
  assert.ok(down.y > 0)
})

test('没有虹膜（468 点模型）或眼睛太小/闭眼时返回 null', () => {
  const short = irisMarks().slice(0, 468)
  assert.equal(eyeGazeFromLandmarks(short), null)

  const tiny = irisMarks()
  // 把眼睛压成一条缝：高度不足阈值，比例不可信
  tiny[FACE_LANDMARK.EYE_LEFT_UPPER] = { x: 0.43, y: 0.5 }
  tiny[FACE_LANDMARK.EYE_LEFT_LOWER] = { x: 0.43, y: 0.5005 }
  tiny[FACE_LANDMARK.EYE_RIGHT_UPPER] = { x: 0.57, y: 0.5 }
  tiny[FACE_LANDMARK.EYE_RIGHT_LOWER] = { x: 0.57, y: 0.5005 }
  assert.equal(eyeGazeFromLandmarks(tiny), null)
})
