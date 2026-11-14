import { Application, Container, extensions } from 'pixi.js'
import type { Live2DEngine, Live2DModelInstance } from './cubism-core'
import {
  LIVE2D_IDLE_MS,
  LIVE2D_LOAD_TIMEOUT_MS,
  LIVE2D_MAX_RENDERED,
  LIVE2D_MODEL_HEIGHT_RATIO,
} from '../constants'
import { alphaForDelta, smooth } from './pointer-map'
import { listEntries, slotX, type SceneEntry } from './scene'
import { t as translate } from '@/i18n'

// PIXI 渲染封装。React 完全不参与这里：宿主组件只负责创建/销毁，
// 每帧的平滑与 focus 都在 ticker 里做。
//
// 一个 Application 承载所有模型（单 WebGL 上下文）：浏览器对同时存在的
// 上下文有上限（通常 8~16 个），每个模型一个 Application 很快会把上下文
// 用光，而且每个上下文都有固定显存开销。

interface LoadedModel {
  model: Live2DModelInstance
  /** 加载用的模型地址，用来判断「换模型才需要重载」 */
  url: string
  /** 首次布局是否已经做过（避免每帧算一次 baseScale） */
  baseScale: number
}

export interface RendererOptions {
  engine: Live2DEngine
  mount: HTMLElement
  /** 模型加载失败时通知宿主（宿主渲染占位卡） */
  onModelError?: (sid: string, reason: string) => void
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
  private onModelError?: (sid: string, reason: string) => void

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
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoStart: true,
      // 不传 resizeTo：画布尺寸由宿主显式给（全屏时会换父节点，
      // 自动跟随窗口会在一瞬间算出 0 尺寸）。
    })
    opts.mount.appendChild(app.canvas)
    // 渲染管道全局只需注册一次；重复 add 是幂等的。
    extensions.add(opts.engine.Live2DPlugin)

    const renderer = new Live2DRenderer(opts.engine, app)
    renderer.onModelError = opts.onModelError
    return renderer
  }

  resize(width: number, height: number): void {
    if (this.destroyed) return
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    this.width = w
    this.height = h
    this.app.renderer.resize(w, h)
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
      const model = await withTimeout(
        this.engine.Live2DModel.from(url, {
          // 关掉引擎自带的交互系统：它会在 canvas 上挂全局指针监听，
          // 把房间的拖拽/双击全屏全吃掉。注视由我们自己 focus()。
          autoInteract: false,
          textureOptions: { lod: 'single-auto' },
        }),
        LIVE2D_LOAD_TIMEOUT_MS
      )
      if (this.destroyed) {
        model.destroy({ children: true, texture: true, baseTexture: true })
        return
      }
      model.anchor.set(0.5, 1)
      this.root.addChild(model)
      this.models.set(sid, { model, url, baseScale: 0 })
    } catch (err) {
      this.failed.set(`${sid}|${url}`, Date.now())
      const reason = err instanceof Error ? err.message : String(err)
      console.warn('[live2d] 模型加载失败', url, reason)
      this.onModelError?.(sid, reason)
    } finally {
      this.loading.delete(sid)
    }
  }

  /** 每帧：排位 → 平滑 → focus。 */
  private update(): void {
    if (this.destroyed) return
    const entries = listEntries()
    const visible = entries.slice(0, LIVE2D_MAX_RENDERED)
    const now = Date.now()
    const delta = this.app.ticker.deltaMS
    const alpha = alphaForDelta(0.25, delta)

    for (let i = 0; i < visible.length; i += 1) {
      const entry = visible[i]
      const loaded = this.models.get(entry.peer.sid)
      if (!loaded) continue
      const { model } = loaded

      // 槽位：按 ord 排好的顺序等距站开（各端一致）
      const x = slotX(i, visible.length) * this.width
      const y = this.height
      model.x = x
      model.y = y

      if (loaded.baseScale <= 0) {
        const targetH = this.height * LIVE2D_MODEL_HEIGHT_RATIO
        loaded.baseScale = model.height > 0 ? targetH / model.height : 1
      }
      model.scale.set(loaded.baseScale * entry.peer.scale)

      this.advance(entry, alpha, now)
      // focus 用的是画布坐标：canvas 铺满视口，所以归一化 × 画布尺寸即可
      model.focus(entry.currentX * this.width, entry.currentY * this.height)
    }

    // 超出渲染上限的模型先隐藏（保留已加载状态，人数降下来立刻回来）
    const visibleIds = new Set(visible.map((e) => e.peer.sid))
    for (const [sid, loaded] of this.models) {
      loaded.model.visible = visibleIds.has(sid)
    }
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
