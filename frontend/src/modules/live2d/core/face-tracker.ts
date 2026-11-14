import type {
  FaceLandmarker,
  FaceLandmarkerResult,
} from '@mediapipe/tasks-vision'
import { t } from '@/i18n'
import {
  faceBlendFromScores,
  faceMetrics,
  gazeFromMetrics,
  type FaceBlend,
  type FaceLandmark,
  type FaceMetrics,
} from './face-pose'

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
/** 多久没检测到人脸就放弃接管（交回鼠标）。 */
const FACE_LOST_MS = 1200

export type FaceTrackerStatus = 'starting' | 'tracking' | 'no-face'

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
    if (!metrics) {
      // 短暂丢失（低头看键盘）不该立刻把模型打回鼠标控制
      if (this.lastSeenAt && Date.now() - this.lastSeenAt >= FACE_LOST_MS) {
        this.onStatus?.('no-face')
      }
      return
    }

    this.lastSeenAt = Date.now()
    this.trackBlend(result)
    if (!this.neutral) {
      this.accumulateNeutral(metrics)
      return
    }
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
  private accumulateNeutral(metrics: FaceMetrics): void {
    const sum = this.neutralSum ?? { yaw: 0, vert: 0, scale: 0 }
    sum.yaw += metrics.yaw
    sum.vert += metrics.vert
    sum.scale += metrics.scale
    this.neutralSum = sum
    this.neutralCount += 1
    if (this.neutralCount < NEUTRAL_SAMPLES) return
    this.neutral = {
      yaw: sum.yaw / this.neutralCount,
      vert: sum.vert / this.neutralCount,
      scale: sum.scale / this.neutralCount,
    }
  }
}

/** wasm SIMD 探测：这个字节序列只有支持 SIMD 的引擎才 validate 通过。 */
function supportsWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined' || !WebAssembly.validate) return false
  const probe = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0,
    65, 0, 253, 15, 253, 98, 11,
  ])
  return WebAssembly.validate(probe)
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
