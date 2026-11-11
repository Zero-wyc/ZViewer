/**
 * FLV 引擎：通过 flv.js 将 FLV 流挂载到 <video> 元素。
 *
 * 两种模式：
 * - **VOD**（默认）：isLive=false，attach 在 metadata 就绪后 resolve。
 * - **直播**（source.isLive）：isLive=true + 延迟追赶 + SourceBuffer
 *   自动清理；停流或网络错误先按指数退避重连，再持续低频重试，
 *   重连状态经 source.flvRuntimeEvents 上报给 UI 层——
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
import { buildProxyUrl, resolveProxyUrl } from '../services/url-proxy'
import { t } from '@/i18n'

/** 快速恢复之后保持低频重试，直到房间离线使播放器卸载。 */
const LIVE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]
const LIVE_RETRY_INTERVAL_MS = 10000

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
      throw new Error(t('当前浏览器不支持 FLV 播放且 flv.js 不可用'))
    }

    resetVideoElement(video)

    const isLive = source.isLive === true
    // 统一代理策略：由 url-proxy.ts 根据 URL 特征与源格式决定。
    // 直播选「直链」时这里拿到的就是 CDN 原地址，下面为它准备一条代理回退路径。
    const targetUrl = resolveProxyUrl(
      source.url,
      source.headers,
      source.format,
      { liveDirect: isLive && source.liveDirect === true }
    )
    const direct =
      isLive && source.liveDirect === true && targetUrl === source.url
    const proxyFallbackUrl = direct ? buildProxyUrl(source.url) : null

    let player: flvjs.Player | null = null
    let disposeLive: (() => void) | null = null
    let destroyed = false

    const teardown = (instance: flvjs.Player) => {
      try {
        instance.pause()
        instance.unload()
        instance.detachMediaElement()
        instance.destroy()
      } catch {
        /* ignore */
      }
    }

    /**
     * 创建并挂载一个 flv.js 实例。
     *
     * 直播直连失败时会被再次调用（换成代理地址重建），因此实例与事件监听
     * 都放在闭包里，由 cleanup 销毁「当前这一个」。
     */
    const start = (url: string, viaProxy: boolean) => {
      if (destroyed) return
      disposeLive?.()
      disposeLive = null
      if (player) {
        teardown(player)
        player = null
      }

      const next = flvjs.createPlayer(
        {
          type: 'flv',
          url,
          isLive,
          cors: true,
        },
        isLive ? buildLiveConfig() : { enableWorker: false, lazyLoad: false }
      )
      player = next

      if (isLive) {
        disposeLive = attachLiveHandlers(
          video,
          next,
          source.flvRuntimeEvents ?? {},
          // 直连专属：连续两次拉流失败即回退服务器中转（仅尝试一次）
          !viaProxy && proxyFallbackUrl
            ? () => {
                start(proxyFallbackUrl, true)
                return true
              }
            : undefined
        )
      }

      next.attachMediaElement(video)
      next.load()
    }

    const destroy = () => {
      if (destroyed) return
      destroyed = true
      disposeLive?.()
      disposeLive = null
      if (player) {
        teardown(player)
        player = null
      }
    }

    start(targetUrl, proxyFallbackUrl !== null)

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
 * - ERROR / LOADING_COMPLETE：指数退避重连，随后低频等待推流恢复；
 * - MEDIA_INFO / loadedmetadata：重连成功计数复位 + onReady；
 * - STATISTICS_INFO：原始网络层统计转发（fps 由消费方计算）；
 *
 * @returns 清理函数：移除 video 元素监听与重连定时器（destroy 时调用）。
 */
function attachLiveHandlers(
  video: HTMLVideoElement,
  player: flvjs.Player,
  events: FlvRuntimeEvents,
  /** 直连线路的回退出口：返回 true 表示已换代理地址重建播放器 */
  fallbackToProxy?: () => boolean
): () => void {
  let retryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let fallback = fallbackToProxy

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleRetry = (errorType: string, errorDetail: string) => {
    if (disposed || retryTimer !== null) return

    // 直连线路：连续两次拉流失败，基本可判定该 CDN 节点拒绝浏览器直连
    // （CORS / Referer / 边缘节点策略差异），换服务器中转重建一次。
    // 只尝试一次：代理再失败就是上游问题了，走正常重连节奏。
    if (retryCount >= 2 && fallback) {
      const rebuild = fallback
      fallback = undefined
      console.warn('[flv-engine] 直播直连连续失败，回退服务器中转')
      if (rebuild()) {
        disposed = true
        clearRetryTimer()
        return
      }
    }

    const delay = LIVE_RETRY_DELAYS_MS[retryCount] ?? LIVE_RETRY_INTERVAL_MS
    retryCount += 1
    console.log(
      `[flv-engine] live stream error (${errorType}/${errorDetail}), retry ${retryCount} in ${delay}ms`
    )
    events.onRetrying?.(retryCount, Number.POSITIVE_INFINITY)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (disposed) return
      try {
        player.unload()
        player.load()
        const ret = player.play()
        if (ret && typeof ret.catch === 'function') ret.catch(() => {})
      } catch {
        scheduleRetry('reconnect', 'failed')
      }
    }, delay)
  }
  player.on(flvjs.Events.ERROR, scheduleRetry)

  const handleReady = () => {
    if (disposed) return
    clearRetryTimer()
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
    scheduleRetry('stream', 'ended')
  })

  return () => {
    disposed = true
    clearRetryTimer()
    video.removeEventListener('loadedmetadata', handleReady)
  }
}
