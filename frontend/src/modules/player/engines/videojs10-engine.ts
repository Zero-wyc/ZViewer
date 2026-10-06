/**
 * Video.js 10 引擎(直链模式,执行层全量接管)。
 *
 * 架构(与 direct 引擎共享「链接获取」,移交「执行与控制」给 v10):
 *
 * 1. 链接获取链路(保留自研,用户明确的必要链路):URL 代理决策、
 *    appendAuthToken、挂载直链前置校验、陈旧 https 升级降级备选、
 *    直连失败回退服务器代理、X-Content-Duration 惰性 HEAD 探测——
 *    全部复用 direct-route.ts 共享实现,与 direct 引擎零漂移;
 * 2. 执行层(v10 media 接管):加载(video.src / video.load)、播放
 *    (play / pause)、跳转(currentTime)、缓冲语义(preload 透传,
 *    直链为浏览器原生渐进式 Range 下载)统一经 HTMLVideoAdapter 的
 *    Media capabilities 驱动,引擎内不再直接操作 video 元素(元素级
 *    清场 resetVideoElement 与事件桥接除外);
 * 3. 状态层(v10 store 镜像):videoFeatures 全量特性
 *    (playback/time/volume/source/buffer/text-track/error 等)构建
 *    headless store,实时镜像 paused/currentTime/seeking/duration/
 *    buffered 等状态,控制台 window.__vjs10Store.$state() 可观察,
 *    为「控制条走 v10」「HLS/DASH 换 v10 media」铺路;
 * 4. 引擎级跳转:实现 PlayerController(seekTo 走 media.currentTime),
 *    usePlayerSource.seekTo 对直链生效,不再由控件层各自直写。
 *
 * 控件 UI(ArtPlayer / PlayerControlBar)保持不变——用户明确要求保留;
 * 控件对 art.video 的操作与 v10 media 驱动的是同一 video 元素,
 * store 经 adapter 事件实时同步两侧状态。
 *
 * 回退开关:localStorage['zviewer-vjs10-engine'] === '0' 时 selectEngine
 * 直接回落 direct 引擎(见 engine-selector.ts),无需改代码即可 A/B。
 */
import type {
  PlayerEngine,
  PlayerSource,
  EngineAttachResult,
  PlayerController,
  SeekResult,
} from '../types'
import { resetVideoElement } from '../utils'
import { buildProxyUrl } from '../services/url-proxy'
import {
  probeContentDuration,
  resolveDirectLoadPlan,
  waitForMetadataOrError,
  normalizeMkvTimeoutError,
} from './direct-route'
import { HTMLVideoAdapter } from '@videojs/media/dom'
import { videoFeatures } from '@videojs/core/dom'
import { combine, createStore } from '@videojs/store'

/**
 * v10 引擎级跳转控制器:seek 执行走 v10 media 的 currentTime 能力。
 *
 * 直链为原生渐进式下载,浏览器跨 unbuffered 区自动发 Range 请求,
 * 永不需要上层 forceReload(needReload 恒 false)。
 */
function createV10PlayerController(
  media: HTMLVideoAdapter,
  isDisposed: () => boolean
): PlayerController {
  return {
    // 接口为 DASH blob URL 语义设计;v10 无 blob URL,返回已加载地址
    attach: async () => media.currentSrc || '',
    seekTo: async (targetTime: number): Promise<SeekResult> => {
      if (isDisposed()) {
        return { success: false, message: '引擎已清理' }
      }
      try {
        media.currentTime = targetTime
        return { success: true }
      } catch (err) {
        return {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        }
      }
    },
    // 清理由引擎 cleanup 统一负责(store.destroy + media.detach)
    cleanup: () => {},
    get isAttached() {
      return !isDisposed()
    },
    get isSeeking() {
      return !isDisposed() && !!media.seeking
    },
  }
}

export const videojs10Engine: PlayerEngine = {
  type: 'videojs10',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    // ===== 1. 链接获取链路(保留自研,与 direct 引擎共享) =====
    const plan = resolveDirectLoadPlan(source)

    // ===== 2. v10 media 接管执行层 =====
    // HTMLVideoAdapter 桥接现有元素,此后加载/播放/跳转/缓冲语义
    // 全部经 media capabilities 驱动
    const media = new HTMLVideoAdapter()
    media.attach(video)

    let disposed = false

    // v10 执行:src 设置 + load + metadata 等待(经 media 事件,
    // adapter 将 loadedmetadata / error 转发自桥接的 video 元素)
    const loadWithV10 = async (url: string): Promise<void> => {
      media.src = url
      media.load()
      await waitForMetadataOrError(media)
    }

    try {
      resetVideoElement(video)
      try {
        await loadWithV10(plan.targetUrl)
      } catch (err) {
        // MKV 原生直连超时:命中时短路后续降级 / 回退,直接给出指引
        const mkvErr = normalizeMkvTimeoutError(err, source)
        if (mkvErr) {
          throw mkvErr
        }
        if (plan.httpDowngradeUrl) {
          console.warn(
            '[videojs10-engine] https 直链加载失败(疑为失效的协议升级:源站 TLS 已移除),降级 http 直链重试:',
            err
          )
          resetVideoElement(video)
          await loadWithV10(plan.httpDowngradeUrl)
        } else if (!plan.fallback) {
          if (source.noProxyFallback === true) {
            console.warn(
              '[videojs10-engine] 直链模式:直连失败,不回退服务器代理:',
              err
            )
          }
          throw err
        } else {
          console.warn('[videojs10-engine] 直连失败,回退到服务器代理:', err)
          resetVideoElement(video)
          await loadWithV10(buildProxyUrl(source.url))
        }
      }
    } catch (err) {
      // 加载链失败:释放 media 桥接,错误向上(引擎层回退 / 用户提示)
      disposed = true
      try {
        media.detach()
      } catch {
        /* ignore */
      }
      throw err
    }

    // ===== 3. 惰性时长探测(链接层,保留):转码流 duration=Infinity 兜底 =====
    if (!Number.isFinite(media.duration) || media.duration === Infinity) {
      await probeContentDuration(media.currentSrc || video.src, video)
    }

    // ===== 4. v10 headless store 接管状态层 =====
    // videoFeatures 为官方 video 预设的全量特性切片,combine 后建 store;
    // store 仅镜像 media 状态(数据只向上流),控制指令由 media capabilities 承担
    const store = createStore()(combine(...videoFeatures))
    store.attach({ media, container: null })

    console.info(
      '[videojs10-engine] store attached:',
      'paused =',
      store.state.paused,
      ', duration =',
      store.state.duration
    )
    // 调试入口:控制台可直接观察 v10 状态机(window.__vjs10Store.$state())
    ;(window as unknown as Record<string, unknown>).__vjs10Store = store

    return {
      player: createV10PlayerController(media, () => disposed),
      cleanup: () => {
        disposed = true
        delete video.dataset.serverDuration
        try {
          store.destroy()
        } catch {
          // store 已销毁(重复 cleanup)静默跳过
        }
        try {
          media.detach()
        } catch {
          // 同上
        }
        delete (window as unknown as Record<string, unknown>).__vjs10Store
      },
    }
  },
}
