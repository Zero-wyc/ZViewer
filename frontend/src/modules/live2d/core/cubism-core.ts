import { Ticker } from 'pixi.js'
import { t } from '@/i18n'

// Cubism Core 与渲染引擎的加载入口。
//
// Cubism Core（live2dcubismcore.min.js）是 Live2D 的专有运行时，不在 npm 包里，
// 随仓库放在 public/live2d/core/。它必须以**全局脚本**的形式先于引擎执行
// （引擎在 import 时就会读 window.Live2DCubismCore），所以这里用「注入 script
// 标签 → 再动态 import」的两段式，而不是在 index.html 里写死：
// 后者会让登录页也下载 200KB，而只有房间页需要它。
//
// 全仓只有本文件 import 引擎的包名：换引擎（例如换到 @laplace.live 的 fork）
// 只改这里的 import 与 registerTicker 两行。

export type Live2DEngine = typeof import('untitled-pixi-live2d-engine/cubism')

/** 模型实例类型（渲染器用它做类型标注，避免直接 import 那个包）。 */
export type Live2DModelInstance = InstanceType<Live2DEngine['Live2DModel']>

const CORE_SRC = '/live2d/core/live2dcubismcore.min.js'

let corePromise: Promise<void> | null = null
let enginePromise: Promise<Live2DEngine> | null = null

declare global {
  interface Window {
    Live2DCubismCore?: unknown
  }
}

/** 幂等注入 Core：已存在就直接放行，并发调用共享同一个 Promise。 */
export function ensureCubismCore(): Promise<void> {
  if (typeof window === 'undefined')
    return Promise.reject(new Error('no window'))
  if (window.Live2DCubismCore) return Promise.resolve()
  if (corePromise) return corePromise

  corePromise = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = CORE_SRC
    el.async = false
    el.onload = () => {
      if (window.Live2DCubismCore) resolve()
      else reject(new Error(t('Cubism Core 已加载但未注册')))
    }
    el.onerror = () => reject(new Error(t('Cubism Core 加载失败')))
    document.head.appendChild(el)
  }).catch((err) => {
    // 失败不缓存：网络恢复后可以重试
    corePromise = null
    throw err
  })

  return corePromise
}

/** 唯一的引擎入口：先 Core，再动态 import，只执行一次。 */
export function loadLive2DEngine(): Promise<Live2DEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      await ensureCubismCore()
      const mod = await import('untitled-pixi-live2d-engine/cubism')
      // 多个模型同时开蒙版时默认 16MB 不够用；32MB 是官方示例里
      // 「同屏 4~6 个模型」的安全值。
      mod.configureCubismSDK({ memorySizeMB: 32 })
      // 按需 import 时引擎拿不到全局 PIXI，需要显式注册 Ticker 才会自动更新
      mod.Live2DModel.registerTicker(Ticker)
      return mod
    })().catch((err) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}
