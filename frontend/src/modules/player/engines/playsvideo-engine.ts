/**
 * playsvideo 引擎：浏览器端容器重封装 + 音轨转码。
 *
 * 取代原 wasm-engine（自研 EBML demux + 31MB 全量 ffmpeg 核心 + 手写 MSE），
 * 采用 playsvideo 库的三段式管线：
 *
 * ```
 * 视频文件（MKV/MP4/AVI/TS/WebM）
 *   → mediabunny 流式 demux（任意文件大小，Range 随机读取）
 *   → 关键帧对齐的分段计划
 *   → 每段：视频直通重封装 / 音频按需转码（AC3/EAC3/DTS/FLAC/MP3/Opus → AAC）
 *   → fMP4 分段 + m3u8
 *   → hls.js 按需取段播放
 * ```
 *
 * 相对旧 wasm-engine 的关键改进：
 * - **MSE 交给 hls.js**：不再手写 timestampOffset / appendWindow / 需求门控，
 *   从根上消除 InvalidStateError 刷屏与 seek 跳越失败。
 * - **核心体积 31MB → 1.9MB**：仅编译音频编解码器的专用 ffmpeg 构建，
 *   且随前端构建产物分发（不再运行时从 CDN 下载）。
 * - **自动决策直通/重封装**：playsvideo 的 playback-selection 会评估
 *   direct-url / direct-bytes / hls 三条路径，能原生播就原生播。
 *
 * 两个必须绕开的限制：
 * 1. **不支持自定义请求头**：`loadUrl()` 内部由 mediabunny `UrlSource` 裸
 *    fetch 取流，无法携带防盗链 Referer/UA，也受 CORS 约束。因此跨域源
 *   一律走后端 `/api/stream/proxy`（同源、后端注入 headers、透传 Range）；
 *   挂载直链模式（noProxyFallback）例外——保持源站直传零中转语义，
 *   要求源站允许 CORS，失败直接报错不回退代理（见 resolvePlaysVideoUrl）。
 * 2. **内嵌字幕由 playsvideo 提取，但由 ZViewer 渲染**：
 *    playsvideo 的产物是本机 `<track>` + blob URL，无法经 socket 广播给
 *    观众，因此 playsvideo-subtitle-bridge 会把它们取回并解析成
 *    ParsedCue[]，交回 ZViewer 既有的渲染与广播管线。
 *
 * 关于 `embeddedSubtitlePolicy: 'off'`：该策略**只关闭自动选中**，不阻止
 * 提取（见引擎源码——策略仅用于 shouldAutoSelectEmbeddedSubtitle）。保留
 * off 可让轨道挂上但不原生渲染，避免与 ZViewer 的 SubtitleOverlay 双字幕。
 *
 * 已知取舍：playsvideo 在导出 WebVTT 时会用 stripAssTags 剥掉 ASS 覆盖
 * 标签且丢弃样式表头，所以 ASS 特效在此链路下不可恢复地退化为纯文本。
 */
import { PlaysVideoEngine } from 'playsvideo'
import type { KeyframeIndex } from 'playsvideo'
import {
  fetchPlaysVideoTrackCues,
  publishPlaysVideoSubtitle,
  resetPlaysVideoSubtitles,
} from './playsvideo-subtitle-bridge'
import type {
  PlayerEngine,
  PlayerSource,
  EngineAttachResult,
  PlayerController,
  SeekResult,
} from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'
import {
  buildProxyUrl,
  appendAuthToken,
  isLocalUrl,
  isRelativeUrl,
} from '../services/url-proxy'
import { assertDirectLinkReachable } from './direct-route'
import { canDecodeCodecs } from '../hdr-capability'
import { t } from '@/i18n'

/**
 * 引擎准备超时模型（活动超时制，替代旧 60s 绝对超时）。
 *
 * 起播需完成探测 + 关键帧索引 + 首段产出，大文件或慢源可能耗时较久。
 * worker 在这些长耗时阶段每 3s 发 progress 心跳（本地补丁），主线程
 * 任一进展事件到达即重置活动计时器——慢源只要仍在取流/处理就不被
 * 硬杀；真死源（完全无事件）45s 即报错。绝对兜底防病态场景
 * （事件持续但永不 ready）无限等待。超时后 attach 直接失败并向上
 * 抛错——**不降级原生播放**（原生解码 DTS/AC3 等编码会无声或再次
 * 失败），由用户决定重载或调整影片级开关。
 */
const ACTIVITY_TIMEOUT_MS = 45_000
const ABSOLUTE_TIMEOUT_MS = 300_000

/**
 * 诊断 hook：定位 endOfStream 调用来源。
 *
 * 默认关闭（此前 TEMP-DIAG 期遗留的全局原型包裹——每次 endOfStream /
 * removeSourceBuffer / duration 写入都打 error + 完整堆栈，MSE 操作
 * 高频时开销可观且刷屏）。需要诊断时在控制台开启：
 *   localStorage.setItem('zviewer-media-debug', '1'); location.reload()
 * 与 lib/media-debug 探针共用同一开关。
 */
let diagInstalled = false
function installMediaSourceDiagnostics(): void {
  if (diagInstalled || typeof MediaSource === 'undefined') return
  if (localStorage.getItem('zviewer-media-debug') !== '1') return
  diagInstalled = true
  const proto = MediaSource.prototype as unknown as Record<string, unknown>
  const wrap = (name: string, extra: () => unknown) => {
    const orig = proto[name] as (...a: unknown[]) => unknown
    if (typeof orig !== 'function') return
    proto[name] = function (this: MediaSource, ...args: unknown[]) {
      console.error(
        `[MS-DIAG] ${name} readyState=${this.readyState}`,
        new Error('trace'),
        extra()
      )
      return orig.apply(this, args)
    }
  }
  wrap('endOfStream', () => '')
  wrap('removeSourceBuffer', () => '')
  const origSetDuration = Object.getOwnPropertyDescriptor(
    MediaSource.prototype,
    'duration'
  )?.set
  if (origSetDuration) {
    Object.defineProperty(MediaSource.prototype, 'duration', {
      set(this: MediaSource, v: number) {
        console.error(
          `[MS-DIAG] duration=${v} readyState=${this.readyState}`,
          new Error('trace')
        )
        origSetDuration.call(this, v)
      },
      get:
        Object.getOwnPropertyDescriptor(MediaSource.prototype, 'duration')
          ?.get ?? (() => undefined),
      configurable: true,
    })
  }
}

/** 判断当前浏览器是否具备 playsvideo 引擎的运行条件（MSE + Worker） */
export function isPlaysVideoSupported(): boolean {
  if (typeof window === 'undefined') return false
  if (typeof Worker !== 'function') return false
  if (!('MediaSource' in window)) return false
  return !!window.MediaSource?.isTypeSupported?.(
    'video/mp4; codecs="avc1.640029, mp4a.40.2"'
  )
}

/**
 * 解析 playsvideo 实际取流地址。
 *
 * 与 `resolveProxyUrl`（direct 引擎用，跨域优先直连省服务器流量）不同，
 * 本引擎**必须**保证同源：mediabunny 的裸 fetch 既带不了防盗链头，
 * 也过不了 CORS。故跨域源一律后端代理——代价是服务器承担流量，
 * 换来的是任意容器/编码都能播。
 *
 * 例外：挂载直链模式（noProxyFallback，一起看挂载直链影片）与 direct/hls
 * 引擎同语义——源站直传、服务器零媒体流量。mediabunny 裸 fetch 直连跨域
 * 源站需要源站允许 CORS，失败不回退代理（静默转代理会让服务器带宽跑满
 * 并掩盖直链本身的问题），由 attach 错误路径补充可操作指引。
 * 带防盗链 headers 的源不适用本例外：裸 fetch 带不了 headers，仍走代理。
 */
function resolvePlaysVideoUrl(source: PlayerSource): string {
  const url = source.url
  if (!url) return url
  // 同源 / 相对路径（如 /api/webdav/stream、/api/server-files/raw）：
  // 直接请求，仅需补 token（HTTP 环境下无 auth cookie）。
  if (isLocalUrl(url) || isRelativeUrl(url)) return appendAuthToken(url)
  // 挂载直链模式：保持源站直传语义。前置校验与 direct/hls 引擎一致
  // （HTTPS 页面下的 http 直链必然失败，发请求前给出可操作指引）。
  if (source.noProxyFallback === true && !source.headers) {
    assertDirectLinkReachable(url, true)
    return url
  }
  // 跨域：走后端代理，由后端注入防盗链头并透传 Range。
  return buildProxyUrl(url)
}

/**
 * 关键帧索引 URL 级复用缓存（内存 LRU + TTL）。
 *
 * MKV 管线的索引构建需经 Range 请求读 Cues，大文件 + 慢源可达数秒；
 * 重载按钮、recovery 回退重解析、切回同一影片等场景 URL 不变，索引
 * 完全可复用。来源：attach 成功后从 worker 回传的
 * `engine.builtKeyframeIndex`（本地补丁）读取；下次同 URL attach 经
 * `loadUrl(url, { keyframeIndex })` 传入，worker 跳过构建直接用。
 *
 * 失效策略：内存缓存（页面刷新即清）+ TTL 10 分钟 + 容量 4（LRU）。
 * 同 URL 文件被替换的窗口期会拿到过期索引（seek 定位偏移），窗口受
 * TTL 约束可接受；探测失败（null）不缓存，允许下次重试。
 */
interface CachedKeyframeIndex {
  index: KeyframeIndex
  cachedAt: number
}

const KEYFRAME_INDEX_CACHE_MAX = 4
const KEYFRAME_INDEX_TTL_MS = 10 * 60_000
const keyframeIndexCache = new Map<string, CachedKeyframeIndex>()

function peekCachedKeyframeIndex(url: string): KeyframeIndex | null {
  const entry = keyframeIndexCache.get(url)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > KEYFRAME_INDEX_TTL_MS) {
    keyframeIndexCache.delete(url)
    return null
  }
  return entry.index
}

function putCachedKeyframeIndex(url: string, index: KeyframeIndex): void {
  // Map 保持插入序：删后重插实现 LRU 触顶淘汰最旧
  keyframeIndexCache.delete(url)
  keyframeIndexCache.set(url, { index, cachedAt: Date.now() })
  while (keyframeIndexCache.size > KEYFRAME_INDEX_CACHE_MAX) {
    const oldest = keyframeIndexCache.keys().next().value
    if (oldest === undefined) break
    keyframeIndexCache.delete(oldest)
  }
}

/**
 * playsvideo 播放控制器。
 *
 * 每次 attach 都创建全新引擎世代（内部持有 worker + hls.js 实例），
 * 与旧 WasmPlayerController 的世代模型一致：切换/重载时旧实例整体销毁，
 * 杜绝残留管线继续向已拆除的 SourceBuffer 写入。
 */
class PlaysVideoController implements PlayerController {
  private video: HTMLVideoElement
  private source: PlayerSource
  private engine: PlaysVideoEngine | null = null
  /** 世代计数：异步 attach 返回时据此判断是否已被新实例取代 */
  private generation = 0
  /** 字幕桥接世代：attach 时向桥接层申请，切影片后旧结果自动作废 */
  private subtitleGen = 0
  /** 已处理过的 <track> 元素，避免重复提取（addtrack 可能重发） */
  private handledTrackEls = new WeakSet<HTMLTrackElement>()
  /**
   * 轨道序号：**挂载时同步分配**（MutationObserver 回调），而非提取完成时
   * 按完成序推算。playsvideo 按 subtitleTracks 顺序 appendChild，挂载序即
   * 轨道序；各轨道的 fetch + 解析是异步并发的，完成序与挂载序无关——按
   * 完成序分配会让 index 与 subtitleTracks 的 label/language/codec 元数据
   * 错位（内容大的轨道后完成即被挤到后面的序号）。
   */
  private subtitleOrdinals = new WeakMap<HTMLTrackElement, number>()
  /** 已分配的轨道序号计数（配合 subtitleOrdinals 使用） */
  private publishedSubtitleCount = 0
  /** 撤销 addtrack 监听（cleanup 时调用） */
  private unbindSubtitles: (() => void) | null = null
  /** 中断进行中的字幕 blob 读取 */
  private subtitleAbort: AbortController | null = null
  /**
   * 进行中 attach 的 waitReady reject 句柄。
   *
   * engine.destroy() 终止 worker 后**不会**再发出 ready/error 事件——
   * 若不在销毁时主动唤醒 waitReady，被新加载打断的旧 attach 会空等
   * 满超时时长才报「准备超时」（日志实证：超时点与打断点相差的正是
   * 剩余等待时长），既误报错误又长时间占用 attach 串行队列。
   */
  private pendingReadyReject: ((err: Error) => void) | null = null

  constructor(video: HTMLVideoElement, source: PlayerSource) {
    this.video = video
    this.source = source
  }

  get isAttached(): boolean {
    return !!this.engine && this.engine.phase === 'ready'
  }

  get isSeeking(): boolean {
    return false
  }

  async attach(startTime?: number): Promise<string> {
    if (!isPlaysVideoSupported()) {
      throw new Error(t('浏览器不支持 MSE/WebWorker，无法启用浏览器端转码'))
    }
    installMediaSourceDiagnostics()

    // 结束旧世代（切换 / 重载场景）
    this.cleanup()
    resetVideoElement(this.video)

    const gen = ++this.generation
    const url = resolvePlaysVideoUrl(this.source)

    const engine = new PlaysVideoEngine(this.video, {
      // 提取内嵌字幕但**不自动选中**：轨道会挂到 video 上（blob URL），
      // 由 playsvideo-subtitle-bridge 取回转成 ParsedCue[] 交给 ZViewer
      // 渲染。若改为 'auto' 会同时启用原生渲染，与 SubtitleOverlay 重影。
      embeddedSubtitlePolicy: 'off',
    })
    this.engine = engine

    // 开启新字幕会话：旧会话迟到的提取结果会被桥接层丢弃
    this.subtitleGen = resetPlaysVideoSubtitles()
    this.bindSubtitleBridge()

    try {
      // 关键帧索引复用：同 URL 的重载/切回直接传入缓存索引，worker 跳过
      // Range 探测（大文件 + 慢源可省数秒起播时间）。缓存 key 用 source.url
      // （原始地址，不含 token）——token 每次刷新都会变，用最终请求 URL
      // 做 key 会让 token 刷新后的重载全部 miss。
      const cachedIndex = peekCachedKeyframeIndex(this.source.url)
      engine.loadUrl(
        url,
        cachedIndex ? { keyframeIndex: cachedIndex } : undefined
      )
      await this.waitReady(engine, this.source.onAttachProgress)
    } catch (err) {
      // 起播失败（容器不支持 / 探测超时 / 取流不可达）：
      // 必须终结本世代并释放 worker，否则旧管线残留会与回退引擎竞争 video。
      if (this.engine === engine) {
        this.destroyEngine()
        this.generation++
      }
      // 直链模式：不回退服务器中转，错误透出并补充可操作指引。
      // mediabunny 的 CORS / 网络失败报「Failed to fetch」等泛化文案，
      // 需要指明「源站需允许跨域直连」；前置校验（assertDirectLinkReachable）
      // 抛出的错误已带指引，直接透传避免文案嵌套。
      if (
        this.source.noProxyFallback === true &&
        !this.source.headers &&
        this.source.url &&
        !isLocalUrl(this.source.url) &&
        !isRelativeUrl(this.source.url) &&
        !(err instanceof Error && err.message.startsWith('直链播放失败'))
      ) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `直链播放失败：${reason}。浏览器转码引擎需源站允许浏览器跨域直连（CORS），` +
            t(
              '不经服务器中转；请检查源站可达性与跨域配置，或关闭影片的挂载直链模式'
            ),
          { cause: err }
        )
      }
      throw err
    }

    // 世代已被取代：本次 attach 的结果作废，静默让位
    if (gen !== this.generation) {
      return ''
    }

    // 回存 worker 本地构建的关键帧索引（缓存命中时 worker 直接用传入
    // 索引、不重建不回传，不会重复缓存）
    const builtIndex = engine.builtKeyframeIndex
    if (builtIndex && this.source.url) {
      putCachedKeyframeIndex(this.source.url, builtIndex)
    }

    // 时长兜底：HLS 模式下 video.duration 由 hls.js 填充，
    // 少数源不可用时由控制栏回退读 dataset.serverDuration。
    if (engine.durationSec > 0) {
      this.video.dataset.serverDuration = String(engine.durationSec)
    }

    // pipeline 模式下 ready 先于 startHls 触发，此时 readyState 可能仍为 0，
    // 直接赋值 currentTime 会被浏览器丢弃（与 waitForMetadata 的注释同理）。
    await waitForMetadata(this.video)

    const start = startTime ?? this.source.startTime ?? 0
    if (start > 0) {
      try {
        this.video.currentTime = start
      } catch {
        // seek 失败不阻断 attach：停留在 0 由上层同步逻辑纠正
      }
    }

    // 无 blob URL：playsvideo 直接接管 video.src
    return ''
  }

  /**
   * 等待引擎 ready / error（活动超时制）。
   *
   * - 活动超时：progress 心跳（probe/index/ffmpeg/seg0）与 decision /
   *   workerstate / segmentstate / subtitle 事件任一到达即重置计时器；
   * - 绝对兜底：整体超过 ABSOLUTE_TIMEOUT_MS 强制失败。
   *
   * 同时把进展经 onProgress 透出（stage + 可选 detail），供上层在
   * 解析/重载 loading 态展示进度。
   *
   * 世代校验不在这里做：监听器注册时 gen 必然等于当前世代，判断无意义；
   * 真正的作废检查在 attach 的 await 之后进行。
   */
  private waitReady(
    engine: PlaysVideoEngine,
    onProgress?: (stage: string, detail?: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let activityTimer: ReturnType<typeof setTimeout> | null = null
      let lastSegmentsDetail: string | null = null
      let workersReported = false
      const cleanup = () => {
        engine.removeEventListener('ready', onReady)
        engine.removeEventListener('error', onError)
        engine.removeEventListener('progress', onProgressEvent)
        engine.removeEventListener('playbackdecision', onDecision)
        engine.removeEventListener('workerstatechange', onWorkerActivity)
        engine.removeEventListener('segmentstatechange', onSegmentActivity)
        engine.removeEventListener('subtitle-status', onActivity)
        clearTimeout(activityTimer)
        clearTimeout(absoluteTimer)
        if (this.pendingReadyReject === onRejectExternal) {
          this.pendingReadyReject = null
        }
      }
      const fail = (err: Error) => {
        cleanup()
        reject(err)
      }
      const resetActivity = () => {
        if (activityTimer) clearTimeout(activityTimer)
        activityTimer = setTimeout(() => {
          fail(
            new Error(
              `浏览器转码引擎 ${Math.round(ACTIVITY_TIMEOUT_MS / 1000)}s 无进展（源站无响应或处理停滞），可尝试重载影片`
            )
          )
        }, ACTIVITY_TIMEOUT_MS)
      }
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = (e: CustomEvent<{ message?: string }>) => {
        cleanup()
        reject(new Error(e.detail?.message || t('playsvideo 引擎启动失败')))
      }
      // destroyEngine 触发的外部唤醒（cleanup / 新世代接管 / 卸载）
      const onRejectExternal = (err: Error) => {
        cleanup()
        reject(err)
      }
      const onActivity = () => resetActivity()
      const onProgressEvent = (e: CustomEvent<{ stage?: string }>) => {
        resetActivity()
        if (e.detail?.stage) onProgress?.(e.detail.stage)
      }
      const onDecision = (
        e: CustomEvent<{
          evaluation?: { recommended?: { option?: { mode?: string } } }
        }>
      ) => {
        resetActivity()
        const mode = e.detail?.evaluation?.recommended?.option?.mode
        onProgress?.('decision', typeof mode === 'string' ? mode : undefined)
      }
      const onWorkerActivity = () => {
        resetActivity()
        // worker 状态事件高频（每个 job 更新一次），仅首次透出启动信号
        if (!workersReported) {
          workersReported = true
          onProgress?.('workers')
        }
      }
      const onSegmentActivity = (
        e: CustomEvent<{ segments?: { phase: string }[] }>
      ) => {
        resetActivity()
        const segs = e.detail?.segments
        if (!segs?.length) return
        const done = segs.filter((s) =>
          ['ready', 'delivered', 'cache-hit'].includes(s.phase)
        ).length
        const detail = `${done}/${segs.length}`
        if (detail !== lastSegmentsDetail) {
          lastSegmentsDetail = detail
          onProgress?.('segments', detail)
        }
      }
      const absoluteTimer = setTimeout(() => {
        fail(
          new Error(
            `浏览器转码引擎准备超时（${Math.round(ABSOLUTE_TIMEOUT_MS / 60_000)} 分钟），可尝试重载影片`
          )
        )
      }, ABSOLUTE_TIMEOUT_MS)

      resetActivity()
      this.pendingReadyReject = onRejectExternal
      engine.addEventListener('ready', onReady)
      engine.addEventListener('error', onError)
      engine.addEventListener('progress', onProgressEvent)
      engine.addEventListener('playbackdecision', onDecision)
      engine.addEventListener('workerstatechange', onWorkerActivity)
      engine.addEventListener('segmentstatechange', onSegmentActivity)
      engine.addEventListener('subtitle-status', onActivity)
    })
  }

  /**
   * seek 到目标时间。
   *
   * playsvideo 的 HLS 管线由 hls.js 托管，直接设置 `video.currentTime`
   * 即可——hls.js 会自动加载目标位置所属分段，无需（也不能）手动
   * 清理 SourceBuffer 或重建 MediaSource。这正是取代手写 MSE 的最大收益。
   */
  async seekTo(targetTime: number): Promise<SeekResult> {
    if (!this.engine || this.engine.phase !== 'ready') {
      return { success: false, needReload: true, message: t('未挂载') }
    }
    try {
      this.video.currentTime = targetTime
      return { success: true }
    } catch (err) {
      return {
        success: false,
        needReload: true,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * 监听 playsvideo 挂载的原生字幕轨，取回内容后交给 ZViewer 渲染管线。
   *
   * playsvideo 每提取完一条轨就 `video.appendChild(track)`，触发
   * `textTracks` 的 addtrack 事件。ZViewer 与 ArtPlayer 都不创建 `<track>`
   * 元素，因此挂到 video 上的必然是 playsvideo 的轨道。
   *
   * 提取是异步且滞后的（大文件可能晚于起播数十秒），故走事件而非轮询。
   */
  private bindSubtitleBridge(): void {
    const video = this.video
    const gen = this.subtitleGen

    // 用 MutationObserver 而非 video.textTracks 的 addtrack 事件：
    // addtrack 的触发时机依赖浏览器的 TextTrackList 实现细节（不同浏览器
    // 在 <track> 插入后何时把它纳入列表并不一致），一旦不触发就会静默丢失
    // 全部内嵌字幕。MutationObserver 监听的是 appendChild 这个 DOM 动作
    // 本身，语义确定，不受浏览器差异影响。
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLTrackElement) {
            // 挂载时同步分配序号（见 subtitleOrdinals 注释）
            const ordinal = this.publishedSubtitleCount++
            this.subtitleOrdinals.set(node, ordinal)
            void this.extractSubtitleTrack(node, gen)
          }
        }
      }
    })
    observer.observe(video, { childList: true })

    // 兜底：绑定前就已存在的轨道（引擎复用等场景）立即补扫一次
    for (const el of video.querySelectorAll('track')) {
      void this.extractSubtitleTrack(el, gen)
    }

    this.unbindSubtitles = () => observer.disconnect()
  }

  /** 取回单条轨道的 WebVTT 内容并发布给字幕桥接层。 */
  private async extractSubtitleTrack(
    element: HTMLTrackElement,
    gen: number
  ): Promise<void> {
    if (this.handledTrackEls.has(element)) return
    this.handledTrackEls.add(element)

    const abort = this.subtitleAbort ?? new AbortController()
    this.subtitleAbort = abort

    const label = element.label || t('未命名轨道')
    const cues = await fetchPlaysVideoTrackCues(element, abort.signal)
    console.info(
      `[playsvideo-subtitles] 轨道「${label}」取回 ${cues.length} 条 cue`
    )
    if (cues.length === 0) return

    // 轨道序号在挂载时已分配（observer 同步写入 subtitleOrdinals）；
    // 兜底扫描路径（绑定前已存在的轨道）没有分配记录，按完成序补分配
    const ordinal =
      this.subtitleOrdinals.get(element) ?? this.publishedSubtitleCount++
    const info = this.engine?.subtitleTracks?.[ordinal]

    publishPlaysVideoSubtitle(gen, {
      index: ordinal,
      label: element.label || `轨道 ${ordinal + 1}`,
      language: element.srclang || info?.language || null,
      codec: info?.codec ?? 'unknown',
      cues,
    })
    console.info(`[playsvideo-subtitles] 轨道「${label}」已发布（世代 ${gen}）`)
  }

  private destroyEngine(): void {
    try {
      this.engine?.destroy()
    } catch {
      /* ignore */
    }
    this.engine = null
    // 引擎已销毁（cleanup / 新世代接管）：worker 终止后不会再有 ready/error
    // 事件，立即唤醒进行中的 waitReady，避免其空等满 60s 报假超时。
    const rejectPending = this.pendingReadyReject
    this.pendingReadyReject = null
    rejectPending?.(
      new Error(t('PLAYSVIDEO_ATTACH_CANCELLED: 引擎已被新加载销毁'))
    )
  }

  cleanup(): void {
    // 先停字幕再毁引擎：避免 destroy 移除 <track> 时触发无意义的提取
    this.unbindSubtitles?.()
    this.unbindSubtitles = null
    this.subtitleAbort?.abort()
    this.subtitleAbort = null
    this.publishedSubtitleCount = 0
    // 递增桥接世代：否则旧会话迟到的字幕会串到下一部片。
    // 尤其切到 direct 引擎的片源时不会走 attach，不在这里作废就会污染新轨道。
    resetPlaysVideoSubtitles()
    this.destroyEngine()
    this.generation++
    delete this.video.dataset.serverDuration
  }
}

export const playsVideoEngine: PlayerEngine = {
  type: 'playsvideo',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    // 重封装只切容器、不解码视频，因此源编码必须由 MSE 直接支持。
    // HDR（HEVC Main10）在无硬解的设备上会 append 失败，这里提前给出人话。
    if (!canDecodeCodecs(source.videoCodec)) {
      throw new Error(
        `当前设备无法解码该视频编码（${source.videoCodec}），请更换播放设备或转码后再试`
      )
    }
    const controller = new PlaysVideoController(video, source)
    try {
      await controller.attach(source.startTime ?? 0)
    } catch (err) {
      // attach 半途失败：终结半挂载实例，避免残留 worker 与回退引擎竞争
      controller.cleanup()
      throw err
    }
    return {
      cleanup: () => controller.cleanup(),
      player: controller,
    }
  },
}
