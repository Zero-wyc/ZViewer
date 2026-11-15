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
 * 直播「CLI」线路（source.liveDirect）：URL 已经由上游包装成
 * `127.0.0.1:9333/proxy?url=...&ref=live`，媒体流由本机 CLI 直连 CDN。
 * 它是硬约束：连续失败即判失败并提示用户检查 CLI 或切回中转，
 * 绝不静默改走服务器代理（那样服务器带宽照样被打满，线路选择形同虚设）。
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
import { t } from '@/i18n'

/** 快速恢复之后保持低频重试，直到房间离线使播放器卸载。 */
const LIVE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000]
const LIVE_RETRY_INTERVAL_MS = 10000
/**
 * 直播 CLI 线路的失败判定阈值：连续这么多次 ERROR 后不再重连。
 * CLI 未启动/未连接是确定性失败，重试没有意义，继续静默重连只会让画面
 * 一直黑着，不如尽早提示用户检查 CLI 或切回中转。
 */
const LIVE_DIRECT_FAIL_LIMIT = 2

/**
 * 直播延迟追帧（引擎层实现，见 attachLiveHandlers 里的 startLatencyChaser）。
 *
 * 延迟上限：超过才追——追帧会前跳播放位置、短暂打断解码，因此把阈值放得
 * 足够高，只在「抖动已造成延迟明显累积」时出手。
 */
const LIVE_LATENCY_CHASE_MAX_S = 8
/** 追帧目标：追到这个缓冲深度为止，保留抗抖动的缓冲余量。 */
const LIVE_LATENCY_CHASE_TARGET_S = 5
/** 两次追帧之间的最小间隔。 */
const LIVE_LATENCY_CHASE_COOLDOWN_MS = 10_000
/** 刚发生过卡顿（waiting）时暂不追帧，等缓冲稳定。 */
const LIVE_LATENCY_STALL_GUARD_MS = 8_000

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
    // 注意：不要在这里传 liveBufferLatencyChasing / MaxLatency / TargetLatency。
    // 这组配置是 bilibili/flv.js master 分支的实现，npm 发布的 flv.js@1.6.2
    // 里根本没有这几个键（实测源码 grep 为 0），传了也是静默 no-op——
    // 延迟追帧由本引擎自己实现（见 attachLiveHandlers 的 startLatencyChaser），
    // 阈值选得比原配置保守：追帧会打断解码，目标是「延迟不无限累积」
    // 而不是「贴着直播边缘看」。
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
    // 直播线路=CLI：URL 已是本机 CLI 代理，引擎只认这一条，不准备代理后路。
    const liveDirect = isLive && source.liveDirect === true
    const targetUrl = resolveProxyUrl(
      source.url,
      source.headers,
      source.format,
      { liveDirect }
    )

    const player = flvjs.createPlayer(
      {
        type: 'flv',
        url: targetUrl,
        isLive,
        cors: true,
      },
      isLive ? buildLiveConfig() : { enableWorker: false, lazyLoad: false }
    )

    let destroyed = false
    let disposeLive: (() => void) | null = null
    // CLI 线路判定失败时提前结束 attach：onFatal 让这里的 Promise 立即 reject，
    // 不必干等 metadata 的 30s 超时（否则用户对着黑屏不知发生了什么）。
    let rejectAttach: ((err: Error) => void) | null = null
    const fatalAttach = new Promise<never>((_, reject) => {
      rejectAttach = reject
    })
    if (isLive) {
      disposeLive = attachLiveHandlers(
        video,
        player,
        source.flvRuntimeEvents ?? {},
        {
          liveDirect,
          onFatal: (message) => rejectAttach?.(new Error(message)),
        }
      )
    }

    const destroy = () => {
      if (destroyed) return
      destroyed = true
      disposeLive?.()
      disposeLive = null
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
      await Promise.race([waitForMetadata(video), fatalAttach])
    } catch (err) {
      destroy()
      // 直播 CLI 线路连不上本机代理（未启动 / 端口被占 / 直播流被 CDN 拒），
      // CLI 语义不允许改走服务器代理，直接给出可操作指引。
      if (liveDirect) {
        const reason = err instanceof Error ? err.message : String(err)
        const hint = t(
          '直播连线失败：请确认本地 ZViewer CLI 正在运行，或在影片卡片切换为服务器中转'
        )
        throw reason.includes(hint)
          ? err
          : new Error(`${hint}（${reason}）`, { cause: err })
      }
      throw err
    }

    return { cleanup: destroy }
  },
}

/**
 * 直播模式事件接线：flv.js 实例事件 → FlvRuntimeEvents 出口 + 内部重连。
 *
 * - ERROR / LOADING_COMPLETE：指数退避重连，随后低频等待推流恢复；
 * - CLI 线路连续 ERROR 达到阈值：判定失败，停止重连并上报 onExhausted
 *   （不换代理地址，线路选择权在用户手里）；
 * - MEDIA_INFO / loadedmetadata：重连成功计数复位 + onReady；
 * - STATISTICS_INFO：原始网络层统计转发（fps 由消费方计算）。
 *
 * @returns 清理函数：移除 video 元素监听与重连定时器（destroy 时调用）。
 */
function attachLiveHandlers(
  video: HTMLVideoElement,
  player: flvjs.Player,
  events: FlvRuntimeEvents,
  options: {
    liveDirect: boolean
    /** CLI 线路判定失败：让 attach 立即失败（不等待 metadata 超时） */
    onFatal?: (message: string) => void
  }
): () => void {
  let retryCount = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  // 延迟追帧状态：最近一次卡顿时间 / 最近一次追帧时间
  let lastStallAt = 0
  let lastChaseAt = 0
  let chaseTimer: ReturnType<typeof setInterval> | null = null

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleRetry = (errorType: string, errorDetail: string) => {
    if (disposed || retryTimer !== null) return

    // CLI 线路：网络错误连续达到阈值即判失败。主播下播（LOADING_COMPLETE）
    // 不在此列——那不是线路问题，继续低频等待推流恢复即可。
    if (
      options.liveDirect &&
      errorType !== 'stream' &&
      retryCount >= LIVE_DIRECT_FAIL_LIMIT
    ) {
      console.warn('[flv-engine] 直播 CLI 线路连接失败，停止重连（不自动中转）')
      disposed = true
      clearRetryTimer()
      const hint = t(
        '直播连线失败：请确认本地 ZViewer CLI 正在运行，或在影片卡片切换为服务器中转'
      )
      events.onExhausted?.(hint)
      options.onFatal?.(hint)
      return
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

  // 延迟追帧：网络抖动（CDN 顿一下、CLI 代理重连）会让播放位置永久落后——
  // 卡顿期间 currentTime 冻结、缓冲却在继续增长，延迟每抖一次涨一截且
  // 再也不会自己缩回去。npm flv.js@1.6.2 不支持 liveBufferLatencyChasing
  // （那组配置是静默 no-op），只能在这里自己追：
  // - 延迟超过 LIVE_LATENCY_CHASE_MAX_S 才追（追帧 = 前跳 = 打断解码，
  //   不能频繁触发）；
  // - 追到 LIVE_LATENCY_CHASE_TARGET_S，保留抗抖缓冲；
  // - 冷却 + 卡顿保护，避免追帧与卡顿互相放大。
  const onVideoWaiting = () => {
    lastStallAt = performance.now()
  }
  video.addEventListener('waiting', onVideoWaiting)
  chaseTimer = setInterval(() => {
    if (disposed || video.paused || video.readyState < 3) return
    if (!video.buffered.length) return
    const now = performance.now()
    if (now - lastChaseAt < LIVE_LATENCY_CHASE_COOLDOWN_MS) return
    if (now - lastStallAt < LIVE_LATENCY_STALL_GUARD_MS) return
    const latency = video.buffered.end(video.buffered.length - 1) - video.currentTime
    if (latency <= LIVE_LATENCY_CHASE_MAX_S) return
    const target = video.buffered.end(video.buffered.length - 1) - LIVE_LATENCY_CHASE_TARGET_S
    if (target <= video.currentTime) return
    lastChaseAt = now
    console.log(
      `[flv-engine] live latency ${latency.toFixed(1)}s > ${LIVE_LATENCY_CHASE_MAX_S}s, chasing to ~${LIVE_LATENCY_CHASE_TARGET_S}s`
    )
    video.currentTime = target
  }, 1000)

  return () => {
    disposed = true
    clearRetryTimer()
    if (chaseTimer !== null) {
      clearInterval(chaseTimer)
      chaseTimer = null
    }
    video.removeEventListener('loadedmetadata', handleReady)
    video.removeEventListener('waiting', onVideoWaiting)
  }
}
