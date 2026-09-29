/**
 * Video.js 10 DASH 引擎（第二阶段：DASH 执行层全量移交 v10）。
 *
 * 架构（「MPD 构建 = 自研，执行/状态层 = Video.js 10 + dash.js 5.2.0」）：
 *
 * 1. MPD 构建层（自研，./dash/mpd-builder.ts）：m4s 头部预读、sidx/moov 解析
 *    （mp4-box-parser）、字节偏移计算、线性估算扩展、双轨 m4s 虚拟 MPD 生成、
 *    IndexedDB Blob 模式（缓冲模式零网络流量）。这是 B站 播放的核心自研资产，
 *    v10 RC 无此能力（官方 @videojs/dash-video 只是 dash.js 的 Media 合同包装，
 *    不带分片决策）；
 * 2. 执行层（@videojs/dash-video 的 DashAdapter，内置 dash.js 5.2.0）：
 *    DashAdapter 继承 HTMLVideoAdapter——既是 dash.js 执行器又是 v10 media
 *    合同实现，v10 headless store 直接以它为 media 镜像状态（单一实例，
 *    无二次桥接），paused/currentTime/seeking/duration/buffered 经 video
 *    元素事件实时流入 store（数据只向上流）；
 * 3. 引擎级跳转：EngineDashController 保留 busy 互斥、seeked 等待与
 *    needReload 诊断等 MSE 增强（自 DashPlayer 迁移）；
 * 4. startTime：dash.js 5.2.0 的 attachSource(url, startTime) 原生支持起始
 *    位置，直接从目标时间加载，无「先加载文件头再 seek」的浪费。
 *
 * 实现细节：
 * - dash.js 配置（禁 ABR/缓冲策略/gap 修复）、XHR credentials（代理接口要求
 *   登录态；CLI 代理跨域 omit）与 ERROR 事件监听均经 engine 逃生舱调用——
 *   adapter.source setter 不透传 attachSource 的 startTime 参数，故统一走
 *   engine 直接操作（DashAdapter 的 source getter 不再承载状态，属预期）；
 * - P2P（SwarmCloud）与 dash.js 4.7.4 已于第二阶段移除；
 * - 控制台调试入口 window.__vjs10DashStore.$state() 可观察 v10 状态机。
 */
import { DashAdapter } from '@videojs/dash-video'
import type {
  PlayerEngine,
  PlayerSource,
  EngineAttachResult,
  PlayerController,
  SeekResult,
} from '../types'
import { videoFeatures } from '@videojs/core/dom'
import { combine, createStore } from '@videojs/store'
import { waitForMetadata } from '../utils'
import { resolveProxyUrl, isCliProxyUrl } from '../services/url-proxy'
import {
  generateMpd,
  parseInitFromBlob,
  preloadInitSegment,
} from './dash/mpd-builder'

/** dash.js MediaPlayerClass（dash.js 5.2.0，经 DashAdapter.engine 类型推导） */
type DashEngineInstance = DashAdapter['engine']

/** dash.js 错误事件记录（用于 seek 失败诊断） */
interface DashErrorRecord {
  code?: string
  message?: string
}

/** 引擎 attach 与控制器共享的运行时上下文 */
interface DashEngineContext {
  video: HTMLVideoElement
  adapter: DashAdapter
  engine: DashEngineInstance
  /** MPD blob URL（引擎 cleanup 与调用方切换时都会 revoke，幂等） */
  mpdBlobUrl: string
  /** 缓冲模式：video/audio 的 blob URL，cleanup 时统一 revoke */
  mediaBlobUrls: string[]
  attachAbort: AbortController | null
  lastDashError: DashErrorRecord | null
  disposed: boolean
  attached: boolean
  seeking: boolean
}

/**
 * DASH 引擎控制器（PlayerController 实现，自 DashPlayer 迁移）。
 *
 * attach 由引擎在创建本控制器前完成（本类的 attach 仅返回 MPD URL，
 * 满足接口契约）；seekTo/cleanup 为实际职责。
 */
class EngineDashController implements PlayerController {
  private readonly ctx: DashEngineContext

  constructor(ctx: DashEngineContext) {
    this.ctx = ctx
  }

  get isAttached(): boolean {
    return this.ctx.attached
  }

  get isSeeking(): boolean {
    return this.ctx.seeking
  }

  async attach(): Promise<string> {
    // 实际 attach 已由 videojs10DashEngine.attach 完成（DashAdapter 挂载 +
    // attachSource + metadata 等待），此处仅返回 MPD URL 满足接口契约
    return this.ctx.mpdBlobUrl
  }

  /**
   * seek 到目标时间。
   *
   * dash.js 的 seek 机制：设置 video.currentTime = x 后，
   * dash.js 内部自动 abort 旧下载、清空 SourceBuffer、按需 Range 重新下载
   * 目标位置的 segment。无需手动管理 SourceBuffer 清理与 init segment 重 append。
   *
   * 等待 seeked 事件后再返回，避免 seek-service 的 isReloadingRef 过早释放
   * 导致后续 seeking 事件触发循环 seek。
   */
  async seekTo(targetTime: number): Promise<SeekResult> {
    const { video } = this.ctx
    if (!this.ctx.attached) {
      return { success: false, message: 'DASH 引擎未 attach' }
    }
    // 重入保护：上一次 seek 尚未完成（waitForSeeked 中）时拒绝新请求。
    // 否则两个并发 seekTo 的 waitForSeeked 会被同一个 seeked 事件提前 resolve，
    // 且第二个的 currentTime 赋值会打断第一个的下载。
    // 调用方（seek-service）对 busy 结果会记录为 pending 目标，锁释放后接续处理。
    if (this.ctx.seeking) {
      return { success: false, busy: true, message: 'DASH 引擎正在 seek' }
    }

    this.ctx.seeking = true
    // 清空上次错误记录，避免误报
    this.ctx.lastDashError = null

    try {
      // 快速路径：目标在已缓冲范围内，直接 seek
      for (let i = 0; i < video.buffered.length; i++) {
        if (
          targetTime >= video.buffered.start(i) &&
          targetTime <= video.buffered.end(i)
        ) {
          video.currentTime = targetTime
          return { success: true }
        }
      }

      // dash.js 的 seek 由 video.currentTime = x 触发，内部自动处理 Range 请求
      video.currentTime = targetTime

      // 等待 seeked 事件（dash.js 完成下载并 append）
      await this.waitForSeeked(targetTime)

      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'seek 失败'
      // 输出详细诊断信息：video.error + dash.js 错误事件 + 缓冲状态
      const videoErr = video.error
      const buffered =
        video.buffered.length > 0
          ? `${video.buffered.start(0).toFixed(1)}-${video.buffered.end(video.buffered.length - 1).toFixed(1)}`
          : '空'
      const dashErr = this.ctx.lastDashError
      console.error(
        `[videojs10-dash-engine] seek 到 ${targetTime.toFixed(1)}s 失败: ${message}\n` +
          `  video.error: ${videoErr ? `code=${videoErr.code} ${videoErr.message}` : '无'}\n` +
          `  dash.js 错误: ${dashErr ? `${dashErr.code || ''} ${dashErr.message || ''}` : '无'}\n` +
          `  缓冲范围: ${buffered}\n` +
          `  readyState: ${video.readyState}\n` +
          `  networkState: ${video.networkState}`
      )
      // seek 超时或 video.error 视为不可恢复错误，需要上层 forceReload
      return { success: false, message, needReload: true }
    } finally {
      this.ctx.seeking = false
    }
  }

  /** 清理所有资源：销毁 DashAdapter（含 dash.js 实例）+ revoke 所有 Blob URL */
  cleanup(): void {
    const { ctx } = this
    if (ctx.disposed) return
    ctx.disposed = true
    ctx.attached = false
    // 取消 attach 进行中的网络请求（init segment 预读 / sidx 扫描）
    ctx.attachAbort?.abort()
    ctx.attachAbort = null
    try {
      // DashAdapter.destroy 内部：detach（engine.attachView(null)）+ engine.destroy
      ctx.adapter.destroy()
    } catch {
      /* ignore */
    }
    // revoke MPD 与缓冲模式的媒体 blob URL（重复 revoke 幂等无害）
    for (const url of [ctx.mpdBlobUrl, ...ctx.mediaBlobUrls]) {
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* ignore */
      }
    }
  }

  /** 等待 video seeked 事件（dash.js 完成目标位置数据下载与 append） */
  private waitForSeeked(targetTime: number): Promise<void> {
    const video = this.ctx.video
    const SEEK_TIMEOUT_MS = 30000
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onError)
        reject(new Error(`dash.js seek 到 ${targetTime.toFixed(1)}s 超时`))
      }, SEEK_TIMEOUT_MS)

      const onSeeked = () => {
        clearTimeout(timeout)
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onError)
        resolve()
      }

      const onError = () => {
        clearTimeout(timeout)
        video.removeEventListener('seeked', onSeeked)
        video.removeEventListener('error', onError)
        const err = video.error
        reject(
          new Error(
            `dash.js seek 期间发生错误: ${err ? `code=${err.code} ${err.message}` : '未知错误'}`
          )
        )
      }

      video.addEventListener('seeked', onSeeked, { once: true })
      video.addEventListener('error', onError, { once: true })
    })
  }
}

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

    const isBufferMode = !!(source.videoBlob && source.audioBlob)
    // attach 期间网络请求（init segment 预读 / sidx 二次扫描）的统一取消器
    const attachAbort = new AbortController()

    // ===== 1. MPD 构建层(自研)：头部预读 + 虚拟 MPD =====
    const initInfo = isBufferMode
      ? // 缓冲模式：从本地 Blob slice 读取头部，零网络请求
        await parseInitFromBlob(source.videoBlob, source.duration)
      : // 流模式：通过服务器代理预下载头部
        await preloadInitSegment(source.url, {
          duration: source.duration,
          signal: attachAbort.signal,
        })

    // BaseURL：缓冲模式用本地 blob URL（零网络流量，URL 过期不影响播放）；
    // 流模式统一走代理（有防盗链 + 无 CORS）
    const mediaBlobUrls: string[] = []
    let videoBaseUrl: string
    let audioBaseUrl: string
    if (isBufferMode) {
      videoBaseUrl = URL.createObjectURL(source.videoBlob)
      audioBaseUrl = URL.createObjectURL(source.audioBlob)
      mediaBlobUrls.push(videoBaseUrl, audioBaseUrl)
    } else {
      videoBaseUrl = resolveProxyUrl(source.url, undefined, 'dash')
      audioBaseUrl = resolveProxyUrl(audioUrl, undefined, 'dash')
    }

    // ⚠️ dash.js 5.2.0 关键兼容修复：MPD 内 BaseURL 必须是绝对 URL。
    // MPD 经 blob: URL 交给 dash.js 时，其内部 URL 解析器用 manifest URL 作
    // base 解析相对 BaseURL——new URL('/api/...', 'blob:...') 抛错后原样返回
    // 相对路径，导致 BaseURLController.resolve() 返回 undefined，
    // getInitRequest 恒为 null，ScheduleController 在 "get init request"
    // 处 500ms 死循环，永不 streamInitialized，最终 metadata 30s 超时。
    // （dash.js 4.7.4 的解析器可容忍 blob base，故旧管线无此问题。）
    // 绝对化后解析不再依赖 manifest URL 本身，blob/HTTP manifest 均可播。
    // blob: / http(s): 等绝对 URL 经 new URL(u, base) 原样透传，幂等无害。
    const absolutizeBaseUrl = (url: string): string => {
      try {
        return new URL(url, window.location.href).href
      } catch {
        return url
      }
    }
    videoBaseUrl = absolutizeBaseUrl(videoBaseUrl)
    audioBaseUrl = absolutizeBaseUrl(audioBaseUrl)

    const mpd = generateMpd({
      videoUrl: videoBaseUrl,
      audioUrl: audioBaseUrl,
      videoCodec: source.videoCodec,
      audioCodec: source.audioCodec,
      duration: source.duration,
      initInfo,
    })
    const mpdBlobUrl = URL.createObjectURL(
      new Blob([mpd], { type: 'application/dash+xml' })
    )

    // ===== 2. 执行层 + 状态层：DashAdapter（dash.js 5.2.0）=====
    // DashAdapter 继承 HTMLVideoAdapter：attach 后既是执行器也是 v10 media
    const adapter = new DashAdapter()
    adapter.attach(video) // 内部：HTMLVideoAdapter.attach(video) + engine.attachView(video)
    const engine = adapter.engine

    // 配置 dash.js（经 engine 逃生舱）：
    // - 禁用 ABR 自动切换（B站 DASH 只有一个 Representation，ABR 无意义）
    // - 启用 fastSwitch（seek 后快速恢复播放）
    // - 缓冲策略与 MSE 引擎 TARGET_BUFFER_AHEAD 对齐；
    //   缓冲模式扩大缓冲至整个视频，dash.js 会从 Blob 读取全部数据
    const bufferAhead = isBufferMode
      ? Math.max(source.duration ?? 600, 600)
      : 30
    engine.updateSettings({
      streaming: {
        buffer: {
          fastSwitchEnabled: true,
          bufferTimeAtTopQuality: bufferAhead,
          bufferTimeAtTopQualityLongForm: bufferAhead,
          bufferToKeep: bufferAhead,
          bufferPruningInterval: 60,
        },
        gaps: {
          enableSeekFix: true,
        },
        abr: {
          autoSwitchBitrate: { video: false, audio: false },
        },
      },
      debug: {
        logLevel: 3, // LOG_LEVEL_WARNING
      },
    })

    // XHR 凭证：B站 CDN URL 经后端 /api/stream/proxy 代理，该接口要求登录态；
    // dash.js 默认 XHR 不带 credentials 会导致 401。
    // CLI 代理场景：URL 是 http://127.0.0.1:xxxx/proxy?url=...（跨域），
    // CLI 不需要 Cookie 认证，且 credentials=true 会触发 CORS 凭证策略冲突。
    // 缓冲模式：BaseURL 是 blob: URL，credentials 设置不影响加载。
    //
    // MPD 排除凭证：MPD 是本地生成的 blob URL（URL.createObjectURL），
    // 无需任何凭证；blob 请求也从不携带 cookie，设 true 无意义。
    // segment 凭证不受影响：BaseURL 是同源代理 URL（同源 XHR 恒带 cookie），
    // token 亦已附加在 URL 查询参数中。
    const useCredentials = !isCliProxyUrl(source.url)
    engine.setXHRWithCredentialsForType('MPD', false)
    engine.setXHRWithCredentialsForType('MediaSegment', useCredentials)
    engine.setXHRWithCredentialsForType('InitializationSegment', useCredentials)
    engine.setXHRWithCredentialsForType('XLink', useCredentials)
    engine.setXHRWithCredentialsForType('mtime', useCredentials)

    const ctx: DashEngineContext = {
      video,
      adapter,
      engine,
      mpdBlobUrl,
      mediaBlobUrls,
      attachAbort,
      lastDashError: null,
      disposed: false,
      attached: false,
      seeking: false,
    }
    const controller = new EngineDashController(ctx)

    // 监听 dash.js 错误事件（dash.js 5.x ERROR 事件 type 即 'error'），
    // 记录详细错误信息用于 seek 失败诊断
    engine.on(
      'error',
      (event: { error?: { code?: string; message?: string } }) => {
        ctx.lastDashError = {
          code: event.error?.code,
          message: event.error?.message,
        }
        console.warn(
          '[videojs10-dash-engine] dash.js ERROR 事件:',
          event.error ?? event
        )
      }
    )

    // attachSource 触发 MPD 加载；startTime 走 dash.js 5.2.0 原生参数，
    // 直接从目标时间开始加载（房主刷新恢复 / 重载按钮保留进度）
    const startTime =
      source.startTime && source.startTime > 0 ? source.startTime : undefined
    engine.attachSource(mpdBlobUrl, startTime)

    // 等待 metadata 加载（video.readyState >= 1），失败统一清理后抛错
    try {
      await waitForMetadata(video)
    } catch (err) {
      controller.cleanup()
      throw new Error('dash.js 加载 DASH 源失败', { cause: err })
    }
    ctx.attached = true
    // 头部队据已读完，释放取消器
    ctx.attachAbort = null

    // ===== 3. v10 状态层：headless store 镜像 =====
    // DashAdapter 即 media（继承 HTMLVideoAdapter），MSE 播放状态经 video
    // 元素事件实时流入 v10 store（数据只向上流）
    const store = createStore()(combine(...videoFeatures))
    store.attach({ media: adapter, container: null })

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
      blobUrl: mpdBlobUrl,
      // 引擎级 seek:透传 EngineDashController(busy 互斥 / seeked 等待 / needReload 诊断)
      player: controller,
      cleanup: () => {
        controller.cleanup()
        try {
          store.destroy()
        } catch {
          // store 已销毁(重复 cleanup)静默跳过
        }
        delete (window as unknown as Record<string, unknown>).__vjs10DashStore
      },
    }
  },
}
