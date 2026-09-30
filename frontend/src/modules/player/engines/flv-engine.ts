/**
 * FLV 引擎：通过 flv.js 将 FLV 流挂载到 <video> 元素。
 *
 * 两种模式：
 * - **VOD**（默认）：isLive=false，attach 在 metadata 就绪后 resolve。
 * - **直播**（source.isLive）：isLive=true + 延迟追赶 + SourceBuffer
 *   自动清理；flv.js ERROR 由引擎内部按指数退避重连（最多 5 次），
 *   重连过程与最终失败经 source.flvRuntimeEvents 上报给 UI 层——
 *   屏幕共享 FlvPlayer（ArtPlayer 壳）与本引擎共用同一条拉流路径，
 *   不再各自持有一份 flv.js 实例管理。
 *
 * cleanup 完整卸载 flv 实例（pause → unload → detach → destroy）。
 */
import flvjs from 'flv.js'
import type {
  PlayerEngine,
  PlayerSource,
  EngineAttachResult,
  FlvRuntimeEvents,
} from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'
import { resolveProxyUrl } from '../services/url-proxy'

/** 直播模式指数退避重连：最多 5 次，间隔 1/2/4/8/16s */
const LIVE_MAX_RETRY = 5
const LIVE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]

/** 直播模式 flv.js 配置（原 screen-sharing FlvPlayer 的行为对等迁移）。 */
function buildLiveConfig(): Record<string, unknown> {
  return {
    enableWorker: false,
    enableStashBuffer: true,
    stashInitialSize: 256,
    // 自动清理已播放的 SourceBuffer，防止内存膨胀
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 8,
    autoCleanupMinBackwardDuration: 4,
    // 直播延迟追赶：缓冲超过阈值时自动追帧（flv.js 运行时支持，类型定义缺失）
    liveBufferLatencyChasing: true,
    liveBufferLatencyMaxLatency: 1.5,
    liveBufferLatencyTargetLatency: 0.5,
  }
}

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

    // 统一代理策略：由 url-proxy.ts 根据 URL 特征与源格式决定
    const targetUrl = resolveProxyUrl(source.url, source.headers, source.format)

    const player = flvjs.createPlayer(
      {
        type: 'flv',
        url: targetUrl,
        isLive: source.isLive === true,
        cors: true,
      },
      source.isLive
        ? buildLiveConfig()
        : { enableWorker: false, lazyLoad: false }
    )

    let destroyed = false
    // 直播模式的事件监听/重连定时器清理（attachLiveHandlers 返回）
    let disposeLive: (() => void) | null = null
    if (source.isLive) {
      disposeLive = attachLiveHandlers(
        video,
        player,
        source.flvRuntimeEvents ?? {}
      )
    }

    const destroy = () => {
      if (destroyed) return
      destroyed = true
      disposeLive?.()
      try {
        player.pause()
        player.unload()
        player.detachMediaElement()
        player.destroy()
      } catch {
        /* ignore */
      }
    }

    player.attachMediaElement(video)
    player.load()

    try {
      await waitForMetadata(video)
    } catch (err) {
      destroy()
      throw err
    }

    return { cleanup: destroy }
  },
}

/**
 * 直播模式事件接线：flv.js 实例事件 → FlvRuntimeEvents 出口 + 内部重连。
 *
 * - ERROR：指数退避 unload+load+play 重连，耗尽后 onExhausted；
 * - MEDIA_INFO / loadedmetadata：重连成功计数复位 + onReady；
 * - STATISTICS_INFO：原始网络层统计转发（fps 由消费方计算）；
 * - LOADING_COMPLETE：直播流触发即推流端停止。
 *
 * @returns 清理函数：移除 video 元素监听与重连定时器（destroy 时调用）。
 */
function attachLiveHandlers(
  video: HTMLVideoElement,
  player: flvjs.Player,
  events: FlvRuntimeEvents
): () => void {
  let retryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const clearRetryTimer = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  player.on(flvjs.Events.ERROR, (errorType: string, errorDetail: string) => {
    if (disposed) return
    if (retryCount < LIVE_MAX_RETRY) {
      const delay = LIVE_RETRY_DELAYS_MS[retryCount]
      retryCount += 1
      console.log(
        `[flv-engine] live stream error (${errorType}/${errorDetail}), retry ${retryCount}/${LIVE_MAX_RETRY} in ${delay}ms`
      )
      events.onRetrying?.(retryCount, LIVE_MAX_RETRY)
      clearRetryTimer()
      retryTimer = setTimeout(() => {
        if (disposed) return
        try {
          player.unload()
          player.load()
          const ret = player.play()
          if (ret && typeof ret.catch === 'function') ret.catch(() => {})
        } catch {
          /* ignore */
        }
      }, delay)
    } else {
      events.onExhausted?.(
        `拉流失败（${errorType}/${errorDetail}），已重试 ${LIVE_MAX_RETRY} 次`
      )
    }
  })

  const handleReady = () => {
    if (disposed) return
    retryCount = 0
    events.onReady?.()
  }
  player.on(flvjs.Events.MEDIA_INFO, handleReady)
  video.addEventListener('loadedmetadata', handleReady)

  player.on(flvjs.Events.STATISTICS_INFO, (info: Record<string, unknown>) => {
    if (disposed) return
    events.onStatistics?.({
      speed: (info.speed as number) ?? 0,
      decodedFrames: (info.decodedFrames as number) ?? 0,
      droppedFrames: (info.droppedFrames as number) ?? 0,
    })
  })

  player.on(flvjs.Events.LOADING_COMPLETE, () => {
    if (disposed) return
    console.warn('[flv-engine] live loading complete (stream ended)')
    events.onStreamEnd?.()
  })

  return () => {
    disposed = true
    clearRetryTimer()
    video.removeEventListener('loadedmetadata', handleReady)
  }
}
