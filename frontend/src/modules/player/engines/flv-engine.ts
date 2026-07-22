/**
 * FLV 引擎：通过 flv.js 将 FLV 流挂载到 <video> 元素。
 *
 * 返回的 cleanup 函数用于卸载 flv 实例并清理资源。
 * 从旧 msePlayer.ts 抽取，逻辑无变化。
 */
import flvjs from 'flv.js'
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'

export const flvEngine: PlayerEngine = {
  type: 'flv',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    if (!flvjs.isSupported()) {
      throw new Error('当前浏览器不支持 FLV 播放且 flv.js 不可用')
    }

    resetVideoElement(video)

    const player = flvjs.createPlayer(
      {
        type: 'flv',
        url: source.url,
        isLive: false,
        cors: true,
      },
      {
        enableWorker: false,
        lazyLoad: false,
      }
    )
    player.attachMediaElement(video)
    player.load()

    await waitForMetadata(video)

    return {
      cleanup: () => {
        try {
          player.pause()
          player.unload()
          player.detachMediaElement()
          player.destroy()
        } catch {
          // ignore
        }
      },
    }
  },
}
