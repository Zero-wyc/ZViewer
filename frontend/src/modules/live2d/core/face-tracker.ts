import type {
  FaceLandmarker,
  FaceLandmarkerResult,
} from '@mediapipe/tasks-vision'
import { t } from '@/i18n'
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
  type FaceBlend,
  type FaceExtras,
  type FaceLandmark,
  type FaceMetrics,
  type HeadPoseNeutral,
  type RawHeadPose,
} from './face-pose'
import { supportsWasmSimd } from './wasm-simd'

// 摄像头动捕：本地人脸检测 → 归一化注视点 + 面部表情 + 头部 6DOF，交给上行链路。
//
// 几条硬约束：
//   - **画面不出本机**：getUserMedia 的流只喂给离屏 <video>，检测在本机跑，
//     不发网络、不落盘。上行链路只发算出来的 0~1 坐标与角度。
//   - **按需加载**：MediaPipe 的 JS 与 11MB wasm 只有在用户点开开关时才拉，
//     而且用动态 import 单独切块，不进房间页的主链路。
//   - **失败要能说清**：权限拒绝 / 没有摄像头 / 被占用是三种完全不同的处理，
//     统一报「打开失败」用户只会反复点开关。

const WASM_BASE = '/live2d/face/wasm'
const MODEL_URL = '/live2d/face/face_landmarker.task'

// ---------------------------------------------------------------------------
// 精度档位
// ---------------------------------------------------------------------------

export type Live2DFaceQuality = 'smooth' | 'standard' | 'precise'

/**
 * 一档精度对应的全部参数。
 *
 * 为什么是"档位"而不是把四个数字都做成滑杆：这四个量互相牵制——帧率提上去
 * 但分辨率不提，关键点精度不会变好，只会更抖；分辨率提上去但帧率不降，低端
 * 机器直接掉到 5fps，看起来比低精度还差。预设把互相匹配的组合钉死，用户只选
 * 一次"要流畅还是要准"。
 */
interface QualityPreset {
  /** 两次检测之间的最小间隔 */
  intervalMs: number
  /** 请求的摄像头分辨率（ideal，设备不支持会自动降到最近的档） */
  width: number
  height: number
  /** 注视点平滑系数 */
  gazeAlpha: number
  /** 表情/嘴眼的平滑系数 */
  blendAlpha: number
  /** 头部旋转的平滑系数（颈椎有惯性，比表情慢） */
  headAlpha: number
}

/**
 * 三档。
 *
 * 分辨率的收益是**平方**级的：脸在 320×240 里只有 ~90px 宽，关键点误差 2~3px
 * 就是 3% 的眼距；640×480 下同样的绝对误差只剩 1.5%。这就是"提升精度"最
 * 实在的一刀，比任何滤波都有效。代价是每帧多几毫秒的上传/采样。
 */
export const FACE_QUALITY_PRESET: Record<Live2DFaceQuality, QualityPreset> = {
  // 低端机 / 只想"能动能眨眼"：10fps，最小分辨率，平滑最重
  smooth: {
    intervalMs: 100,
    width: 320,
    height: 240,
    gazeAlpha: 0.28,
    blendAlpha: 0.5,
    headAlpha: 0.3,
  },
  // 默认：15fps，480×360，和改造前的开销基本持平
  standard: {
    intervalMs: 66,
    width: 480,
    height: 360,
    gazeAlpha: 0.35,
    blendAlpha: 0.55,
    headAlpha: 0.4,
  },
  // 高精度：30fps，640×480。GPU 委托下 20~40ms/帧，30fps 基本吃满一个核
  precise: {
    intervalMs: 33,
    width: 640,
    height: 480,
    gazeAlpha: 0.45,
    blendAlpha: 0.62,
    headAlpha: 0.5,
  },
}

/** 动捕的运行时配置。改任意一项都不需要重开摄像头（见 setConfig）。 */
export interface FaceTrackerConfig {
  quality: Live2DFaceQuality
  /**
   * 3D 头部：用位姿矩阵解 3 轴旋转，并把平移做成视差（6DOF）。
   *
   * 关掉时退回"眼线算滚转 + 鼻尖算偏航"的 2D 估计，也就是改造前的行为。
   * 需要重建检测器（矩阵是构建选项，不是每帧参数）。
   */
  head3d: boolean
  /** 眼球跟随：虹膜相对眼窝的位置。不需要重建检测器，只是不写对应参数。 */
  eyeTrack: boolean
}

export const FACE_TRACKER_DEFAULTS: FaceTrackerConfig = {
  quality: 'standard',
  head3d: true,
  eyeTrack: true,
}

/** 标定采样数：约 0.8 秒（按 15fps 算），让用户刚打开时不用刻意静止太久。 */
const NEUTRAL_SAMPLES = 12
/** 多久没检测到人脸就放弃接管（交回鼠标）。 */
const FACE_LOST_MS = 1200
/** detectForVideo 连续抛错多少次（≈0.5s）就触发降级重建。 */
const DETECT_FAIL_LIMIT = 8
/** 曾经见过脸之后持续丢脸多久，才认定是 GPU graph 半死并降级（区别于低头看键盘）。 */
const NO_FACE_DEGRADE_MS = 8000
/** 两次重建之间的最小间隔，防止反复重建来回抖动。 */
const REBUILD_COOLDOWN_MS = 30000

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
  /** 睁眼程度 0~1（左右平均，老协议口径） */
  eyes: number
  /** 左/右眼各自的睁眼程度（wink 用） */
  eyeLeft: number
  eyeRight: number
  /** 嘴形 -1（撇嘴）~ 1（笑） */
  form: number
  /** 眉毛 -1（皱眉）~ 1（挑眉） */
  brow: number
  /** 头部滚转 -1（向左倒）~ 1（向右倒） */
  roll: number
  /** 3D 头部偏航/俯仰，-1~1；关掉 3D 时恒为 0 */
  head: { x: number; y: number }
  /** 6DOF 平移视差，-1~1；关掉 3D 时恒为 0 */
  offset: { x: number; y: number }
  /** 前后位移 -1~1（正 = 靠近镜头）；关掉 3D 时恒为 0 */
  depth: number
  /** 眼球指向 -1~1（y 已翻成"向上为正"）；关掉眼球跟随或没有虹膜时为 0 */
  eye: { x: number; y: number }
  /**
   * head/offset/depth 这三个量这一帧是否**有效**。
   *
   * 为什么不能只看数值：关掉 3D 时它们是 0（编码后 0.5），和"正对镜头"完全
   * 同形。接收端若照写，就会把引擎按注视点带动的头部钉死在正前方——这正是
   * 老客户端"头不会动"的来源。所以可用性必须显式传，而不是猜。
   */
  headActive: boolean
  /** eye 这一帧是否有效（同上：关掉眼球跟随或运行时没给虹膜）。 */
  eyeActive: boolean
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
}

/** 带用户可读原因的失败：调用方直接展示 message。 */
export class FaceTrackError extends Error {}

export class FaceTracker {
  private video: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private landmarker: FaceLandmarker | null = null
  private raf = 0
  private stopped = false
  private config: FaceTrackerConfig
  private preset: QualityPreset
  private lastDetectAt = 0
  private lastTimestamp = 0
  private lastSeenAt = 0
  private neutral: FaceMetrics | null = null
  private neutralSum: FaceMetrics | null = null
  private neutralCount = 0
  private gaze = { x: 0.5, y: 0.5 }
  private blend: FaceBlend = { mouth: 0, eyes: 1, eyeLeft: 1, eyeRight: 1 }
  /** 表情细节（嘴形/眉毛），-1~1，平滑后 */
  private extras: FaceExtras = { form: 0, brow: 0 }
  /** 滚转，-1~1，已减掉标定基线（3D 可用时来自位姿矩阵，否则来自眼线） */
  private roll = 0
  /** 标定期的滚转基线：用户本来歪着头坐，模型不该跟着歪 */
  private neutralRoll: number | null = null
  private neutralRollSum = 0
  private neutralRollCount = 0

  // ---- 3D 头部（6DOF）----
  private head: { x: number; y: number } = { x: 0, y: 0 }
  private offset: { x: number; y: number } = { x: 0, y: 0 }
  private depth = 0
  private neutralHead: HeadPoseNeutral | null = null
  private neutralHeadSum: HeadPoseNeutral | null = null
  private neutralHeadCount = 0
  /**
   * 坐标系符号（±1）。
   *
   * 不同运行时对"向左转头"给出的正负号并不统一，而符号错了的表现是
   * "我向左看、模型向右看"——用户只会说"动捕坏了"。这里在标定期用几何量
   * （鼻尖偏移 / 眼线角度）与矩阵量做相关，自动定出符号。
   */
  private signs = { yaw: 1, pitch: 1, roll: 1 }
  private signSamples: {
    yaw: Array<[number, number]>
    pitch: Array<[number, number]>
    roll: Array<[number, number]>
  } = { yaw: [], pitch: [], roll: [] }

  // ---- 眼球跟随 ----
  private eye: { x: number; y: number } = { x: 0, y: 0 }
  private neutralEye: { x: number; y: number } | null = null
  private neutralEyeSum = { x: 0, y: 0, count: 0 }

  /** 最近一帧的关键点，只给监视窗画轮廓用（不参与上行） */
  private lastLandmarks: readonly FaceLandmark[] | null = null
  private onStatus?: (status: FaceTrackerStatus) => void
  /** 当前 landmarker 用的委托。GPU 创建成功 ≠ 运行时能用，降级时要记住从哪退。 */
  private delegate: 'GPU' | 'CPU' = 'GPU'
  /** detectForVideo 连续抛错的次数（成功一帧即清零） */
  private detectFailures = 0
  /** GPU 模式下是否已经降级过 CPU（只降一次，避免反复重建抖动） */
  private gpuRetried = false
  /** 是否正在重建 landmarker（防并发） */
  private rebuilding = false
  /** 上次重建完成的时间戳（Date.now 口径，用于冷却） */
  private lastRebuildAt = 0

  // erasableSyntaxOnly：不能用参数属性，状态回调显式赋值
  private constructor(
    config: FaceTrackerConfig,
    onStatus?: (status: FaceTrackerStatus) => void
  ) {
    this.config = config
    this.preset = FACE_QUALITY_PRESET[config.quality]
    this.onStatus = onStatus
  }

  static async create(opts?: {
    onStatus?: (status: FaceTrackerStatus) => void
    config?: Partial<FaceTrackerConfig>
  }): Promise<FaceTracker> {
    const config = { ...FACE_TRACKER_DEFAULTS, ...opts?.config }
    const tracker = new FaceTracker(config, opts?.onStatus)
    await tracker.prepare()
    return tracker
  }

  /** 是否有「刚检测到」的人脸。false 时调用方应交回鼠标。 */
  hasFace(): boolean {
    return this.lastSeenAt > 0 && Date.now() - this.lastSeenAt < FACE_LOST_MS
  }

  /**
   * 当前这一帧能驱动的全部量。没人脸时返回 null（调用方交回鼠标）。
   *
   * 注意「有脸但这一帧没给 blendshape」和「根本没脸」是两件事：前者仍然返回
   * 姿态（视线可用），嘴/眼/表情沿用上一帧的平滑值，不会因为一帧缺数据就
   * 整脸僵一下；后者返回 null，让调用方停发上行、把控制权交回鼠标。
   */
  getPose(): FacePose | null {
    if (!this.hasFace()) return null
    return {
      gaze: { ...this.gaze },
      mouth: this.blend.mouth,
      eyes: this.blend.eyes,
      eyeLeft: this.blend.eyeLeft,
      eyeRight: this.blend.eyeRight,
      form: this.extras.form,
      brow: this.extras.brow,
      roll: this.roll,
      head: { ...this.head },
      offset: { ...this.offset },
      depth: this.depth,
      eye: { ...this.eye },
      headActive: this.config.head3d && this.neutralHead !== null,
      eyeActive: this.config.eyeTrack && this.neutralEye !== null,
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
    this.resetHeadCalibration()
    this.neutralEye = null
    this.neutralEyeSum = { x: 0, y: 0, count: 0 }
    // 平滑值一并归零，否则标定期间模型还挂在旧的角度上慢慢爬回来
    this.roll = 0
    this.extras = { form: 0, brow: 0 }
    this.eye = { x: 0, y: 0 }
  }

  /** 监视窗用：原始画面 + 最近一帧关键点 + 状态。 */
  getPreview(): FacePreviewFrame {
    return {
      video: this.video,
      landmarks: this.lastLandmarks,
      hasFace: this.hasFace(),
      calibrating: this.neutral === null,
    }
  }

  /** 当前生效的配置（面板据此回显，避免 UI 与实例各记一份）。 */
  getConfig(): FaceTrackerConfig {
    return { ...this.config }
  }

  /**
   * 改运行时配置。
   *
   * 三件事的代价不一样，所以分开处理：
   *   - 质量档位：调摄像头约束（applyConstraints）+ 重建检测器（帧率只是循环里的
   *     一个数字，但分辨率要真的换流）；
   *   - 3D 头部：矩阵是**构建选项**，必须重建检测器；同时清掉头部标定（新通路
   *     的基线不能沿用旧值）；
   *   - 眼球跟随：纯客户端取舍，不碰检测器，清零即可。
   *
   * 任何一步失败都不抛给 UI：动捕已经开着，配置没换上比"整个关掉"体验好，
   * 面板上仍然显示原来的档位（因为 getConfig 没变）。
   */
  async setConfig(next: Partial<FaceTrackerConfig>): Promise<void> {
    if (this.stopped) return
    const prev = this.config
    const merged: FaceTrackerConfig = { ...prev, ...next }
    if (
      merged.quality === prev.quality &&
      merged.head3d === prev.head3d &&
      merged.eyeTrack === prev.eyeTrack
    ) {
      return
    }
    this.config = merged
    this.preset = FACE_QUALITY_PRESET[merged.quality]

    if (merged.head3d !== prev.head3d) {
      this.resetHeadCalibration()
      if (!merged.head3d) {
        // 关掉 3D 时把滚转基线也清掉：接下来的几何角度要重新标定，
        // 否则会拿矩阵时代的基线去减几何量，歪头角度整段偏掉。
        this.neutralRoll = null
        this.neutralRollSum = 0
        this.neutralRollCount = 0
      }
    }
    if (!merged.eyeTrack) this.eye = { x: 0, y: 0 }

    if (merged.quality !== prev.quality) await this.applyCapture()
    // 帧率/矩阵开关都只有重建检测器才生效；矩阵没变时重建也不是白干——
    // intervalMs 在循环里读的是 this.preset，不需要重建。
    if (merged.head3d !== prev.head3d) await this.recreateLandmarker()
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

    // 2) 摄像头。分辨率跟着精度档位走：脸占的像素越多，关键点越准。
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.preset.width },
          height: { ideal: this.preset.height },
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
      try {
        this.landmarker = await this.buildLandmarker(vision, fileset, 'GPU')
        this.delegate = 'GPU'
      } catch {
        this.landmarker = await this.buildLandmarker(vision, fileset, 'CPU')
        this.delegate = 'CPU'
      }
    } catch (err) {
      this.stop()
      console.warn('[live2d] 人脸检测模型加载失败', err)
      throw new FaceTrackError(t('人脸检测模型加载失败'))
    }

    this.onStatus?.('starting')
    this.loop()
  }

  /** 构建指定委托的 FaceLandmarker（prepare 与降级重建共用同一份参数）。 */
  private buildLandmarker(
    vision: typeof import('@mediapipe/tasks-vision'),
    fileset: Awaited<ReturnType<typeof vision.FilesetResolver.forVisionTasks>>,
    delegate: 'GPU' | 'CPU'
  ) {
    return vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      // 嘴型/眨眼要靠 blendshape 分数：关掉它就只能拿到关键点，
      // 而关键点算张嘴幅度非常不稳（嘴唇厚度因人而异）。
      outputFaceBlendshapes: true,
      // 3D 头部的唯一来源。关掉时矩阵字段是空数组，循环里自然会退回几何估计。
      outputFacialTransformationMatrixes: this.config.head3d,
    })
  }

  /** 按当前配置重建检测器（保留现有摄像头流与标定基线）。 */
  private async recreateLandmarker(): Promise<void> {
    if (this.stopped) return
    try {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE)
      let next: FaceLandmarker
      let delegate = this.delegate
      try {
        next = await this.buildLandmarker(vision, fileset, delegate)
      } catch {
        delegate = 'CPU'
        next = await this.buildLandmarker(vision, fileset, delegate)
      }
      if (this.stopped) {
        next.close()
        return
      }
      this.landmarker?.close()
      this.landmarker = next
      this.delegate = delegate
      this.detectFailures = 0
    } catch (err) {
      console.warn('[live2d] 动捕配置切换失败（沿用原检测器）', err)
    }
  }

  /** 把新的分辨率档应用到摄像头轨道（不重新申请权限）。 */
  private async applyCapture(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({
        width: { ideal: this.preset.width },
        height: { ideal: this.preset.height },
      })
    } catch (err) {
      // 设备不支持这个组合就继续用原来的流：精度档位退化成"只改帧率"
      console.warn('[live2d] 摄像头分辨率切换失败', err)
    }
  }

  /**
   * 检测失效后的自愈：关掉半死的 landmarker，换个委托重建。
   *
   * 策略：GPU 失效（抛错或恒为空结果）→ 降级 CPU，只降一次；CPU 也失效
   * 就重建 CPU（重建本身能恢复多数 context 类故障）。30s 冷却防止
   * 反复重建在坏设备上抖成雪崩。视频流和离屏 video 原样保留，重建完
   * 不需要重新标定——标定基线（neutral）与人脸检测器无关。
   */
  private async rebuildLandmarker(): Promise<void> {
    if (this.rebuilding || this.stopped) return
    if (Date.now() - this.lastRebuildAt < REBUILD_COOLDOWN_MS) {
      this.detectFailures = 0
      return
    }
    this.rebuilding = true
    // 重建一律退到 CPU：CPU 委托没有 WebGL context 依赖，是最稳的兜底。
    const from = this.delegate
    const to: 'GPU' | 'CPU' = 'CPU'
    if (from === 'GPU') this.gpuRetried = true
    console.warn(`[live2d] 人脸检测失效，重建检测器（${from} → ${to}）`)
    try {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE)
      const next = await this.buildLandmarker(vision, fileset, to)
      this.landmarker?.close()
      this.landmarker = next
      this.delegate = to
      this.detectFailures = 0
      this.lastRebuildAt = Date.now()
      console.warn(`[live2d] 人脸检测器已重建（${to} 委托）`)
    } catch (err) {
      console.warn('[live2d] 人脸检测器重建失败', err)
    } finally {
      this.rebuilding = false
    }
  }

  private loop = (): void => {
    if (this.stopped) return
    this.raf = requestAnimationFrame(this.loop)

    const now = performance.now()
    if (now - this.lastDetectAt < this.preset.intervalMs) return
    const video = this.video
    if (!video || video.readyState < 2 || !this.landmarker) return
    this.lastDetectAt = now

    // detectForVideo 要求时间戳单调递增，同一毫秒内连调两次会直接抛错
    const timestamp = Math.max(Math.round(now), this.lastTimestamp + 1)
    this.lastTimestamp = timestamp

    let result: FaceLandmarkerResult
    try {
      result = this.landmarker.detectForVideo(video, timestamp)
    } catch (err) {
      // GPU 委托的经典故障形态：创建成功、能跑几秒，随后 WebGL context 失效，
      // detectForVideo 开始每帧抛错。不计数不降级的话，用户就卡死在
      // 「画面正常但永远未检测到人脸」。连续失败到阈值就重建（GPU → CPU）。
      this.detectFailures += 1
      if (this.detectFailures === 1) {
        console.warn('[live2d] 人脸检测开始抛错', err)
      }
      if (this.detectFailures >= DETECT_FAIL_LIMIT) {
        void this.rebuildLandmarker()
      }
      return
    }
    // 一帧成功就清零失败计数
    this.detectFailures = 0
    const marks = result.faceLandmarks?.[0] as FaceLandmark[] | undefined
    const metrics = marks ? faceMetrics(marks) : null
    // 有脸但比例不可信（侧到只剩半张脸）时也不更新关键点：监视窗宁可停在
    // 上一帧，也不要画一个明显错位的骨架。
    if (!metrics || !marks) {
      // 短暂丢失（低头看键盘）不该立刻把模型打回鼠标控制
      if (this.lastSeenAt && Date.now() - this.lastSeenAt >= FACE_LOST_MS) {
        this.onStatus?.('no-face')
      }
      // 另一种 GPU 失效形态：不抛错，但结果恒为空（graph 半死）。
      // 曾经见过脸、丢脸超过阈值，且还没降级过 → 重建到 CPU 试一次。
      if (
        this.delegate === 'GPU' &&
        !this.gpuRetried &&
        this.lastSeenAt &&
        Date.now() - this.lastSeenAt >= NO_FACE_DEGRADE_MS
      ) {
        void this.rebuildLandmarker()
      }
      return
    }

    this.lastSeenAt = Date.now()
    this.lastLandmarks = marks
    this.trackBlend(result)
    this.trackExtras(result)
    const roll = headRollFromLandmarks(marks)
    const eyeDir = eyeGazeFromLandmarks(marks)
    const rawHead = this.config.head3d
      ? headPoseFromMatrix(result.facialTransformationMatrixes?.[0]?.data)
      : null
    if (!this.neutral) {
      this.accumulateNeutral(metrics, roll, rawHead, eyeDir)
      return
    }
    this.trackHead(rawHead, roll, metrics)
    this.trackEye(eyeDir)
    const target = gazeFromMetrics(metrics, this.neutral)
    this.gaze = {
      x: this.gaze.x + (target.x - this.gaze.x) * this.preset.gazeAlpha,
      y: this.gaze.y + (target.y - this.gaze.y) * this.preset.gazeAlpha,
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
    const a = this.preset.blendAlpha
    this.blend = {
      mouth: this.blend.mouth + (target.mouth - this.blend.mouth) * a,
      eyes: this.blend.eyes + (target.eyes - this.blend.eyes) * a,
      eyeLeft: this.blend.eyeLeft + (target.eyeLeft - this.blend.eyeLeft) * a,
      eyeRight:
        this.blend.eyeRight + (target.eyeRight - this.blend.eyeRight) * a,
    }
  }

  /** 前若干帧取平均作为「正对镜头」的基线。 */
  private accumulateNeutral(
    metrics: FaceMetrics,
    roll: number | null,
    rawHead: RawHeadPose | null,
    eyeDir: { x: number; y: number } | null
  ): void {
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
    if (rawHead) this.accumulateHead(rawHead, roll, metrics)
    if (eyeDir) {
      this.neutralEyeSum.x += eyeDir.x
      this.neutralEyeSum.y += eyeDir.y
      this.neutralEyeSum.count += 1
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
    if (this.neutralEyeSum.count > 0) {
      this.neutralEye = {
        x: this.neutralEyeSum.x / this.neutralEyeSum.count,
        y: this.neutralEyeSum.y / this.neutralEyeSum.count,
      }
    }
  }

  /**
   * 头部基线的独立标定。
   *
   * 与视线基线分开攒：3D 头部可以在会话中途打开（面板上的开关），那时整体
   * 标定早就完成了，不能为了重算头部基线把视线也打回"未标定"——画面会僵住
   * 半秒。所以这里只攒 head 的样本，攒够就落地。
   */
  private accumulateHead(
    rawHead: RawHeadPose,
    roll: number | null,
    metrics: FaceMetrics
  ): void {
    const acc = this.neutralHeadSum ?? {
      yaw: 0,
      pitch: 0,
      roll: 0,
      txRatio: 0,
      tyRatio: 0,
      tz: 0,
    }
    const txRatio = rawHead.tx / rawHead.tz
    const tyRatio = rawHead.ty / rawHead.tz
    acc.yaw += rawHead.yaw
    acc.pitch += rawHead.pitch
    acc.roll += rawHead.roll
    acc.txRatio += txRatio
    acc.tyRatio += tyRatio
    acc.tz += rawHead.tz
    this.neutralHeadSum = acc
    this.neutralHeadCount += 1

    // 符号样本：几何量与矩阵量测的是同一件事，同向则乘积为正
    if (this.signSamples.yaw.length < NEUTRAL_SAMPLES) {
      this.signSamples.yaw.push([metrics.yaw, rawHead.yaw])
      // 图像 y 向下：低头时 vert 变大、pitch 变小，所以取反再比
      this.signSamples.pitch.push([-metrics.vert, rawHead.pitch])
      if (roll !== null) this.signSamples.roll.push([roll, rawHead.roll])
    }

    if (this.neutralHeadCount < NEUTRAL_SAMPLES) return
    const n = this.neutralHeadCount
    this.neutralHead = {
      yaw: acc.yaw / n,
      pitch: acc.pitch / n,
      roll: acc.roll / n,
      txRatio: acc.txRatio / n,
      tyRatio: acc.tyRatio / n,
      tz: acc.tz / n,
    }
    this.signs = {
      yaw: alignSign(this.signSamples.yaw),
      pitch: alignSign(this.signSamples.pitch),
      roll: alignSign(this.signSamples.roll),
    }
  }

  /**
   * 头部：3D 可用时走矩阵（含 6DOF 平移），否则退回几何估计。
   *
   * 两条通路写的是同一组输出（head/offset/depth/roll），调用方不必知道
   * 这一帧是哪来的——切精度档位时画面不会跳变。
   */
  private trackHead(
    rawHead: RawHeadPose | null,
    geometricRoll: number | null,
    metrics: FaceMetrics
  ): void {
    const a = this.preset.headAlpha
    const baseRoll = this.neutralRoll ?? 0

    // 3D 刚打开（或整体标定期间没拿到矩阵）时，头部基线还是空的：
    // 先攒够样本再说，这段时间不动头，而不是用一个凭空的正对角度去减。
    if (rawHead && !this.neutralHead) {
      this.accumulateHead(rawHead, geometricRoll, metrics)
      return
    }

    if (this.neutralHead && rawHead) {
      const sample = headPoseFromRaw(rawHead, this.neutralHead, this.signs)
      if (sample) {
        this.head = {
          x: this.head.x + (sample.yaw - this.head.x) * a,
          y: this.head.y + (sample.pitch - this.head.y) * a,
        }
        this.offset = {
          x: this.offset.x + (sample.offX - this.offset.x) * a,
          y: this.offset.y + (sample.offY - this.offset.y) * a,
        }
        this.depth = this.depth + (sample.depth - this.depth) * a
        this.roll = this.roll + (sample.roll - this.roll) * a
        return
      }
    }

    // 2D 回退：偏航/俯仰用鼻尖偏移（和改造前一样），平移与深度没有来源
    if (geometricRoll !== null) {
      const target = clampSigned(geometricRoll - baseRoll)
      this.roll = this.roll + (target - this.roll) * a
    }
    const yaw = clampSigned((metrics.yaw - (this.neutral?.yaw ?? 0)) * 1.2)
    const pitch = clampSigned(-(metrics.vert - (this.neutral?.vert ?? 0)) * 1.6)
    this.head = {
      x: this.head.x + (yaw - this.head.x) * a,
      y: this.head.y + (pitch - this.head.y) * a,
    }
    this.offset = {
      x: this.offset.x + (0 - this.offset.x) * a,
      y: this.offset.y + (0 - this.offset.y) * a,
    }
    this.depth = this.depth + (0 - this.depth) * a
  }

  /** 眼球指向：减掉标定基线后平滑。y 翻符号（图像向下 → Cubism 向上为正）。 */
  private trackEye(eyeDir: { x: number; y: number } | null): void {
    if (!this.config.eyeTrack) return
    if (!eyeDir) return
    const base = this.neutralEye ?? { x: 0, y: 0 }
    const target = {
      x: clampSigned(eyeDir.x - base.x),
      y: clampSigned(-(eyeDir.y - base.y)),
    }
    // 眼球是最快的动作（扫视 30~80ms），用表情的平滑系数，比头部快一档
    const a = Math.min(0.7, this.preset.blendAlpha)
    this.eye = {
      x: this.eye.x + (target.x - this.eye.x) * a,
      y: this.eye.y + (target.y - this.eye.y) * a,
    }
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
    const a = this.preset.blendAlpha
    this.extras = {
      form: this.extras.form + (target.form - this.extras.form) * a,
      brow: this.extras.brow + (target.brow - this.extras.brow) * a,
    }
  }

  private resetHeadCalibration(): void {
    this.neutralHead = null
    this.neutralHeadSum = null
    this.neutralHeadCount = 0
    this.signs = { yaw: 1, pitch: 1, roll: 1 }
    this.signSamples = { yaw: [], pitch: [], roll: [] }
    this.head = { x: 0, y: 0 }
    this.offset = { x: 0, y: 0 }
    this.depth = 0
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
