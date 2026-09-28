/**
 * Video.js 10 引擎（试点，直链模式）。
 *
 * 架构：保留现有播放器控件 UI（PlayerControlBar / Artplayer 集成不动），
 * 用 Video.js 10（@videojs/store + @videojs/core/dom + @videojs/media）的
 * headless player store 接管现有 <video> 元素的播放状态层：
 *
 * 1. 加载路径：复用 direct-engine 的完整管线（url-proxy 代理决策、直连失败
 *    回退服务器代理、metadata 等待与超时、X-Content-Duration 惰性探测）——
 *    直链场景下 v10 的解码层同样是原生 video.src，替换它没有收益；
 * 2. 引擎层：加载完成后构建 v10 headless store（videoFeatures 全量特性：
 *    playback/time/volume/source/buffer/text-track/error 等），通过
 *    HTMLVideoAdapter 桥接到同一 video 元素，v10 状态机实时镜像
 *    （store.$state.paused / currentTime / seeking / duration ...），
 *    为后续「控制条走 store actions」「HLS/DASH 换 v10 media 组件」铺路。
 *
 * 回退开关：localStorage['zviewer-vjs10-engine'] === '0' 时 selectEngine
 * 直接回落 direct 引擎（见 engine-selector.ts），无需改代码即可 A/B。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { directEngine } from './direct-engine'
import { HTMLVideoAdapter } from '@videojs/media/dom'
import { videoFeatures } from '@videojs/core/dom'
import { combine, createStore } from '@videojs/store'

export const videojs10Engine: PlayerEngine = {
  type: 'videojs10',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    // ===== 1. 加载：沿用 direct 管线（代理决策 + 回退 + metadata 等待） =====
    const directResult = await directEngine.attach(video, source)

    // ===== 2. Video.js 10 headless store 接管播放状态层 =====
    // HTMLVideoAdapter 桥接现有元素（v10 的 Video media 能力面）；
    // videoFeatures 为官方 video 预设的全量特性切片，combine 后建 store
    const media = new HTMLVideoAdapter()
    media.attach(video)
    const store = createStore()(combine(...videoFeatures))
    store.attach({ media, container: null })

    console.info(
      '[videojs10-engine] store attached:',
      'paused =',
      store.state.paused,
      ', duration =',
      store.state.duration
    )
    // 调试入口：控制台可直接观察 v10 状态机（window.__vjs10Store.$state()）
    ;(window as unknown as Record<string, unknown>).__vjs10Store = store

    return {
      ...directResult,
      cleanup: () => {
        directResult.cleanup?.()
        try {
          store.destroy()
        } catch {
          // store 已销毁（重复 cleanup）静默跳过
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
