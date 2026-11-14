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
