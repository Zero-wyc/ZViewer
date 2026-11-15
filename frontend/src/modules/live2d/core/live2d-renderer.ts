import { Application, Container, extensions } from 'pixi.js'
import type { Live2DEngine, Live2DModelInstance } from './cubism-core'
import {
  LIVE2D_FACE_TTL_MS,
  LIVE2D_IDLE_MS,
  LIVE2D_LOAD_TIMEOUT_MS,
  LIVE2D_MAX_RENDERED,
  LIVE2D_MODEL_HEIGHT_RATIO,
} from '../constants'
import { alphaForDelta, smooth } from './pointer-map'
import {
  clampAnchorToView,
  clampDragOffset,
  clampDragToView,
  type DragOffset,
} from './drag'
import { getEntry, listEntries, slotX, type SceneEntry } from './scene'
import { pickVisiblePeers } from './visibility'
import { t as translate } from '@/i18n'

// PIXI 渲染封装。React 完全不参与这里：宿主组件只负责创建/销毁，
// 每帧的平滑与 focus 都在 ticker 里做。
//
// 一个 Application 承载所有模型（单 WebGL 上下文）：浏览器对同时存在的
// 上下文有上限（通常 8~16 个），每个模型一个 Application 很快会把上下文
// 用光，而且每个上下文都有固定显存开销。

/** Cubism 参数 id 句柄。引擎不给类型（内部是 CubismId），只当作不透明值传递。 */
interface CubismParamIds {
  mouth: unknown
  eyeL: unknown
  eyeR: unknown
  /** 嘴形（笑/撇嘴），中位 0 */
  mouthForm: unknown
  browL: unknown
  browR: unknown
  /** 歪头（度） */
  angleZ: unknown
}

/** 引擎内部对象的最小可用面（只声明我们真的会碰的几个成员）。 */
interface InternalModelLike {
  coreModel: {
    setParameterValueById(id: unknown, value: number, weight?: number): void
  }
  getIdSafe(id: string): unknown
  motionManager?: {
    state?: {
      currentGroup?: string
      currentIndex?: number
      shouldRequestIdleMotion?: () => boolean
    }
  }
}

interface LoadedModel {
  model: Live2DModelInstance
  /** 加载用的模型地址，用来判断「换模型才需要重载」 */
  url: string
  /** 首次布局是否已经做过（避免每帧算一次 baseScale） */
  baseScale: number
  /** 嘴/眼参数句柄；模型里没有这些参数时各项为 undefined，写入无副作用 */
  params: CubismParamIds | null
  /**
   * 上一帧看到的动作（`group#index`），用来发现「切换了」。
   * 空串表示当前没有动作在播（动作之间的空档）。
   */
  motionKey: string
  /**
   * 被我们覆盖掉的原生 shouldRequestIdleMotion（可还原）。
   * 只有「按当前 localSid 判定为旁观者」的模型才有值。
   */
  originalIdleRequest?: () => boolean
  /**
   * 未缩放时的包围盒尺寸（加载时取一次）。
   *
   * 不用每帧 getBounds()：那是遍历所有 drawable 求并集，6 个模型 × 60fps
   * 是白扔的 CPU；贴图在呼吸/动作里只会上下浮动几个百分点，边界留这个精度
   * 足够，反正约束只是「别整只跑出画面」。
   */
  localW: number
  localH: number
  /** 最近一次渲染用的「无偏移锚点」与像素尺寸，拖拽层的边界约束要用 */
  baseX: number
  baseY: number
  boxW: number
  boxH: number
  /** 实际画出来的锚点（已含可见性约束），DOM 标签跟随它 */
  px: number
  py: number
}

export interface RendererOptions {
  engine: Live2DEngine
  mount: HTMLElement
  /** 模型加载失败时通知宿主（宿主渲染占位卡） */
  onModelError?: (sid: string, reason: string) => void
  /**
   * 本机 socket id。只有本人的模型保留「自动挑 idle 动作」的行为，
   * 并在切换时通过 onLocalMotion 广播；别人的模型一律等人喂动作。
   */
  localSid?: string
  /** 本人模型切换了动作（动捕/待机）：宿主负责广播给房间。 */
  onLocalMotion?: (group: string, index: number) => void
}

export class Live2DRenderer {
  private engine: Live2DEngine
  private app: Application
  private root: Container
  private models = new Map<string, LoadedModel>()
  private loading = new Set<string>()
  private failed = new Map<string, number>()
  private queue: Array<{ sid: string; url: string }> = []
  private inFlight = 0
  private destroyed = false
  private width = 1
  private height = 1
  private localSid = ''
  private onModelError?: (sid: string, reason: string) => void
  private onLocalMotion?: (group: string, index: number) => void

  // erasableSyntaxOnly 下不能用参数属性，只能显式赋值
  private constructor(engine: Live2DEngine, app: Application) {
    this.engine = engine
    this.app = app
    this.root = new Container()
    this.app.stage.addChild(this.root)
    this.app.ticker.add(() => this.update())
  }

  static async create(opts: RendererOptions): Promise<Live2DRenderer> {
    const app = new Application()
    await app.init({
      backgroundAlpha: 0,
      antialias: false,
      preference: 'webgl',
      autoDensity: true,
      // 画布按「总像素预算」超采样，而不是跟着 devicePixelRatio 走。
      //
      // Live2D 本质是「把一张贴图用网格变形后画出来」：模型被放大到 42% 视口高
      // 之后，边缘质量完全取决于采样密度。dpr=1 的显示器上按 1x 渲染，4096 的
      // 贴图会被压成一层柔光——用户看到的就是「精度太低」。给到约 400 万像素
      // （1440×900 → 1.8x，1080p → 1.4x）在几乎不涨显存的前提下把这类损失补回来；
      // 上限 2x 兜住大视口，免得 4K 窗口把填充率吃穿。
      resolution: resolutionForViewport(),
      autoStart: true,
      // 不传 resizeTo：画布尺寸由宿主显式给（全屏时会换父节点，
      // 自动跟随窗口会在一瞬间算出 0 尺寸）。
    })
    opts.mount.appendChild(app.canvas)
    // 渲染管道全局只需注册一次；重复 add 是幂等的。
    extensions.add(opts.engine.Live2DPlugin)

    const renderer = new Live2DRenderer(opts.engine, app)
    renderer.onModelError = opts.onModelError
    renderer.onLocalMotion = opts.onLocalMotion
    renderer.localSid = opts.localSid ?? ''
    return renderer
  }

  /** socket 重连后 id 会变，本机模型的判定要跟着换。 */
  setLocalSid(sid: string): void {
    if (this.localSid === sid) return
    this.localSid = sid
    // 判定变了就得重新分配「谁自己挑动作」：否则重连后自己的模型被当成别人的，
    // 既不广播动作、也不再自己动，整个房间会僵住。
    for (const [modelSid, loaded] of this.models) {
      this.applyMotionPolicy(modelSid, loaded)
    }
  }

  resize(width: number, height: number): void {
    if (this.destroyed) return
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (w === this.width && h === this.height) return
    // 模型尺寸是「视口高的固定比例」，视口一变就必须重算。只在首次算过一次
    // 的话，从全屏退回小窗后模型仍按大窗的尺寸绘制：相对变大、贴图被拉糊，
    // 而且会比视口还高——用户这时往上拖就会看到「只剩一个头」。
    for (const loaded of this.models.values()) loaded.baseScale = 0
    this.width = w
    this.height = h
    this.app.renderer.resize(w, h)
  }

  /** 画布尺寸（= 视口尺寸，固定铺满整屏）。拖拽层用它换算比例。 */
  viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }

  /**
   * 模型**实际**画出来的拖拽偏移（已含可见性约束）。
   *
   * 名字标签是 DOM、位置由槽位 + 偏移算，必须跟这个值而不是场景里的原始
   * 偏移：模型贴边被夹住时，原始值还在涨，标签会自己飘出画面。
   */
  dragOf(sid: string): DragOffset | null {
    const loaded = this.models.get(sid)
    if (!loaded || !(loaded.boxW > 0) || !(loaded.boxH > 0)) return null
    return {
      x: (loaded.px - loaded.baseX) / this.width,
      y: (loaded.py - loaded.baseY) / this.height,
    }
  }

  /**
   * 把一次拖拽偏移压回「模型仍在画面里」的范围。
   *
   * 给拖拽层用（它才知道模型的真实像素尺寸）：只做比例 clamp 的话，偏移
   * 会一路涨到 -0.55，而画面早在模型贴边时就停住了，手感会断层。
   */
  clampOffset(sid: string, x: number, y: number): DragOffset {
    const first = clampDragOffset(x, y)
    const loaded = this.models.get(sid)
    if (!loaded || !(loaded.boxW > 0) || !(loaded.boxH > 0)) return first
    return clampDragToView({
      offset: first,
      baseX: loaded.baseX,
      baseY: loaded.baseY,
      width: loaded.boxW,
      height: loaded.boxH,
      viewW: this.width,
      viewH: this.height,
    })
  }

  /** 声明一个模型；同一 sid 换模型会替换，同一个模型不重复加载。 */
  sync(sid: string, url: string): void {
    if (this.destroyed) return
    const loaded = this.models.get(sid)
    if (loaded) {
      if (loaded.url === url) return
      this.remove(sid)
    }
    if (this.loading.has(sid)) return
    // 失败过的地址短时间内不再重试，避免 8 个人同时拉一个挂掉的 URL
    const failedAt = this.failed.get(`${sid}|${url}`)
    if (failedAt && Date.now() - failedAt < 60_000) return
    if (this.queue.some((item) => item.sid === sid && item.url === url)) return
    this.queue.push({ sid, url })
    this.pump()
  }

  remove(sid: string): void {
    this.queue = this.queue.filter((item) => item.sid !== sid)
    const loaded = this.models.get(sid)
    if (!loaded) return
    this.models.delete(sid)
    this.root.removeChild(loaded.model)
    loaded.model.destroy({ children: true, texture: true, baseTexture: true })
  }

  /**
   * 播放某个成员模型的表情。
   *
   * 用下标而不是表情名：同一份 model3.json 在各端解析出的顺序相同，
   * 而表情名在导出时经常是空串或重名（官方素材也这样），不可靠。
   * 模型还没加载完就丢弃——表情是瞬时动作，补播反而更怪。
   */
  playExpression(sid: string, index: number): void {
    if (this.destroyed) return
    const loaded = this.models.get(sid)
    if (!loaded || !Number.isInteger(index) || index < 0) return
    void loaded.model.expression(index).catch(() => {
      // 模型没这个下标的表情 / 正被动作覆盖：静默忽略，不值得报错
    })
  }

  /**
   * 播放某个成员模型的动作（motion）。
   *
   * 为什么用 FORCE 优先级：引擎在 `priority <= currentPriority` 时**拒绝**启动
   * （见 MotionState.start），而所有同步动作都是同一优先级；用 NORMAL 的话
   * 第二次同步就会被丢掉，画面从此停在上一个动作上。这里的选择是权威的
   * ——「本人决定，其他人跟随」，所以强制切换是对的。
   *
   * 组名/下标不可用（模型没有这个动作）时 `motion()` 会 resolve 成 false，
   * 静默失败即可：不值得为一个可选动作报错。
   */
  playMotion(sid: string, group: string, index: number): void {
    if (this.destroyed) return
    const loaded = this.models.get(sid)
    if (!loaded || !group) return
    if (!Number.isInteger(index) || index < 0) return
    // 本人的模型是动作的**源头**，收到的是自己那条回声：本地已经在播了，
    // 再 start 一次会让动作从头跳一下（而且回声还可能晚于下一次切换到达）。
    if (sid === this.localSid) return
    // 已经在播同一个动作就别重来：服务端不做去重，重复 start 会让它跳到第一帧。
    // 这里不能按「上一条收到的动作」去重——同一个动作播完之后再播一次是正常的
    // （只有一个 idle 动作的模型就是这样循环的）。
    const state = (loaded.model.internalModel as unknown as InternalModelLike)
      .motionManager?.state
    if (state?.currentGroup === group && state.currentIndex === index) return
    void loaded.model.motion(group, index, MOTION_PRIORITY_FORCE).catch(() => {
      // 同上：模型没有这个动作组/下标，忽略
    })
  }

  /**
   * 光标下是哪个角色（右键菜单用）。返回 null 表示点在空白处。
   *
   * 用渲染器自己的包围盒而不是在 canvas 上挂监听：canvas 是
   * `pointer-events: none` 的（否则房间的拖拽、双击全屏、视频控件全被吃掉），
   * 所以命中判定只能由知道每个模型摆在哪的一方来做。
   *
   * 包围盒来自 drawable（可见图形）而不是 canvas，但它含透明边距，所以判定
   * 比贴图本身略宽松——右键这种低频操作宁可好点一些。
   */
  pick(clientX: number, clientY: number): string | null {
    if (this.destroyed) return null
    // 与 update() 用同一个裁剪口径（pickVisiblePeers）：两边不一致时会出现
    // 「标签在这、模型在那」或者「看到模型却右键不到」
    const visible = pickVisiblePeers(
      listEntries(),
      this.localSid,
      LIVE2D_MAX_RENDERED,
      (e) => e.peer.sid
    )
    // 反向：后画的在上层，点到重叠区应该命中眼睛看到的那一个
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      const sid = visible[i].peer.sid
      const box = this.boundsOf(sid)
      if (!box) continue
      if (
        clientX >= box.x &&
        clientX <= box.x + box.width &&
        clientY >= box.y &&
        clientY <= box.y + box.height
      ) {
        return sid
      }
    }
    return null
  }

  /**
   * 某个模型当前的包围盒（canvas 坐标 = 视口坐标，画布铺满视口）。
   *
   * 拖拽模式用它画虚线框，也用它判断"我点到的到底是不是自己"：`pick`
   * 只返回最上层那一个，两个人重叠时按它判断会把自己的拖拽拦下来。
   */
  boundsOf(sid: string): {
    x: number
    y: number
    width: number
    height: number
  } | null {
    if (this.destroyed) return null
    const loaded = this.models.get(sid)
    if (!loaded || !loaded.model.visible) return null
    const box = loaded.model.getBounds()
    if (!(box.width > 0) || !(box.height > 0)) return null
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  }

  /** 同步移除场景里已经不存在的模型。 */
  prune(alive: Set<string>): void {
    for (const sid of [...this.models.keys()]) {
      if (!alive.has(sid)) this.remove(sid)
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.queue = []
    for (const sid of [...this.models.keys()]) this.remove(sid)
    this.app.destroy(true, { children: true, texture: true })
  }

  // -------------------------------------------------------------------------

  private pump(): void {
    const MAX_IN_FLIGHT = 2
    while (
      !this.destroyed &&
      this.inFlight < MAX_IN_FLIGHT &&
      this.queue.length > 0
    ) {
      const next = this.queue.shift()
      if (!next) break
      if (this.models.has(next.sid)) continue
      this.inFlight += 1
      void this.load(next.sid, next.url).finally(() => {
        this.inFlight -= 1
        this.pump()
      })
    }
  }

  private async load(sid: string, url: string): Promise<void> {
    this.loading.add(sid)
    try {
      const pending = this.engine.Live2DModel.from(url, {
        // 关掉引擎自带的交互系统：它会在 canvas 上挂全局指针监听，
        // 把房间的拖拽/双击全屏全吃掉。注视由我们自己 focus()。
        autoInteract: false,
        // 'single-auto' 会在「屏显尺度 < 0.5」时把 4096 贴图压成 1/2、1/4 的
        // 降采样图集再画——模型看着像被磨过一层（这正是"精度太低"的主因：
        // 有的模型画布尺寸小，算出来的世界缩放就小于阈值，整只被降级）。
        // 'full' 只生成 mipmap 链，用来做缩小采样的抗锯齿，不降纹理尺寸。
        textureOptions: { lod: 'full' },
      })
      let model: Live2DModelInstance
      try {
        model = await withTimeout(pending, LIVE2D_LOAD_TIMEOUT_MS)
      } catch (err) {
        // 超时只是「我们不等了」，底层加载还在跑。等它落地就销毁，否则贴图与
        // WebGL 纹理全漏在显存里——4K 素材一次能漏掉几百 MB。
        void pending
          .then((late) =>
            late.destroy({ children: true, texture: true, baseTexture: true })
          )
          .catch(() => {})
        throw err
      }
      if (this.destroyed) {
        model.destroy({ children: true, texture: true, baseTexture: true })
        return
      }
      model.anchor.set(0.5, 1)
      this.root.addChild(model)
      // 本地包围盒（未缩放）：宽高要在约束里用，取一次就够
      const lb = model.getLocalBounds()
      const entry: LoadedModel = {
        model,
        url,
        baseScale: 0,
        params: null,
        motionKey: '',
        localW: lb.width > 0 ? lb.width : model.width,
        localH: lb.height > 0 ? lb.height : model.height,
        baseX: 0,
        baseY: 0,
        boxW: 0,
        boxH: 0,
        px: 0,
        py: 0,
      }
      this.applyMotionPolicy(sid, entry)
      this.bindFaceParams(sid, entry)
      this.models.set(sid, entry)
    } catch (err) {
      this.failed.set(`${sid}|${url}`, Date.now())
      const reason = err instanceof Error ? err.message : String(err)
      console.warn('[live2d] 模型加载失败', url, reason)
      this.onModelError?.(sid, reason)
    } finally {
      this.loading.delete(sid)
    }
  }

  /** 每帧：排位 → 平滑 → focus → 动作状态。 */
  private update(): void {
    if (this.destroyed) return
    const entries = listEntries()
    // 自己一定在内：人一多按 ord 裁到前 6 个时，第 7 位的人会完全看不到自己
    const visible = pickVisiblePeers(
      entries,
      this.localSid,
      LIVE2D_MAX_RENDERED,
      (e) => e.peer.sid
    )
    const now = Date.now()
    const delta = this.app.ticker.deltaMS
    const alpha = alphaForDelta(0.25, delta)
    // 表情比视线跟手：说话是 100ms 级的变化，用视线的平滑系数会糊成慢动作
    const faceAlpha = alphaForDelta(0.5, delta)
    // 拖拽位置只在别人拖的时候需要平滑（本人拖的时候目标与当前一起写）
    const dragAlpha = alphaForDelta(0.35, delta)
    // 歪头比表情更慢：头部有物理惯性，跟得太紧会像抽搐
    const rollAlpha = alphaForDelta(0.22, delta)

    for (let i = 0; i < visible.length; i += 1) {
      const entry = visible[i]
      const loaded = this.models.get(entry.peer.sid)
      if (!loaded) continue
      const { model } = loaded

      // 槽位：按 ord 排好的顺序等距站开（各端一致），再加上本人的拖拽偏移
      entry.currentDragX = smooth(
        entry.currentDragX,
        entry.targetDragX,
        dragAlpha
      )
      entry.currentDragY = smooth(
        entry.currentDragY,
        entry.targetDragY,
        dragAlpha
      )
      const baseX = slotX(i, visible.length) * this.width
      const baseY = this.height

      // 本地尺寸的兜底：模型刚 add 进来时 getLocalBounds() 可能还是空的
      // （引擎还没算过 drawable 包围盒），拿 0 去算 scale 会把模型画成
      // 原始尺寸——一整个屏幕都装不下。
      if (!(loaded.localW > 0) || !(loaded.localH > 0)) {
        const lb = model.getLocalBounds()
        const w0 = lb.width > 0 ? lb.width : model.width
        const h0 = lb.height > 0 ? lb.height : model.height
        if (w0 > 0) loaded.localW = w0
        if (h0 > 0) loaded.localH = h0
      }

      if (loaded.baseScale <= 0) {
        const targetH = this.height * LIVE2D_MODEL_HEIGHT_RATIO
        // 用**本地**高度算，不能用 model.height：后者已含当前 scale，
        // 窗口变化后重算时会把上一帧的缩放再乘一遍，模型瞬间缩成一个小点。
        loaded.baseScale = loaded.localH > 0 ? targetH / loaded.localH : 1
      }
      const scale = loaded.baseScale * entry.peer.scale
      model.scale.set(scale)

      // 像素尺寸与锚点位置都要按当前缩放算：约束是「包围盒至少留多少在画面里」，
      // 拿旧尺寸算会在缩放/窗口变化后失效。
      const boxW = loaded.localW > 0 ? loaded.localW * scale : model.width
      const boxH = loaded.localH > 0 ? loaded.localH * scale : model.height
      loaded.baseX = baseX
      loaded.baseY = baseY
      loaded.boxW = boxW
      loaded.boxH = boxH

      const anchor = clampAnchorToView(
        baseX + entry.currentDragX * this.width,
        baseY + entry.currentDragY * this.height,
        boxW,
        boxH,
        this.width,
        this.height
      )
      model.x = anchor.x
      model.y = anchor.y
      loaded.px = anchor.x
      loaded.py = anchor.y

      this.advance(entry, alpha, now)
      entry.currentMouth = smooth(
        entry.currentMouth,
        entry.targetMouth,
        faceAlpha
      )
      entry.currentEyes = smooth(entry.currentEyes, entry.targetEyes, faceAlpha)
      // 语音嘴型单独平滑：它不跟动捕那组一起被接管，但要和嘴一样连续，
      // 否则 15Hz 的响度读数会变成一开一合的"打点"。
      entry.currentVoiceMouth = smooth(
        entry.currentVoiceMouth,
        entry.targetVoiceMouth,
        faceAlpha
      )
      entry.currentForm = smooth(entry.currentForm, entry.targetForm, faceAlpha)
      entry.currentBrow = smooth(entry.currentBrow, entry.targetBrow, faceAlpha)
      // 歪头是慢动作（颈椎有惯性），用更慢的系数才自然
      entry.currentRoll = smooth(entry.currentRoll, entry.targetRoll, rollAlpha)
      // focus 用的是画布坐标：canvas 铺满视口，所以归一化 × 画布尺寸即可
      model.focus(entry.currentX * this.width, entry.currentY * this.height)

      // 本人的模型是「动作的源头」：换了动作就广播出去
      if (entry.peer.sid === this.localSid) this.pollLocalMotion(loaded)
    }

    // 超出渲染上限的模型先隐藏（保留已加载状态，人数降下来立刻回来）
    const visibleIds = new Set(visible.map((e) => e.peer.sid))
    for (const [sid, loaded] of this.models) {
      loaded.model.visible = visibleIds.has(sid)
    }
  }

  /**
   * 把嘴型/睁眼/表情细节接到 Cubism 参数上。
   *
   * 时机是关键：`beforeModelUpdate` 在动作、眨眼、呼吸都写完之后、`coreModel.update()`
   * 之前触发，所以在这里写入才是「最终值」，不会被引擎覆盖掉。
   *
   * 只在数据新鲜时接管（见 LIVE2D_FACE_TTL_MS）：对方关掉动捕、或者干脆断流了，
   * 就把这些参数还给引擎自己的眨眼与表情，不会永远停在最后一帧的怪表情上。
   *
   * 参数**存在才写**：眉毛、嘴形不是每个模型都有（很多免费模型只绑了
   * ParamMouthOpenY），给不存在的 id 写值在 Cubism 核里会抛错并中断整帧。
   */
  private bindFaceParams(sid: string, loaded: LoadedModel): void {
    const im = loaded.model.internalModel as unknown as InternalModelLike
    if (!im || typeof im.getIdSafe !== 'function') return
    const core = im.coreModel
    if (!core || typeof core.setParameterValueById !== 'function') return

    const ids: CubismParamIds = {
      mouth: im.getIdSafe('ParamMouthOpenY'),
      eyeL: im.getIdSafe('ParamEyeLOpen'),
      eyeR: im.getIdSafe('ParamEyeROpen'),
      mouthForm: im.getIdSafe('ParamMouthForm'),
      browL: im.getIdSafe('ParamBrowLY'),
      browR: im.getIdSafe('ParamBrowRY'),
      angleZ: im.getIdSafe('ParamAngleZ'),
    }
    loaded.params = ids
    const setIf = (id: unknown, value: number) => {
      if (id === undefined || id === null) return
      core.setParameterValueById(id, value)
    }
    loaded.model.internalModel.on('beforeModelUpdate', () => {
      const entry = getEntry(sid)
      if (!entry) return
      // 两条通路共用嘴这个参数，但**不能互相顶替**：
      //   - 动捕新鲜 → 整脸接管（嘴/眼/表情/歪头全写）；
      //   - 只有语音新鲜 → 只写嘴，其余留给引擎自己的眨眼与小动作。
      // 以前只按 faceAt 判定，语音如果借用面部通路，模型在整段说话里都不眨眼。
      const faceFresh = isFaceFresh(entry)
      const voiceFresh = isVoiceFresh(entry)
      if (!faceFresh && !voiceFresh) return
      setIf(ids.mouth, faceFresh ? entry.currentMouth : entry.currentVoiceMouth)
      if (!faceFresh) return
      setIf(ids.eyeL, entry.currentEyes)
      setIf(ids.eyeR, entry.currentEyes)
      // 协议里是 0~1 编码，Cubism 的嘴形/眉毛是 -1~1，中位 0
      setIf(ids.mouthForm, (entry.currentForm - 0.5) * 2)
      const brow = (entry.currentBrow - 0.5) * 2
      setIf(ids.browL, brow)
      setIf(ids.browR, brow)
      // 歪头：0~1 编码 → ±30°。几何上 roll 正值是「画面里顺时针（被拍者向左歪）」，
      // 而 ParamAngleZ 正值让模型向左倒——同向，直接线性映射。
      setIf(ids.angleZ, (entry.currentRoll - 0.5) * 2 * 30)
    })
  }

  /**
   * 分配「谁自己挑 idle 动作」。
   *
   * 本人的模型保留引擎的行为（自然的待机），换动作时广播给房间；
   * 别人的模型一律关掉自动挑动作，等 live2d-action 下发——否则每个人各挑各的，
   * 同一幕里两个人做的是不同动作。
   *
   * 引擎这条逻辑是每帧检查、且没有开关（`shouldRequestIdleMotion` 是公开方法），
   * 所以直接覆盖它；覆盖是**可还原**的，重连换 sid 时要还回去。
   * 为什么不用「把 idleMotionGroup 指到一个不存在的组」：那样每帧都会走一次
   * startRandomMotion 的异步路径，白白创建 Promise。
   */
  private applyMotionPolicy(sid: string, loaded: LoadedModel): void {
    const state = (loaded.model.internalModel as unknown as InternalModelLike)
      .motionManager?.state
    if (!state) return
    if (sid === this.localSid) {
      if (loaded.originalIdleRequest) {
        state.shouldRequestIdleMotion = loaded.originalIdleRequest
        loaded.originalIdleRequest = undefined
      }
      return
    }
    if (loaded.originalIdleRequest) return
    const original = state.shouldRequestIdleMotion
    loaded.originalIdleRequest = original ? original.bind(state) : () => true
    state.shouldRequestIdleMotion = () => false
  }

  /** 发现本人的动作变了就上报（只在真的切换时触发，空档不算）。 */
  private pollLocalMotion(loaded: LoadedModel): void {
    const state = (loaded.model.internalModel as unknown as InternalModelLike)
      .motionManager?.state
    const group = state?.currentGroup
    if (!group) {
      // 动作之间的空档：清掉 key，下一次从头的同一个动作也要重新广播
      loaded.motionKey = ''
      return
    }
    const index = Number(state?.currentIndex ?? 0)
    const key = `${group}#${index}`
    if (key === loaded.motionKey) return
    loaded.motionKey = key
    this.onLocalMotion?.(group, index)
  }

  /** 空闲时做一点轻摆，避免「没人动鼠标时像一张贴图」。 */
  private advance(entry: SceneEntry, alpha: number, now: number): void {
    let targetX = entry.targetX
    let targetY = entry.targetY
    if (now - entry.lastActiveAt > LIVE2D_IDLE_MS) {
      const t = now / 1000
      targetX = 0.5 + Math.sin(t * 0.6) * 0.12
      targetY = 0.5 + Math.cos(t * 0.45) * 0.06
    }
    entry.currentX = smooth(entry.currentX, targetX, alpha)
    entry.currentY = smooth(entry.currentY, targetY, alpha)
  }
}

/** 引擎的动作优先级：3 = FORCE（能打断同优先级的动作，见 playMotion 的说明）。 */
const MOTION_PRIORITY_FORCE = 3

/**
 * 渲染倍率：按总像素预算算，落在 1x~2x。
 *
 * 不直接用 devicePixelRatio：那是「物理像素 / CSS 像素」，与「这个模型需要
 * 多少采样点才不糊」是两件事——dpr=1 的显示器上它恒等于 1，正是"精度太低"
 * 的来源。这里反过来按面积预算推：小窗口自动多采，大窗口自动收敛。
 */
function resolutionForViewport(): number {
  const pixels = Math.max(
    1,
    (window.innerWidth || 1280) * (window.innerHeight || 720)
  )
  const budget = 4_200_000
  const ratio = Math.sqrt(budget / pixels)
  return Math.min(2, Math.max(1, ratio))
}

/** 面部数据是否还新鲜（超过 TTL 就认为对方不再动捕）。 */
function isFaceFresh(entry: SceneEntry): boolean {
  return entry.faceAt > 0 && Date.now() - entry.faceAt < LIVE2D_FACE_TTL_MS
}

/** 语音嘴型的有效期与动捕同一把尺：都是 15Hz 上报 + 短 TTL 释放。 */
function isVoiceFresh(entry: SceneEntry): boolean {
  return entry.voiceAt > 0 && Date.now() - entry.voiceAt < LIVE2D_FACE_TTL_MS
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(translate('加载超时'))), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}
