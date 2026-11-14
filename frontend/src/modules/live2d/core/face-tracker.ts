import type {
  FaceLandmarker,
  FaceLandmarkerResult,
} from '@mediapipe/tasks-vision'
import { t } from '@/i18n'
import {
  faceBlendFromScores,
  faceExtrasFromScores,
  faceMetrics,
  gazeFromMetrics,
  headRollFromLandmarks,
  type FaceBlend,
  type FaceExtras,
  type FaceLandmark,
  type FaceMetrics,
} from './face-pose'
import { supportsWasmSimd } from './wasm-simd'

// 摄像头动捕：本地人脸检测 → 归一化注视点 + 面部表情，交给上行链路。
//
// 几条硬约束：
//   - **画面不出本机**：getUserMedia 的流只喂给离屏 <video>，检测在本机跑，
//     不发网络、不落盘。上行链路只发算出来的 0~1 坐标与张/闭程度。
//   - **按需加载**：MediaPipe 的 JS 与 11MB wasm 只有在用户点开开关时才拉，
//     而且用动态 import 单独切块，不进房间页的主链路。
//   - **失败要能说清**：权限拒绝 / 没有摄像头 / 被占用是三种完全不同的处理，
//     统一报「打开失败」用户只会反复点开关。

const WASM_BASE = '/live2d/face/wasm'
const MODEL_URL = '/live2d/face/face_landmarker.task'

/** 检测频率 ~15fps：够跟手，又不至于把 CPU 吃满（推理本身是 20~40ms/帧）。 */
const DETECT_INTERVAL_MS = 66
/** 标定采样数：约 0.8 秒，让用户刚打开时不用刻意静止太久。 */
const NEUTRAL_SAMPLES = 12
/** 平滑系数：越小越稳但越迟钝。0.35 在 15fps 下手感比较自然。 */
const SMOOTH_ALPHA = 0.35
/**
 * 表情的平滑系数要比视线大：说句话的时间尺度是 100ms 级，用 0.35 会把每个字
 * 都磨平成一条缓慢起伏的曲线，看起来像慢动作。0.55 在 15fps 下仍能压住抖动。
 */
const BLEND_SMOOTH_ALPHA = 0.55
/**
 * 歪头的平滑系数：比视线稍快（歪头是主动动作，用户期望跟手），
 * 但检测器对这种「单点噪声放大」很敏感，再快就会看到肉眼可见的抖动。
 */
const ROLL_SMOOTH_ALPHA = 0.4
/** 多久没检测到人脸就放弃接管（交回鼠标）。 */
const FACE_LOST_MS = 1200

export type FaceTrackerStatus = 'starting' | 'tracking' | 'no-face'

/**
 * 一帧动捕的完整结果。
 *
 * 把原来分散的 gaze / blend 收进一个结构：调用方（上行链路）需要的是
 * 「这一帧能驱动什么」，而不是三个各自可能为 null 的 getter——分开取时
 * 很容易在某个为 null 的分支上把模型按成奇怪的表情。
 */
export interface FacePose {
  /** 0~1 注视点 */
  gaze: { x: number; y: number }
  /** 张嘴幅度 0~1 */
  mouth: number
  /** 睁眼程度 0~1 */
  eyes: number
  /** 嘴形 -1（撇嘴）~ 1（笑） */
  form: number
  /** 眉毛 -1（皱眉）~ 1（挑眉） */
  brow: number
  /** 歪头 -1（向左倒）~ 1（向右倒） */
  roll: number
}

/** 监视窗要画的东西：原始画面 + 最近一帧的关键点。 */
export interface FacePreviewFrame {
  /** 离屏 video（调用方只读，不要持有） */
  video: HTMLVideoElement | null
  /** 最近一帧的 468 个关键点（归一化坐标，可能为 null） */
  landmarks: readonly FaceLandmark[] | null
  /** 检测器当前有没有跟上人脸 */
  hasFace: boolean
  /** 是否还在做初始标定 */
  calibrating: boolean
  /** 已跟踪的时长（毫秒），没跟上时是 0 */
  trackingForMs: number
}

/** 带用户可读原因的失败：调用方直接展示 message。 */
export class FaceTrackError extends Error {}

export class FaceTracker {
  private video: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private landmarker: FaceLandmarker | null = null
  private raf = 0
  private stopped = false
  private lastDetectAt = 0
  private lastTimestamp = 0
  private lastSeenAt = 0
  private neutral: FaceMetrics | null = null
  private neutralSum: FaceMetrics | null = null
  private neutralCount = 0
  private gaze = { x: 0.5, y: 0.5 }
  private blend: FaceBlend = { mouth: 0, eyes: 1 }
  private hasBlend = false
  /** 表情细节（嘴形/眉毛），-1~1，平滑后 */
  private extras: FaceExtras = { form: 0, brow: 0 }
  /** 歪头，-1~1，已减掉标定基线 */
  private roll = 0
  /** 标定期的歪头基线：用户本来歪着头坐，模型不该跟着歪 */
  private neutralRoll: number | null = null
  private neutralRollSum = 0
  private neutralRollCount = 0
  /** 最近一帧的关键点，只给监视窗画轮廓用（不参与上行） */
  private lastLandmarks: readonly FaceLandmark[] | null = null
  private trackingSince = 0
  private onStatus?: (status: FaceTrackerStatus) => void

  // erasableSyntaxOnly：不能用参数属性，状态回调显式赋值
  private constructor(onStatus?: (status: FaceTrackerStatus) => void) {
    this.onStatus = onStatus
  }

  static async create(opts?: {
    onStatus?: (status: FaceTrackerStatus) => void
  }): Promise<FaceTracker> {
    const tracker = new FaceTracker(opts?.onStatus)
    await tracker.prepare()
    return tracker
  }

  /** 是否有「刚检测到」的人脸。false 时调用方应交回鼠标。 */
  hasFace(): boolean {
    return this.lastSeenAt > 0 && Date.now() - this.lastSeenAt < FACE_LOST_MS
  }

  /** 当前注视点（0~1）。没人脸时返回 null。 */
  getGaze(): { x: number; y: number } | null {
    return this.hasFace() ? { ...this.gaze } : null
  }

  /**
   * 当前面部表情（嘴型/睁眼）。没人脸、或运行时没给出 blendshape 时返回 null。
   *
   * 返回 null 时调用方**不能**按中性值处理：那会在检测器抖动的一帧里把
   * 模型按成闭嘴全睁，看起来像挨了一下耳光。
   */
  getBlend(): FaceBlend | null {
    if (!this.hasBlend || !this.hasFace()) return null
    return { ...this.blend }
  }

  /**
   * 当前这一帧能驱动的全部量。没人脸时返回 null（调用方交回鼠标）。
   *
   * 与分别取 gaze/blend 的区别：这里把「有脸但这一帧没给 blendshape」和
   * 「根本没脸」分开处理——前者仍然返回姿态（视线可用），嘴/眼/表情沿用
   * 上一帧的平滑值，不会因为一帧缺数据就整脸僵一下。
   */
  getPose(): FacePose | null {
    if (!this.hasFace()) return null
    return {
      gaze: { ...this.gaze },
      mouth: this.blend.mouth,
      eyes: this.blend.eyes,
      form: this.extras.form,
      brow: this.extras.brow,
      roll: this.roll,
    }
  }

  /**
   * 重新标定「正对镜头」的基线。
   *
   * 用途很具体：用户换了坐姿、把笔记本挪了位置、或者干脆歪在椅背上，
   * 原来的基线会让模型一直歪着头看人。重标后约 0.8 秒内回到端正。
   */
  recalibrate(): void {
    this.neutral = null
    this.neutralSum = null
    this.neutralCount = 0
    this.neutralRoll = null
    this.neutralRollSum = 0
    this.neutralRollCount = 0
    // 平滑值一并归零，否则标定期间模型还挂在旧的角度上慢慢爬回来
    this.roll = 0
    this.extras = { form: 0, brow: 0 }
  }

  /** 监视窗用：原始画面 + 最近一帧关键点 + 状态。 */
  getPreview(): FacePreviewFrame {
    return {
      video: this.video,
      landmarks: this.lastLandmarks,
      hasFace: this.hasFace(),
      calibrating: this.neutral === null,
      trackingForMs: this.trackingSince ? Date.now() - this.trackingSince : 0,
    }
  }

  stop(): void {
    this.stopped = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.landmarker?.close()
    this.landmarker = null
    if (this.video) {
      this.video.pause()
      this.video.srcObject = null
      this.video.remove()
      this.video = null
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.lastSeenAt = 0
    this.lastLandmarks = null
    this.trackingSince = 0
  }

  // -------------------------------------------------------------------------

  private async prepare(): Promise<void> {
    // 1) wasm SIMD 探测。我们只分发 SIMD 版运行时（见 prepare-live2d-face.mjs），
    //    老浏览器上与其加载出一堆 magic word 报错，不如直接说清楚。
    if (!supportsWasmSimd()) {
      throw new FaceTrackError(t('浏览器不支持摄像头动捕'))
    }
    // 非安全上下文（局域网 http://192.168.x.x）下 getUserMedia 根本不存在，
    // 报「权限被拒绝」会让人去翻浏览器设置。这里先把话说清楚。
    if (!window.isSecureContext) {
      throw new FaceTrackError(t('摄像头动捕需要在本机或 HTTPS 下使用'))
    }

    // 2) 摄像头。约束放得很松：动捕只需要脸够大，不需要高清。
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320 },
          height: { ideal: 240 },
          facingMode: 'user',
        },
        audio: false,
      })
    } catch (err) {
      throw new FaceTrackError(cameraErrorText(err))
    }

    // 离屏 video：不给用户看预览，也不占页面布局
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = this.stream
    video.style.display = 'none'
    document.body.appendChild(video)
    this.video = video
    try {
      await video.play()
    } catch {
      this.stop()
      throw new FaceTrackError(t('摄像头打开失败'))
    }

    // 3) 检测器。GPU 委托在部分老显卡/虚拟机上建不起来，失败后退回 CPU。
    try {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE)
      const build = (delegate: 'GPU' | 'CPU') =>
        vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          // 嘴型/眨眼要靠 blendshape 分数：关掉它就只能拿到关键点，
          // 而关键点算张嘴幅度非常不稳（嘴唇厚度因人而异）。
          outputFaceBlendshapes: true,
        })
      try {
        this.landmarker = await build('GPU')
      } catch {
        this.landmarker = await build('CPU')
      }
    } catch (err) {
      this.stop()
      console.warn('[live2d] 人脸检测模型加载失败', err)
      throw new FaceTrackError(t('人脸检测模型加载失败'))
    }

    this.onStatus?.('starting')
    this.loop()
  }

  private loop = (): void => {
    if (this.stopped) return
    this.raf = requestAnimationFrame(this.loop)

    const now = performance.now()
    if (now - this.lastDetectAt < DETECT_INTERVAL_MS) return
    const video = this.video
    if (!video || video.readyState < 2 || !this.landmarker) return
    this.lastDetectAt = now

    // detectForVideo 要求时间戳单调递增，同一毫秒内连调两次会直接抛错
    const timestamp = Math.max(Math.round(now), this.lastTimestamp + 1)
    this.lastTimestamp = timestamp

    let result: FaceLandmarkerResult
    try {
      result = this.landmarker.detectForVideo(video, timestamp)
    } catch {
      return
    }
    const marks = result.faceLandmarks?.[0] as FaceLandmark[] | undefined
    const metrics = marks ? faceMetrics(marks) : null
    // 有脸但比例不可信（侧到只剩半张脸）时也不更新关键点：监视窗宁可停在
    // 上一帧，也不要画一个明显错位的骨架。
    if (!metrics || !marks) {
      // 短暂丢失（低头看键盘）不该立刻把模型打回鼠标控制
      if (this.lastSeenAt && Date.now() - this.lastSeenAt >= FACE_LOST_MS) {
        this.onStatus?.('no-face')
      }
      return
    }

    this.lastSeenAt = Date.now()
    if (!this.trackingSince) this.trackingSince = Date.now()
    this.lastLandmarks = marks
    this.trackBlend(result)
    this.trackExtras(result)
    const roll = headRollFromLandmarks(marks)
    if (!this.neutral) {
      this.accumulateNeutral(metrics, roll)
      return
    }
    this.trackRoll(roll)
    const target = gazeFromMetrics(metrics, this.neutral)
    this.gaze = {
      x: this.gaze.x + (target.x - this.gaze.x) * SMOOTH_ALPHA,
      y: this.gaze.y + (target.y - this.gaze.y) * SMOOTH_ALPHA,
    }
    this.onStatus?.('tracking')
  }

  /** blendshape 分类结果 → 平滑后的嘴型/睁眼程度。 */
  private trackBlend(result: FaceLandmarkerResult): void {
    const categories = result.faceBlendshapes?.[0]?.categories
    if (!categories || categories.length === 0) return
    const scores: Record<string, number | undefined> = {}
    for (const item of categories) {
      if (item.categoryName) scores[item.categoryName] = item.score
    }
    const target = faceBlendFromScores(scores)
    if (!target) return
    this.hasBlend = true
    this.blend = {
      mouth:
        this.blend.mouth +
        (target.mouth - this.blend.mouth) * BLEND_SMOOTH_ALPHA,
      eyes:
        this.blend.eyes + (target.eyes - this.blend.eyes) * BLEND_SMOOTH_ALPHA,
    }
  }

  /** 前若干帧取平均作为「正对镜头」的基线。 */
  private accumulateNeutral(metrics: FaceMetrics, roll: number | null): void {
    const sum = this.neutralSum ?? { yaw: 0, vert: 0, scale: 0 }
    sum.yaw += metrics.yaw
    sum.vert += metrics.vert
    sum.scale += metrics.scale
    this.neutralSum = sum
    this.neutralCount += 1
    if (roll !== null) {
      this.neutralRollSum += roll
      this.neutralRollCount += 1
    }
    if (this.neutralCount < NEUTRAL_SAMPLES) return
    this.neutral = {
      yaw: sum.yaw / this.neutralCount,
      vert: sum.vert / this.neutralCount,
      scale: sum.scale / this.neutralCount,
    }
    // 一帧歪头角度都没拿到（运行时缺关键点）就按 0 处理：宁可跟着原始角度走，
    // 也不要拿一个 null 去参与减法。
    this.neutralRoll =
      this.neutralRollCount > 0
        ? this.neutralRollSum / this.neutralRollCount
        : 0
  }

  /** 歪头：减掉标定基线后平滑。 */
  private trackRoll(roll: number | null): void {
    if (roll === null) return
    const base = this.neutralRoll ?? 0
    const target = clampSigned(roll - base)
    this.roll = this.roll + (target - this.roll) * ROLL_SMOOTH_ALPHA
  }

  /** 嘴形/眉毛平滑。与表情用同一个系数：它们都是说话时的快变量。 */
  private trackExtras(result: FaceLandmarkerResult): void {
    const categories = result.faceBlendshapes?.[0]?.categories
    if (!categories || categories.length === 0) return
    const scores: Record<string, number | undefined> = {}
    for (const item of categories) {
      if (item.categoryName) scores[item.categoryName] = item.score
    }
    const target = faceExtrasFromScores(scores)
    if (!target) return
    this.extras = {
      form:
        this.extras.form +
        (target.form - this.extras.form) * BLEND_SMOOTH_ALPHA,
      brow:
        this.extras.brow +
        (target.brow - this.extras.brow) * BLEND_SMOOTH_ALPHA,
    }
  }
}

/** 把 getUserMedia 的 DOMException 翻成用户能照着处理的一句话。 */
function cameraErrorText(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return t('摄像头权限被拒绝')
    case 'NotFoundError':
    case 'OverconstrainedError':
      return t('没有找到可用的摄像头')
    case 'NotReadableError':
      return t('摄像头被其他程序占用')
    default:
      return t('摄像头打开失败')
  }
}

/** 夹到 -1~1；NaN 归零（这一帧的角度算不出来，就当没歪）。 */
function clampSigned(v: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < -1) return -1
  if (v > 1) return 1
  return v
}
