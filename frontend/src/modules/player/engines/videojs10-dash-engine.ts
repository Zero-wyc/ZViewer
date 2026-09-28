/**
 * Video.js 10 DASH 引擎(B站 DASH,分阶段迁移的第一阶段)。
 *
 * 架构(「播放引擎 = Video.js 10,分片获取链路 = 自研」):
 *
 * 1. 分片获取链路(自研,保留):DashPlayer 的完整管线——m4s 头部预读、
 *    sidx/moov 解析(mp4-box-parser)、字节偏移计算、双轨 m4s 虚拟 MPD
 *    生成、IndexedDB Blob 模式、SwarmCloud P2P。这是 B站 播放的核心
 *    自研资产,v10 RC 无此能力(官方 @videojs/dash-video 只是 dash.js
 *    的 Media 合同包装,不带分片决策);
 * 2. 执行层(dash.js 4.7.4,暂保留):dash.js 在自研 MPD 定义的
 *    SegmentList/SegmentBase 规则内执行分片下载与 SourceBuffer 管理;
 * 3. 状态层(v10 接管):HTMLVideoAdapter 桥接 video 元素,
 *    videoFeatures 全量特性构建 headless store,实时镜像
 *    paused/currentTime/seeking/duration/buffered/error 等状态,
 *    控制台 window.__vjs10DashStore.$state() 可观察;
 * 4. 引擎级跳转:透传 DashPlayer 的 PlayerController(seekTo 保留
 *    busy 互斥、seeked 等待与 needReload 诊断等 MSE 增强)。
 *
 * 第二阶段路线(未实施):抽离 MPD 生成为独立模块,以 @videojs/dash-video
 * 的 DashAdapter(dash.js 5.2.0)替换执行层并移除 4.7.4 依赖——需先
 * 验证 5.x 对虚拟 MPD 的兼容性并适配 SwarmCloud P2P(当前依赖 4.x API)。
 *
 * 回退开关:localStorage['zviewer-vjs10-dash-engine'] === '0' 时
 * selectEngine 回落经典 dash 引擎(见 engine-selector.ts)。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { DashPlayer } from './dash'
import { HTMLVideoAdapter } from '@videojs/media/dom'
import { videoFeatures } from '@videojs/core/dom'
import { combine, createStore } from '@videojs/store'

export const videojs10DashEngine: PlayerEngine = {
  type: 'videojs10-dash',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    const audioUrl = source.audioUrl || ''

    // DASH 源的 sourceUrl 是 m4s 片段,不能直接作为 video.src 播放,
    // 双轨合并必须有 audioUrl
    if (!audioUrl) {
      throw new Error('DASH 源缺少 audioUrl，无法播放')
    }

    // ===== 1. 分片获取链路(自研,保留):DashPlayer =====
    const dashPlayer = new DashPlayer({
      video,
      videoUrl: source.url,
      audioUrl,
      videoCodec: source.videoCodec,
      audioCodec: source.audioCodec,
      duration: source.duration,
      // 缓冲模式:从 IndexedDB 读取的 Blob 数据,传入后 dash.js 用 blob URL 加载
      videoBlob: source.videoBlob,
      audioBlob: source.audioBlob,
      // P2P 传输:仅在流模式启用,DashPlayer 内部会检查 isBufferMode
      p2pEnabled: source.p2pEnabled,
    })
    let blobUrl: string
    try {
      blobUrl = await dashPlayer.attach(source.startTime)
    } catch (err) {
      dashPlayer.cleanup()
      throw new Error('dash.js 加载 DASH 源失败', { cause: err })
    }

    // ===== 2. 状态层(v10 接管):headless store 镜像 =====
    // HTMLVideoAdapter 桥接现有元素;DashPlayer 驱动的 MSE 播放状态
    // 经 video 元素事件实时流入 v10 store(数据只向上流)
    const media = new HTMLVideoAdapter()
    media.attach(video)
    const store = createStore()(combine(...videoFeatures))
    store.attach({ media, container: null })

    console.info(
      '[videojs10-dash-engine] store attached:',
      'paused =',
      store.state.paused,
      ', duration =',
      store.state.duration
    )
    // 调试入口:控制台可直接观察 v10 状态机(window.__vjs10DashStore.$state())
    ;(window as unknown as Record<string, unknown>).__vjs10DashStore = store

    return {
      blobUrl,
      // 引擎级 seek:透传 DashPlayer(busy 互斥 / seeked 等待 / needReload 诊断)
      player: dashPlayer,
      cleanup: () => {
        dashPlayer.cleanup()
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
        delete (window as unknown as Record<string, unknown>).__vjs10DashStore
      },
    }
  },
}
