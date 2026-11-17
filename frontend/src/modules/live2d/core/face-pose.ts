// 人脸关键点 → 注视方向。
//
// 这里刻意只做几何换算，不碰 MediaPipe 的类型：输入就是一组归一化坐标
// （0~1，相对画面），这样单测不依赖 wasm，也不会把 ML 包拖进测试进程。

export interface FaceLandmark {
  x: number
  y: number
}

/** MediaPipe FaceMesh 的关键点下标（468 点模型 + 10 点虹膜，官方固定值）。 */
export const FACE_LANDMARK = {
  /** 图像左侧的外眼角（被拍者的右眼） */
  EYE_LEFT_IN_IMAGE: 33,
  /** 图像右侧的外眼角（被拍者的左眼） */
  EYE_RIGHT_IN_IMAGE: 263,
  /** 图像左侧的内眼角 */
  EYE_LEFT_INNER: 133,
  /** 图像右侧的内眼角 */
  EYE_RIGHT_INNER: 362,
  /** 图像左侧眼睛的上/下眼睑（虹膜垂直比例用） */
  EYE_LEFT_UPPER: 159,
  EYE_LEFT_LOWER: 145,
  /** 图像右侧眼睛的上/下眼睑 */
  EYE_RIGHT_UPPER: 386,
  EYE_RIGHT_LOWER: 374,
  /**
   * 虹膜中心（478 点模型才有）。
   *
   * 468 点模型在这里是 undefined——`eyeGazeFromLandmarks` 会先看长度再取，
   * 老运行时不会因此拿到 NaN。
   */
  IRIS_LEFT: 468,
  IRIS_RIGHT: 473,
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
  /** 睁眼程度：0 = 闭眼，1 = 全睁（左右眼的平均值，给只认单通道的老协议用） */
  eyes: number
  /**
   * 左右眼各自的睁眼程度。
   *
   * 与 eyes 平均值的差别只在单眼眨（wink）时有意义：平均值把 wink 磨成
   * 半闭，看起来像眯眼；分开写才能真的眨一只。协议里仍然带平均值（`e`），
   * 两只眼的独立值走扩展姿态数组——老客户端读到平均值也能正常跑。
   */
  eyeLeft: number
  eyeRight: number
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
 * `eyes` 仍取**平均**（协议与老客户端的兼容口径），另外单独给出左右眼：
 * 渲染器用独立值，wink 才能真的只闭一只。
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
  const eyeLeft = 1 - (clampScore(blinkL) ?? 0)
  const eyeRight = 1 - (clampScore(blinkR) ?? 0)
  return {
    mouth: clamp01(((clampScore(jaw) ?? 0) - MOUTH_DEADZONE) / MOUTH_SPAN),
    eyes: clamp01((eyeLeft + eyeRight) / 2),
    eyeLeft: clamp01(eyeLeft),
    eyeRight: clamp01(eyeRight),
  }
}

function clampScore(v: number | undefined): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

// ---------------------------------------------------------------------------
// 侧脸眨眼补偿
// ---------------------------------------------------------------------------

/**
 * 归一化偏航超过这个值开始补偿（≈18°），超过 `BLINK_OCCLUDE_FULL`（≈36°）完全补偿。
 *
 * 为什么不从 0 就开始：正脸时两侧眼的分都很准，任何插值都是在凭空抹信息——
 * 一个真 wink 会被磨成半闭。
 */
export const BLINK_OCCLUDE_START = 0.45
export const BLINK_OCCLUDE_FULL = 0.9

/**
 * 侧脸时把**远侧那只眼**的睁眼程度往近侧那只眼拉。
 *
 * 要解决的问题：头转过 35° 之后，靠里那只眼会被鼻梁和脸颊挡住大半，
 * MediaPipe 给出的 `eyeBlink*` 对这只眼就不可信了——最常见的形态是**一直
 * 判成闭着**（模型上一只眼永远闭着），次要形态是随角度抖动（看起来像抽搐）。
 * 检测器层面修不了，但几何上这件事是明摆着的：偏航越大，远侧眼越不可信。
 *
 * **单向**补偿（远侧比近侧闭得更多时才拉），不做无条件覆盖：
 *   - 用户真的在 wink 时远侧未必更闭，此时不动，wink 保留；
 *   - 近侧眼闭（正常眨眼）时远侧跟着闭，符合「眨眼是双侧的」这一先验。
 *
 * @param blend 原始（未平滑）表情
 * @param yaw 归一化头部偏航 -1~1，正值 = 脸朝图像右侧（与 head.x 同向）
 */
export function stabilizeBlinkByYaw(blend: FaceBlend, yaw: number): FaceBlend {
  const weight = occlusionWeight(yaw)
  if (weight <= 0) return blend
  // 脸朝图像右（yaw > 0）→ 图像左侧那只眼离镜头更远；而图像左侧的眼正是
  // 被拍者的右眼（镜像），也就是协议里的 eyeRight。
  const faceTowardRight = yaw > 0
  const near = faceTowardRight ? blend.eyeLeft : blend.eyeRight
  const far = faceTowardRight ? blend.eyeRight : blend.eyeLeft
  if (far >= near) return blend
  const fixed = far + (near - far) * weight
  const eyeLeft = faceTowardRight ? near : fixed
  const eyeRight = faceTowardRight ? fixed : near
  return {
    mouth: blend.mouth,
    // 平均值要跟着改：它单独走协议里的 `e` 通道，不改就会和左右眼对不上
    eyes: clamp01((eyeLeft + eyeRight) / 2),
    eyeLeft: clamp01(eyeLeft),
    eyeRight: clamp01(eyeRight),
  }
}

/** 偏航 → 补偿权重：0（正脸，不动）~ 1（侧到看不见远侧眼，完全跟随）。 */
function occlusionWeight(yaw: number): number {
  const mag = Math.abs(yaw)
  if (!Number.isFinite(mag)) return 0
  if (mag <= BLINK_OCCLUDE_START) return 0
  if (mag >= BLINK_OCCLUDE_FULL) return 1
  return (
    (mag - BLINK_OCCLUDE_START) / (BLINK_OCCLUDE_FULL - BLINK_OCCLUDE_START)
  )
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

// ---------------------------------------------------------------------------
// 眼球跟随：虹膜相对眼窝的位置
// ---------------------------------------------------------------------------

/** 一只眼睛的方向，-1（图像左/下）~ 1（图像右/上）。 */
export interface EyeDirection {
  x: number
  y: number
}

/**
 * 虹膜在眼窝里的归一化位置映射成 -1~1 的增益。
 *
 * 虹膜自然活动范围只占眼窝宽度的中间约 40%（`0.3~0.7`），不放大就永远
 * 走不到 Cubism 的 ±1，模型看着像"眼睛不动"；2.2 倍刚好把常见范围铺满，
 * 再大就会让急促的扫视瞬间撞到钳制边界。
 */
const EYE_GAZE_GAIN = 2.2

/**
 * 从虹膜关键点算双眼指向（图像坐标系，x 右为正、y **下**为正）。
 *
 * 返回 null 的三种情况都要区分清楚：
 *   - 关键点不足 478 个 → 运行时没给虹膜（老模型/老运行时），整条通路关掉；
 *   - 眼宽不足 → 人离得太远，比例全是噪声；
 *   - 数值非有限 → 这一帧检测崩了。
 *
 * 两眼的水平/垂直比例各自算完再平均：单眼被头发遮住时，另一只眼还能撑住
 * 画面，而不是整只模型的眼睛突然停住。
 */
export function eyeGazeFromLandmarks(
  landmarks: readonly FaceLandmark[]
): { left: EyeDirection; right: EyeDirection; x: number; y: number } | null {
  const left = eyeRatio(
    landmarks,
    FACE_LANDMARK.IRIS_LEFT,
    FACE_LANDMARK.EYE_LEFT_IN_IMAGE,
    FACE_LANDMARK.EYE_LEFT_INNER,
    FACE_LANDMARK.EYE_LEFT_UPPER,
    FACE_LANDMARK.EYE_LEFT_LOWER
  )
  const right = eyeRatio(
    landmarks,
    FACE_LANDMARK.IRIS_RIGHT,
    FACE_LANDMARK.EYE_RIGHT_IN_IMAGE,
    FACE_LANDMARK.EYE_RIGHT_INNER,
    FACE_LANDMARK.EYE_RIGHT_UPPER,
    FACE_LANDMARK.EYE_RIGHT_LOWER
  )
  if (!left && !right) return null
  const xs = [left?.x, right?.x].filter((v): v is number => v !== undefined)
  const ys = [left?.y, right?.y].filter((v): v is number => v !== undefined)
  return {
    left: left ?? { x: 0, y: 0 },
    right: right ?? { x: 0, y: 0 },
    x: xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length),
    y: ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length),
  }
}

/**
 * 单眼：虹膜中心在「内外眼角 / 上下眼睑」之间的比例。
 *
 * 用 min/max 而不是固定"外→内"的顺序：左右眼的索引方向相反，靠坐标排序
 * 取范围就不必在下标上做特判（写反了会得到一只眼睛反着转的经典 bug）。
 */
function eyeRatio(
  landmarks: readonly FaceLandmark[],
  irisIdx: number,
  cornerA: number,
  cornerB: number,
  lidA: number,
  lidB: number
): EyeDirection | null {
  const iris = landmarks[irisIdx]
  const a = landmarks[cornerA]
  const b = landmarks[cornerB]
  const up = landmarks[lidA]
  const down = landmarks[lidB]
  if (!iris || !a || !b || !up || !down) return null
  const values = [iris.x, iris.y, a.x, b.x, up.y, down.y]
  if (!values.every(Number.isFinite)) return null

  const xMin = Math.min(a.x, b.x)
  const xMax = Math.max(a.x, b.x)
  const yMin = Math.min(up.y, down.y)
  const yMax = Math.max(up.y, down.y)
  const eyeW = xMax - xMin
  const eyeH = yMax - yMin
  // 眼宽不足 0.4% 屏宽 ≈ 人已经退到镜头外；高度太小说明闭着眼（虹膜被压住）
  if (eyeW < 0.004 || eyeH < 0.002) return null

  const tx = (iris.x - xMin) / eyeW
  const ty = (iris.y - yMin) / eyeH
  return {
    x: clampSigned((tx - 0.5) * 2 * EYE_GAZE_GAIN),
    // 图像 y 向下：虹膜偏下 = 往下看。这里保持几何直觉，渲染时再翻符号。
    y: clampSigned((ty - 0.5) * 2 * EYE_GAZE_GAIN),
  }
}

// ---------------------------------------------------------------------------
// 头部姿态：4x4 位姿矩阵 → 偏航/俯仰/滚转 + 三轴平移（6DOF）
// ---------------------------------------------------------------------------

/** 位姿矩阵解出来的原始量（未减基线、未归一化）。 */
export interface RawHeadPose {
  /** 偏航（绕 Y 轴），弧度，正负由具体运行时的坐标系决定 */
  yaw: number
  /** 俯仰（绕 X 轴），弧度 */
  pitch: number
  /** 滚转（绕 Z 轴），弧度 */
  roll: number
  /** 平移（与规范人脸模型同单位，量级约等于"离镜头多少厘米"） */
  tx: number
  ty: number
  tz: number
}

/**
 * 从 MediaPipe 的 `facialTransformationMatrixes[0].data` 解出 6DOF 姿态。
 *
 * **布局要自己判**：同一个 `Matrix` 结构在不同运行时里既有按列存（OpenGL
 * 惯例）也有按行存的。旋转部分两种解释都"合法"（转置仍是旋转矩阵），所以
 * 不能靠正交性区分；能区分的是**平移**——旋转项绝对值 ≤1，而人脸离镜头
 * 几十厘米，平移项量级是 10~100。取两者中平移模长更大的那种解释。
 */
export function headPoseFromMatrix(
  data: readonly number[] | null | undefined
): RawHeadPose | null {
  if (!data || data.length < 16) return null
  if (!Array.from(data).every(Number.isFinite)) return null

  const col = readMatrix(data, true)
  const row = readMatrix(data, false)
  const m = magnitude(row) > magnitude(col) ? row : col

  // tz 是"脸到相机的距离"，为 0 或负数时后面的比例全无意义
  if (!(Math.abs(m.tz) > 1e-6)) return null

  const pitch = Math.asin(clampNum(-m.r12, -1, 1))
  const yaw = Math.atan2(m.r02, m.r22)
  const roll = Math.atan2(m.r10, m.r11)
  return { yaw, pitch, roll, tx: m.tx, ty: m.ty, tz: m.tz }
}

interface MatrixPart {
  r02: number
  r10: number
  r11: number
  r12: number
  r22: number
  tx: number
  ty: number
  tz: number
}

/**
 * 按指定布局读出需要的六个旋转项与平移。
 *
 * 只取计算用得到的分量：4x4 里我们不需要透视行，也不需要完整的 9 个
 * 旋转项——少读几个数字，热路径上少一次索引换算。
 */
function readMatrix(data: readonly number[], columnMajor: boolean): MatrixPart {
  const at = (r: number, c: number) =>
    columnMajor ? data[c * 4 + r] : data[r * 4 + c]
  return {
    r02: at(0, 2),
    r10: at(1, 0),
    r11: at(1, 1),
    r12: at(1, 2),
    r22: at(2, 2),
    tx: at(0, 3),
    ty: at(1, 3),
    tz: at(2, 3),
  }
}

function magnitude(m: MatrixPart): number {
  return Math.hypot(m.tx, m.ty, m.tz)
}

/** 归一化后的头部姿态，全部 -1~1（0 = 正对镜头）。 */
export interface HeadPoseSample {
  yaw: number
  pitch: number
  roll: number
  /** 头部左右平移造成的视差（正 = 向右） */
  offX: number
  /** 上下平移造成的视差（正 = 向下） */
  offY: number
  /** 前后移动（正 = 靠近镜头） */
  depth: number
}

/** 偏航 ±40°、俯仰 ±30° 就算"转到头"；滚转复用上面的 MAX_ROLL_RAD（±35°）。 */
const MAX_YAW_RAD = 0.698
const MAX_PITCH_RAD = 0.524
/** 平移用「位移 / 距离」的比值归一化：换个人坐得远近不同，比例才对得上。 */
const OFFSET_SPAN = 0.3
/** 深度用相对变化量归一化：前后挪 30% 距离算"到头"。 */
const DEPTH_SPAN = 0.3

/** 标定基线：正对镜头时各项的原始值。 */
export interface HeadPoseNeutral {
  yaw: number
  pitch: number
  roll: number
  /** tx/tz：与距离无关的水平偏移比例 */
  txRatio: number
  tyRatio: number
  tz: number
}

/**
 * 原始姿态 → -1~1。
 *
 * `signs` 是三个 ±1：不同运行时的坐标系朝向不一致（有的把"向左转"记为正），
 * 靠标定期与几何量做相关自动对齐（见 face-tracker 的 alignSigns），这里只负责
 * 乘上去。把它做成参数而不是三个 if，是因为符号错一次就会让"点头变成摇头"，
 * 必须有单测锁住。
 */
export function headPoseFromRaw(
  raw: RawHeadPose,
  neutral: HeadPoseNeutral,
  signs: { yaw: number; pitch: number; roll: number }
): HeadPoseSample | null {
  if (!(Math.abs(raw.tz) > 1e-6)) return null
  const txRatio = raw.tx / raw.tz
  const tyRatio = raw.ty / raw.tz
  return {
    yaw: clampSigned(
      (signs.yaw * wrapAngle(raw.yaw - neutral.yaw)) / MAX_YAW_RAD
    ),
    pitch: clampSigned(
      (signs.pitch * wrapAngle(raw.pitch - neutral.pitch)) / MAX_PITCH_RAD
    ),
    roll: clampSigned(
      (signs.roll * wrapAngle(raw.roll - neutral.roll)) / MAX_ROLL_RAD
    ),
    offX: clampSigned((txRatio - neutral.txRatio) / OFFSET_SPAN),
    offY: clampSigned((tyRatio - neutral.tyRatio) / OFFSET_SPAN),
    depth: clampSigned((neutral.tz / raw.tz - 1) / DEPTH_SPAN),
  }
}

/**
 * 由标定样本与几何量的乘积和判断符号。
 *
 * 为什么能用乘积：标定期间用户基本正对镜头，微小的自然晃动里，几何量与
 * 矩阵量测的是同一件事——同向则乘积为正，反向则乘积为负。12 个样本的
 * 和足以压过噪声，又不需要用户刻意配合。
 *
 * 和为 0（几乎没动）时按 +1：这是"没有证据"而不是"证据指向反向"。
 */
export function alignSign(samples: ReadonlyArray<[number, number]>): number {
  let sum = 0
  for (const [a, b] of samples) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    sum += a * b
  }
  return sum < 0 ? -1 : 1
}

/** 角度差折到 -π~π：跨过 ±180° 时不能让差值突然变成 300°。 */
function wrapAngle(rad: number): number {
  if (!Number.isFinite(rad)) return 0
  let v = rad
  while (v > Math.PI) v -= Math.PI * 2
  while (v < -Math.PI) v += Math.PI * 2
  return v
}

function clampNum(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < min) return min
  if (v > max) return max
  return v
}
