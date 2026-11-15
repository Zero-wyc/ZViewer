// 人脸关键点 → 注视方向。
//
// 这里刻意只做几何换算，不碰 MediaPipe 的类型：输入就是一组归一化坐标
// （0~1，相对画面），这样单测不依赖 wasm，也不会把 ML 包拖进测试进程。

export interface FaceLandmark {
  x: number
  y: number
}

/** MediaPipe FaceMesh 的关键点下标（468 点模型，官方固定值）。 */
export const FACE_LANDMARK = {
  /** 图像左侧的外眼角（被拍者的右眼） */
  EYE_LEFT_IN_IMAGE: 33,
  /** 图像右侧的外眼角（被拍者的左眼） */
  EYE_RIGHT_IN_IMAGE: 263,
  /** 鼻尖 */
  NOSE_TIP: 1,
  /** 下巴尖（预览绘制与俯仰备用） */
  CHIN: 152,
  /** 眉间（预览绘制用） */
  GLABELLA: 9,
} as const

/**
 * 预览窗要描的关键点轮廓（FaceMesh 468 点里的固定下标）。
 *
 * 只描轮廓而不是全画 468 个点：全画在 160px 宽的小窗里糊成一片噪点，
 * 看不出「检测到的是不是我的脸」。这几组是官方示例里最常用的拓扑。
 */
export const FACE_OUTLINE = {
  /** 脸轮廓（从右耳根绕到左耳根） */
  FACE: [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
    378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
    162, 21, 54, 103, 67, 109,
  ],
  EYE_LEFT: [33, 7, 163, 144, 145, 153, 154, 155, 133, 33],
  EYE_RIGHT: [263, 249, 390, 373, 374, 380, 381, 382, 362, 263],
  /** 眉毛：监视窗骨架模式里，挑眉/皱眉就靠这两条线看 */
  BROW_LEFT: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46, 70],
  BROW_RIGHT: [336, 296, 334, 293, 300, 285, 295, 282, 283, 276, 336],
  /** 嘴唇外圈 */
  MOUTH: [
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0,
    37, 39, 40, 185, 61,
  ],
} as const

export interface FaceMetrics {
  /** 鼻尖相对两眼中点的水平偏移，处以眼距归一化。正值=鼻尖偏向图像右侧 */
  yaw: number
  /** 鼻尖相对两眼中点的垂直偏移，处以眼距归一化。正值=鼻尖偏下（低头） */
  vert: number
  /** 眼距（归一化坐标），用来判断人脸是否够大、够正 */
  scale: number
}

/**
 * 从关键点算 yaw / vert。人脸太小（离镜头太远）或侧到只剩半张脸时返回 null：
 * 这时的比例全是噪声，喂给模型只会让它抽搐。
 */
export function faceMetrics(
  landmarks: readonly FaceLandmark[]
): FaceMetrics | null {
  const a = landmarks[FACE_LANDMARK.EYE_LEFT_IN_IMAGE]
  const b = landmarks[FACE_LANDMARK.EYE_RIGHT_IN_IMAGE]
  const nose = landmarks[FACE_LANDMARK.NOSE_TIP]
  if (!a || !b || !nose) return null
  if (![a.x, a.y, b.x, b.y, nose.x, nose.y].every(Number.isFinite)) return null

  const eyeDist = Math.abs(b.x - a.x)
  // 0.02 ≈ 画面宽度 2%。比这更小说明人离得很远，比例已经不可信。
  if (eyeDist < 0.02) return null

  const eyeMidX = (a.x + b.x) / 2
  const eyeMidY = (a.y + b.y) / 2
  return {
    yaw: (nose.x - eyeMidX) / eyeDist,
    vert: (nose.y - eyeMidY) / eyeDist,
    scale: eyeDist,
  }
}

/** yaw 一个单位对应多少屏宽。转头 ±0.3 时大致到头像左右边缘。 */
const YAW_GAIN = 1.15
/** 垂直方向变化幅度小得多（鼻子上下移动有限），所以放大得多一些。 */
const VERT_GAIN = 2.6

/**
 * 把 metrics 映射成 0~1 的注视点。
 *
 * neutral 是「正对镜头」时的基线（启动后自动标定）：不同人的脸型、坐姿、
 * 摄像头俯仰角差别很大，不减基线的话有人一开就是仰头看天。
 */
export function gazeFromMetrics(
  metrics: FaceMetrics,
  neutral: FaceMetrics | null
): { x: number; y: number } {
  const baseYaw = neutral?.yaw ?? 0
  const baseVert = neutral?.vert ?? 0
  return {
    x: clamp01(0.5 + (metrics.yaw - baseYaw) * YAW_GAIN),
    y: clamp01(0.5 + (metrics.vert - baseVert) * VERT_GAIN),
  }
}

// ---------------------------------------------------------------------------
// 面部表情（blendshape）
// ---------------------------------------------------------------------------

/**
 * MediaPipe FaceLandmarker 的 blendshape 名字（ARKit 那套 52 组里我们用到的）。
 *
 * 这些是**检测输出**的类别名，不是 Live2D 的参数名；两者在 renderer 里对接
 * （jawOpen → ParamMouthOpenY，eyeBlink* → ParamEyeL/ROpen）。
 */
export const FACE_BLEND_NAME = {
  JAW_OPEN: 'jawOpen',
  EYE_BLINK_LEFT: 'eyeBlinkLeft',
  EYE_BLINK_RIGHT: 'eyeBlinkRight',
  MOUTH_SMILE_LEFT: 'mouthSmileLeft',
  MOUTH_SMILE_RIGHT: 'mouthSmileRight',
  MOUTH_FROWN_LEFT: 'mouthFrownLeft',
  MOUTH_FROWN_RIGHT: 'mouthFrownRight',
  BROW_INNER_UP: 'browInnerUp',
  BROW_OUTER_UP_LEFT: 'browOuterUpLeft',
  BROW_OUTER_UP_RIGHT: 'browOuterUpRight',
  BROW_DOWN_LEFT: 'browDownLeft',
  BROW_DOWN_RIGHT: 'browDownRight',
} as const

/** 驱动模型的一组面部姿态，全部归一化到 0~1。 */
export interface FaceBlend {
  /** 张嘴幅度：0 = 闭着，1 = 张到最大 */
  mouth: number
  /** 睁眼程度：0 = 闭眼，1 = 全睁 */
  eyes: number
}

/** 闭嘴时 jawOpen 也有 0.02~0.1 的底噪，减掉它才不会一直半张嘴。 */
const MOUTH_DEADZONE = 0.08
/** jawOpen 到 0.58 就算「张到最大」——再往后表情已经变形，继续放大只会穿模。 */
const MOUTH_SPAN = 0.5

/**
 * 从 blendshape 分数算嘴型/睁眼程度。
 *
 * 一个都没取到就返回 null：说明这一帧检测器没给出表情数据（老版本运行时不支持
 * blendshape），此时调用方应当整帧跳过，而不是把模型按成闭嘴。
 *
 * 左右眼取**平均**而不是取更闭的那只：单眼眨（wink）平均下来是半闭，看起来像
 * 眯一下；取 max 会把两只眼一起闭上，反而更怪。
 */
export function faceBlendFromScores(
  scores: Record<string, number | undefined>
): FaceBlend | null {
  const jaw = scores[FACE_BLEND_NAME.JAW_OPEN]
  const blinkL = scores[FACE_BLEND_NAME.EYE_BLINK_LEFT]
  const blinkR = scores[FACE_BLEND_NAME.EYE_BLINK_RIGHT]
  if (jaw === undefined && blinkL === undefined && blinkR === undefined) {
    return null
  }
  const blink = ((clampScore(blinkL) ?? 0) + (clampScore(blinkR) ?? 0)) / 2
  return {
    mouth: clamp01(((clampScore(jaw) ?? 0) - MOUTH_DEADZONE) / MOUTH_SPAN),
    eyes: clamp01(1 - blink),
  }
}

function clampScore(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

// ---------------------------------------------------------------------------
// 头部姿态：歪头
// ---------------------------------------------------------------------------

/**
 * 两眼连线达到这个倾角就算「歪到底」。
 *
 * 0.61 rad ≈ 35°：正常人自然歪头在 ±20° 内，35° 已经是很夸张的撒娇姿势。
 * 超过它按满值处理——检测器在侧脸/遮挡时会给出离谱的角度，钳住比放大好。
 */
const MAX_ROLL_RAD = 0.61

/**
 * 从两眼外眼角连线算歪头角，返回 -1（向左倒）~ 1（向右倒），0 为端正。
 *
 * 为什么不用 FaceMesh 的变换矩阵：那需要 4x4 位姿解算，而**歪头**恰好是
 * 单凭两个点就能稳定拿到的一维量——眼线角度不受嘴、眉、发型影响，也几乎
 * 不受距离影响。把它单独算出来，比让注视点顺便带一点扭转准得多。
 *
 * 图像坐标 y 向下，所以 atan2 的正值是「右侧更低」= 画面里顺时针，也就是
 * 被拍者向左歪头。符号在 renderer 里统一反过来用，这里保持几何直觉。
 */
export function headRollFromLandmarks(
  landmarks: readonly FaceLandmark[]
): number | null {
  const a = landmarks[FACE_LANDMARK.EYE_LEFT_IN_IMAGE]
  const b = landmarks[FACE_LANDMARK.EYE_RIGHT_IN_IMAGE]
  if (!a || !b) return null
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null
  // 两点重合时角度无意义（检测崩溃的那一帧）
  if (Math.abs(b.x - a.x) < 1e-6 && Math.abs(b.y - a.y) < 1e-6) return null
  const rad = Math.atan2(b.y - a.y, b.x - a.x)
  return clampSigned(rad / MAX_ROLL_RAD)
}

// ---------------------------------------------------------------------------
// 表情细节：嘴形（笑/撇嘴）与眉毛（挑眉/皱眉）
// ---------------------------------------------------------------------------

/**
 * 嘴形与眉毛，各自 -1~1。
 *
 * 与 FaceBlend 分开是因为它们**语义不同**：mouth/eyes 是「器官张开程度」，
 * 直接写 ParamMouthOpenY / ParamEyeOpen；这两个是「表情形状」，写的是
 * ParamMouthForm / ParamBrowLY/RY，中位是 0 而不是「张开」。
 * 混在一个结构里很容易在 renderer 里把 0.5 当成「半张嘴」。
 */
export interface FaceExtras {
  /** 嘴形：-1 撇嘴、0 中性、1 笑 */
  form: number
  /** 眉毛：-1 皱眉、0 中性、1 挑眉 */
  brow: number
}

/** 笑/撇嘴、挑眉/皱眉各自超过这个分数才算「真的在做表情」。 */
const EXPRESSION_DEADZONE = 0.12
/** 归一化除数：分数 0.5 就基本做满（检测器的 1.0 很少出现）。 */
const EXPRESSION_SPAN = 0.38

/**
 * 从 blendshape 分数算嘴形与眉毛。
 *
 * 全都没读到返回 null：与 faceBlendFromScores 同一条约定，调用方整帧跳过，
 * 不能把「没数据」当成「中性表情」——那会在断流时把笑脸抹平。
 */
export function faceExtrasFromScores(
  scores: Record<string, number | undefined>
): FaceExtras | null {
  const smile = pairMean(
    scores[FACE_BLEND_NAME.MOUTH_SMILE_LEFT],
    scores[FACE_BLEND_NAME.MOUTH_SMILE_RIGHT]
  )
  const frown = pairMean(
    scores[FACE_BLEND_NAME.MOUTH_FROWN_LEFT],
    scores[FACE_BLEND_NAME.MOUTH_FROWN_RIGHT]
  )
  const browUp = pairMean(
    scores[FACE_BLEND_NAME.BROW_OUTER_UP_LEFT],
    scores[FACE_BLEND_NAME.BROW_OUTER_UP_RIGHT],
    scores[FACE_BLEND_NAME.BROW_INNER_UP]
  )
  const browDown = pairMean(
    scores[FACE_BLEND_NAME.BROW_DOWN_LEFT],
    scores[FACE_BLEND_NAME.BROW_DOWN_RIGHT]
  )
  if (
    smile === undefined &&
    frown === undefined &&
    browUp === undefined &&
    browDown === undefined
  ) {
    return null
  }
  return {
    form: signedExpression((smile ?? 0) - (frown ?? 0)),
    brow: signedExpression((browUp ?? 0) - (browDown ?? 0)),
  }
}

/** 已定义分数的平均；一个都没有就是 undefined（不是 0）。 */
function pairMean(...values: Array<number | undefined>): number | undefined {
  let sum = 0
  let count = 0
  for (const raw of values) {
    const v = clampScore(raw)
    if (v === undefined) continue
    sum += v
    count += 1
  }
  if (count === 0) return undefined
  return sum / count
}

/** 分数差 → -1~1：先减底噪再拉伸，最后钳住。 */
function signedExpression(diff: number): number {
  const magnitude = Math.abs(diff)
  if (magnitude <= EXPRESSION_DEADZONE) return 0
  const scaled = (magnitude - EXPRESSION_DEADZONE) / EXPRESSION_SPAN
  return clampSigned(diff < 0 ? -scaled : scaled)
}

function clampSigned(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < -1) return -1
  if (v > 1) return 1
  return v
}
