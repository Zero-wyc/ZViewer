/**
 * DASH 引擎适配器（基于 dash.js）。
 *
 * 使用 DashPlayer 实现 PlayerEngine 接口。
 * DashPlayer 内部动态生成 MPD manifest，将 B站分离的 video/audio m4s 包装为
 * dash.js 可识别的 DASH 源，由 dash.js 接管 MSE 生命周期与 seek 逻辑。
 *
 * 准入与失败策略：
 * - 进入本引擎的源必然 format='dash' 且带 audioUrl（engine-selector 的准入
 *   条件是 format==='dash' || audioUrl，而 audioUrl 仅由 B站 DASH 解析产生，
 *   产出时 format 恒为 'dash'——历史上"非 DASH 源 + audioUrl 走
 *   direct + audio-sync 双元素降级"的分支经源追溯确认为死代码，已移除）；
 * - DASH 源缺 audioUrl：m4s 无法直连播放，直接抛错；
 * - dash.js 加载失败：直接抛错（自研 MSE 引擎已移除，无回退目标），
 *   由调用方提示用户。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { DashPlayer } from './dash'

export const dashEngine: PlayerEngine = {
  type: 'dash',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    const audioUrl = source.audioUrl || ''

    // DASH 源的 sourceUrl 是 m4s 片段，不能直接作为 video.src 播放，
    // 双轨合并必须有 audioUrl
    if (!audioUrl) {
      throw new Error('DASH 源缺少 audioUrl，无法播放')
    }

    const dashPlayer = new DashPlayer({
      video,
      videoUrl: source.url,
      audioUrl,
      videoCodec: source.videoCodec,
      audioCodec: source.audioCodec,
      duration: source.duration,
      // 缓冲模式：从 IndexedDB 读取的 Blob 数据，传入后 dash.js 用 blob URL 加载
      videoBlob: source.videoBlob,
      audioBlob: source.audioBlob,
      // P2P 传输：仅在流模式启用，DashPlayer 内部会检查 isBufferMode
      p2pEnabled: source.p2pEnabled,
    })
    try {
      const blobUrl = await dashPlayer.attach(source.startTime)
      return {
        blobUrl,
        player: dashPlayer,
        cleanup: () => {
          dashPlayer.cleanup()
        },
      }
    } catch (err) {
      dashPlayer.cleanup()
      throw new Error('dash.js 加载 DASH 源失败', { cause: err })
    }
  },
}
