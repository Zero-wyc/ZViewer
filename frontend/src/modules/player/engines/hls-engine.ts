/**
 * HLS 引擎：通过 hls.js 将 m3u8 流挂载到 <video> 元素。
 *
 * Safari 原生支持 HLS（直接设置 src），其他浏览器通过 hls.js 附加。
 * 返回的 cleanup 函数用于卸载 hls 实例并清理资源。
 *
 * 从旧 msePlayer.ts 抽取，逻辑无变化。
 */
import Hls from 'hls.js'
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'

export const hlsEngine: PlayerEngine = {
  type: 'hls',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)

    // Safari 原生支持 HLS
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source.url
      video.load()
      await waitForMetadata(video)
      return {
        cleanup: () => {
          try {
            video.pause()
          } catch {
            // ignore
          }
          video.removeAttribute('src')
          video.load()
        },
      }
    }

    if (!Hls.isSupported()) {
      throw new Error('当前浏览器不支持 HLS 播放且 hls.js 不可用')
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
    })
    hls.attachMedia(video)
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(source.url)
    })

    await waitForMetadata(video)

    return {
      cleanup: () => {
        try {
          hls.destroy()
        } catch {
          // ignore
        }
      },
    }
  },
}
