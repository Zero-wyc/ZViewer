/**
 * DashPlayer：基于 dash.js 的 DASH 播放器门面。
 *
 * 职责：
 * 1. 将 B站非标准 DASH 流（分离的 video/audio m4s）包装为 dash.js 可识别的 MPD manifest
 * 2. 管理 dash.js MediaPlayer 实例生命周期（显式状态机）
 * 3. 实现 PlayerController 接口，供 usePlayerSource / seek-service 统一调度
 *
 * B站 DASH 源特点：
 * - 非标准 DASH：没有 .mpd manifest，只有分离的 video.m4s + audio.m4s
 * - m4s 是 fragmented MP4（fMP4），包含 ftyp + moov + 多个 moof/mdat
 * - mvhd.duration 为 0（duration 在 moof 的 tfdt 中累积）
 * - 没有 sidx box（无法按 sidx 索引 seek）
 * - B站 CDN 不返回 CORS 头，必须走后端 /api/stream/proxy 代理
 *
 * 解决方案：动态生成虚拟 MPD manifest
 * - type="static" + mediaPresentationDuration（来自后端权威值）
 * - 两个 AdaptationSet（video + audio），每个一个 Representation
 * - BaseURL 指向代理后的 m4s URL
 * - dash.js 会下载 m4s 头部（ftyp + moov），扫描 moof box 构建索引
 *
 * 状态机：idle → attaching → attached ⇄ seeking → disposed
 */
import dashjs from 'dashjs'
import type { MediaPlayerClass } from 'dashjs'
import type { PlayerController, SeekResult } from '../../types'
import { resolveProxyUrl, isCliProxyUrl } from '../../services/url-proxy'
import { findAllSidxInBuffer, findMoovRange } from './mp4-box-parser'
import { useP2PStatsStore } from '../../services/p2p-stats-store'

/** DashPlayer 构造参数 */
export interface DashPlayerOptions {
  video: HTMLVideoElement
  /** 视频流 URL（B站 m4s） */
  videoUrl: string
  /** 音频流 URL（B站 m4s） */
  audioUrl: string
  /** 视频编码（如 'avc1.64001E'），用于 MPD codecs 属性 */
  videoCodec?: string
  /** 音频编码（如 'mp4a.40.2'），用于 MPD codecs 属性 */
  audioCodec?: string
  /**
   * 媒体总时长（秒），来自后端 resolve 接口的权威值。
   * 用于 MPD mediaPresentationDuration，dash.js 据此设置 video.duration。
   */
  duration?: number
  /**
   * 视频流 Blob（缓冲模式专用）。
   *
   * 传入时 DashPlayer 直接生成 blob URL 加载，跳过服务器代理：
   * - 不调用 preloadInitSegment（用本地 Blob slice 解析 sidx）
   * - MPD 中 BaseURL 使用 blob: URL 而非代理 URL
   * - 播放期间零网络流量，URL 过期不影响播放
   */
  videoBlob?: Blob
  /**
   * 音频流 Blob（缓冲模式专用）。
   * 传入时与 videoBlob 同等处理，生成独立 blob URL。
   */
  audioBlob?: Blob
  /**
   * 是否启用 P2P 传输（基于 SwarmCloud）。
   *
   * 启用后 attach 阶段会创建 P2pEngineDash 实例包装 dash.js，房间内其他启用 P2P
   * 的客户端通过 WebRTC DataChannel 共享 m4s 分片，减少服务器代理流量。
   *
   * 仅在流模式生效（isBufferMode=true 时忽略，因视频已完整缓存到本地 Blob）。
   * 各客户端独立启用，SwarmCloud tracker 通过 channelId（取自 videoUrl）匹配 peer。
   */
  p2pEnabled?: boolean
}

type PlayerState = 'idle' | 'attaching' | 'attached' | 'seeking' | 'disposed'

/** metadata 加载超时（30s，与 MSE 引擎一致） */
const METADATA_TIMEOUT_MS = 30000
/** seek 等待超时（30s，dash.js seek 长视频可能较慢） */
const SEEK_TIMEOUT_MS = 30000
/** 预下载 init segment 的最大字节数（用于解析 sidx/moov） */
const INIT_SEGMENT_PRELOAD_BYTES = 256 * 1024 // 256KB
/** 二次扫描 sidx 的最大字节数（用于检测多 sidx 结构） */
const SIDX_SCAN_BYTES = 5 * 1024 * 1024 // 5MB

export interface DashSegmentInfo {
  startTime: number
  duration: number
  byteOffset: number
  byteSize: number
}

export interface DashPlayerInitInfo {
  sidxRange?: string
  moovRange?: string
  initRange?: string
  /** sidx 覆盖的总时长（秒），用于判断 sidx 是否完整 */
  sidxCoverage?: number
  /** 是否找到多个 sidx box */
  sidxCount?: number
  /** 从 sidx 解析出的 segment 列表 */
  segments?: DashSegmentInfo[]
  /** 文件总大小（从 Content-Length 获取） */
  totalSize?: number
  /** init segment 的结束位置（moov 之后） */
  initEnd?: number
}

export class DashPlayer implements PlayerController {
  private readonly video: HTMLVideoElement
  private readonly videoUrl: string
  private readonly audioUrl: string
  private readonly videoCodec?: string
  private readonly audioCodec?: string
  private readonly duration?: number
  /** 缓冲模式：本地 Blob 数据（已从 IndexedDB 读取） */
  private readonly videoBlob?: Blob
  private readonly audioBlob?: Blob
  /** P2P 传输开关（仅在流模式生效，缓冲模式忽略） */
  private readonly p2pEnabled: boolean

  private dashPlayer: MediaPlayerClass | null = null
  private mpdBlobUrl: string | null = null
  /** 缓冲模式：从 Blob 生成的 video/audio blob URL，cleanup 时统一 revoke */
  private videoBlobUrl: string | null = null
  private audioBlobUrl: string | null = null
  private state: PlayerState = 'idle'
  private initInfo: DashPlayerInitInfo = {}
  /** 最近一次 dash.js 错误事件（用于 seek 失败诊断） */
  private lastDashError: {
    code?: string
    message?: string
    raw?: unknown
  } | null = null
  /**
   * SwarmCloud P2P 引擎实例（可选）。
   *
   * 仅在 p2pEnabled=true 且非缓冲模式时创建。包装 dash.js player，
   * 通过 WebRTC DataChannel 与房间内其他客户端共享 m4s 分片。
   * 生命周期与 dash.js 实例一致：attach 时创建，cleanup 时销毁。
   */
  private p2pEngine: { destroy: () => void } | null = null
  /**
   * attach 期间网络请求（init segment 预读 / sidx 二次扫描）的统一取消器。
   * cleanup 时 abort：源切换后不再继续拉取旧源的头部队据（最多 5MB+）。
   */
  private attachAbort: AbortController | null = null

  constructor(options: DashPlayerOptions) {
    this.video = options.video
    this.videoUrl = options.videoUrl
    this.audioUrl = options.audioUrl
    this.videoCodec = options.videoCodec
    this.audioCodec = options.audioCodec
    this.duration = options.duration
    this.videoBlob = options.videoBlob
    this.audioBlob = options.audioBlob
    this.p2pEnabled = options.p2pEnabled === true
  }

  /** 是否启用缓冲模式（传入 Blob 数据时为 true） */
  private get isBufferMode(): boolean {
    return !!(this.videoBlob && this.audioBlob)
  }

  // ── 公开 API ──────────────────────────────────────

  get isAttached(): boolean {
    return this.state === 'attached' || this.state === 'seeking'
  }

  get isSeeking(): boolean {
    return this.state === 'seeking'
  }

  /**
   * 生成 MPD manifest → Blob URL → dash.js 加载。
   * @param startTime 可选，从该时间开始播放（房主刷新恢复 / 重载按钮保留进度）
   * @returns MPD 的 Blob URL（供调用方在切换时 revokeObjectURL）
   */
  async attach(startTime?: number): Promise<string> {
    if (this.state !== 'idle') {
      throw new Error(`DashPlayer 状态不允许 attach: ${this.state}`)
    }
    this.state = 'attaching'
    this.attachAbort = new AbortController()

    /** attach 进行中外部已 cleanup（切源/卸载）→ 抛错终止，由 catch 统一清理 */
    const ensureNotDisposed = () => {
      if (this.state === 'disposed') {
        throw new Error('DashPlayer attach 已被取消（引擎已销毁）')
      }
    }

    try {
      // 1. 预下载/读取视频 m4s 头部，解析 sidx 和 moov 位置
      //    dash.js 需要 sidx 来实现 seek（计算目标时间对应的字节偏移）。
      //    没有 sidx 时，dash.js 无法 seek（只知道顺序下载，不知道跳转位置)。
      if (this.isBufferMode && this.videoBlob) {
        // 缓冲模式：从本地 Blob slice 读取头部，零网络请求
        this.initInfo = await this.parseInitFromBlob(this.videoBlob)
      } else {
        // 流模式：通过服务器代理预下载头部
        this.initInfo = await this.preloadInitSegment(this.videoUrl)
      }
      ensureNotDisposed()

      // 2. 生成 MPD manifest（含 SegmentBase/indexRange，如果解析到 sidx）
      const mpd = this.generateMpd()

      // 3. 包装成 Blob URL
      const blob = new Blob([mpd], { type: 'application/dash+xml' })
      this.mpdBlobUrl = URL.createObjectURL(blob)
      ensureNotDisposed()

      // 4. 创建 dash.js 实例
      const player = dashjs.MediaPlayer().create()
      this.dashPlayer = player
      ensureNotDisposed()

      // 5. 配置 dash.js
      //    - 禁用 ABR 自动切换（B站 DASH 只有一个 Representation，ABR 无意义）
      //    - 启用 fastSwitch（seek 后快速恢复播放）
      //    - 配置缓冲策略（与 MSE 引擎 TARGET_BUFFER_AHEAD 对齐）
      //    缓冲模式：扩大缓冲至整个视频，dash.js 会从 Blob 读取全部数据
      const bufferAhead = this.isBufferMode
        ? Math.max(this.duration ?? 600, 600)
        : 30
      player.updateSettings({
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

      // 5. 让 dash.js 所有 XHR 请求携带凭证（cookie）
      //    B站 CDN URL 经后端 /api/stream/proxy 代理，该接口要求登录态。
      //    dash.js 默认 XHR 不带 credentials，会导致 401 拒绝。
      //    CLI 代理场景：URL 是 http://127.0.0.1:xxxx/proxy?url=...（跨域），
      //    CLI 不需要 Cookie 认证，且 setXHRWithCredentials=true 会导致
      //    CORS 凭证策略冲突（Access-Control-Allow-Origin: * 与 credentials 不兼容），
      //    浏览器拒绝所有视频段请求，视频无法播放。
      //    缓冲模式：BaseURL 是 blob: URL，dash.js 不会发起跨域请求，
      //    credentials 设置不影响 Blob URL 加载，但为保持一致仍启用。
      const useCredentials = !isCliProxyUrl(this.videoUrl)
      player.setXHRWithCredentialsForType('MPD', useCredentials)
      player.setXHRWithCredentialsForType('MediaSegment', useCredentials)
      player.setXHRWithCredentialsForType(
        'InitializationSegment',
        useCredentials
      )
      player.setXHRWithCredentialsForType('XLink', useCredentials)
      player.setXHRWithCredentialsForType('mtime', useCredentials)

      // 6. 初始化 dash.js 并加载 MPD
      //    initialize(view, source, AutoPlay, startTime)
      //    传入 startTime 让 dash.js 直接从该时间开始加载，避免先加载文件头再 seek
      player.initialize(
        this.video,
        this.mpdBlobUrl,
        false,
        startTime && startTime > 0 ? startTime : undefined
      )

      // 6.1 监听 dash.js 错误事件，记录详细错误信息用于 seek 失败诊断
      //     dash.js 在 segment 下载失败、解析错误、CORS 问题时都会触发 ERROR 事件
      player.on(dashjs.MediaPlayer.events.ERROR, (event: unknown) => {
        const e = event as { error?: { code?: string; message?: string } }
        this.lastDashError = {
          code: e.error?.code,
          message: e.error?.message,
          raw: event,
        }
        console.warn('[DashPlayer] dash.js ERROR 事件:', e.error ?? event)
      })

      // 6.2 P2P 引擎集成（仅在流模式 + p2pEnabled 时启用）
      //     缓冲模式下视频已完整缓存到本地 Blob，P2P 无意义且会浪费 WebRTC 资源。
      //     P2pEngineDash 通过替换 dash.js 的 segment loader 实现 P2P 优先下载，
      //     失败自动回退到 HTTP（dash.js 原生 loader）。
      if (this.p2pEnabled && !this.isBufferMode) {
        await this.setupP2P(player)
        ensureNotDisposed()
      }

      // 7. 等待 metadata 加载（video.readyState >= 1）
      await this.waitForMetadata()
      // attach 期间外部已 cleanup：不再置为 attached（避免覆盖 disposed 状态
      // 导致孤儿 dash.js 实例与 blob URL 无法再被清理）
      ensureNotDisposed()

      this.state = 'attached'
      return this.mpdBlobUrl
    } catch (err) {
      this.attachAbort?.abort()
      this.cleanup()
      throw err
    } finally {
      // attach 结束（成功/失败/被取消）统一释放取消器：
      // 成功时头部队据已读完；失败路径 catch 与 cleanup 均已 abort 并置空。
      this.attachAbort = null
    }
  }

  /**
   * 缓冲模式：从本地 Blob 解析 m4s 头部。
   *
   * 与 preloadInitSegment 相比：
   * - 无需网络请求，从 Blob slice 读取前 5MB
   * - 解析 sidx/moov 后立即释放切片，内存占用低
   * - 不会因网络问题失败
   */
  private async parseInitFromBlob(blob: Blob): Promise<DashPlayerInitInfo> {
    const info: DashPlayerInitInfo = {}
    info.totalSize = blob.size

    // 切片前 5MB 解析 sidx/moov（足够覆盖多 sidx 结构）
    const sliceSize = Math.min(SIDX_SCAN_BYTES, blob.size)
    const slice = blob.slice(0, sliceSize)
    const buffer = await slice.arrayBuffer()

    // 解析 moov 范围
    const moovRange = findMoovRange(buffer)
    if (moovRange) {
      info.moovRange = moovRange
      const moovEnd = parseInt(moovRange.split('-')[1], 10)
      info.initRange = `0-${moovEnd}`
      info.initEnd = moovEnd + 1
    }

    // 解析所有 sidx box
    const allSidx = findAllSidxInBuffer(buffer)
    if (allSidx.length > 0) {
      const firstSidx = allSidx[0]
      info.sidxRange = firstSidx.range
      info.sidxCount = allSidx.length

      const sidx = firstSidx.info
      if (sidx && sidx.references.length > 0) {
        const totalDuration =
          sidx.references.reduce((sum, r) => sum + r.subsegmentDuration, 0) /
          sidx.timescale
        info.sidxCoverage = totalDuration

        const segments: DashSegmentInfo[] = []
        let currentTime = sidx.earliestPresentationTime / sidx.timescale
        const sidxEnd = parseInt(firstSidx.range.split('-')[1], 10)
        let byteOffset = sidxEnd + 1 + sidx.firstOffset

        for (const ref of sidx.references) {
          segments.push({
            startTime: currentTime,
            duration: ref.subsegmentDuration / sidx.timescale,
            byteOffset,
            byteSize: ref.referencedSize,
          })
          currentTime += ref.subsegmentDuration / sidx.timescale
          byteOffset += ref.referencedSize
        }
        info.segments = segments

        // sidx 覆盖不足时使用线性估算扩展
        if (this.duration && totalDuration < this.duration - 1) {
          console.warn(
            `[DashPlayer] sidx 覆盖不足 (${totalDuration.toFixed(1)}s < ${this.duration}s)`
          )
          if (
            info.segments &&
            info.sidxCoverage &&
            info.sidxCoverage < this.duration - 1
          ) {
            info.segments = this.extendSegmentsWithLinearEstimation(
              info.segments,
              info.totalSize,
              this.duration
            )
            info.sidxCoverage = this.duration
          }
        }
      }
    } else {
      console.warn(
        '[DashPlayer] 缓冲模式：未找到 sidx box，seek 可能无法正常工作'
      )
    }

    return info
  }

  /**
   * seek 到目标时间。
   *
   * dash.js 的 seek 机制：设置 video.currentTime = x 后，
   * dash.js 内部自动 abort 旧下载、清空 SourceBuffer、按需 Range 重新下载目标位置的 segment。
   * 无需手动管理 SourceBuffer 清理与 init segment 重 append。
   *
   * 等待 seeked 事件后再返回，避免 seek-service 的 isReloadingRef 过早释放
   * 导致后续 seeking 事件触发循环 seek。
   */
  async seekTo(targetTime: number): Promise<SeekResult> {
    if (!this.isAttached) {
      return { success: false, message: 'DashPlayer 未 attach' }
    }
    // 重入保护：上一次 seek 尚未完成（waitForSeeked 中）时拒绝新请求。
    // 否则两个并发 seekTo 的 waitForSeeked 会被同一个 seeked 事件提前 resolve，
    // 且第二个的 currentTime 赋值会打断第一个的下载。
    // 调用方（seek-service）对 busy 结果会记录为 pending 目标，锁释放后接续处理。
    if (this.state === 'seeking') {
      return { success: false, busy: true, message: 'DashPlayer 正在 seek' }
    }

    const prevState = this.state
    this.state = 'seeking'
    // 清空上次错误记录，避免误报
    this.lastDashError = null

    try {
      // 快速路径：目标在已缓冲范围内，直接 seek
      for (let i = 0; i < this.video.buffered.length; i++) {
        if (
          targetTime >= this.video.buffered.start(i) &&
          targetTime <= this.video.buffered.end(i)
        ) {
          this.video.currentTime = targetTime
          this.state = 'attached'
          return { success: true }
        }
      }

      // dash.js 的 seek 由 video.currentTime = x 触发，内部自动处理 Range 请求
      this.video.currentTime = targetTime

      // 等待 seeked 事件（dash.js 完成下载并 append）
      await this.waitForSeeked(targetTime)

      this.state = 'attached'
      return { success: true }
    } catch (err) {
      this.state = prevState
      const message = err instanceof Error ? err.message : 'seek 失败'
      // 输出详细诊断信息：video.error + dash.js 错误事件 + 缓冲状态
      const videoErr = this.video.error
      const buffered =
        this.video.buffered.length > 0
          ? `${this.video.buffered.start(0).toFixed(1)}-${this.video.buffered.end(this.video.buffered.length - 1).toFixed(1)}`
          : '空'
      console.error(
        `[DashPlayer] seek 到 ${targetTime.toFixed(1)}s 失败: ${message}\n` +
          `  video.error: ${videoErr ? `code=${videoErr.code} ${videoErr.message}` : '无'}\n` +
          `  dash.js 错误: ${this.lastDashError ? `${this.lastDashError.code || ''} ${this.lastDashError.message || ''}` : '无'}\n` +
          `  缓冲范围: ${buffered}\n` +
          `  readyState: ${this.video.readyState}\n` +
          `  networkState: ${this.video.networkState}`
      )
      // seek 超时或 video.error 视为不可恢复错误，需要上层 forceReload
      return { success: false, message, needReload: true }
    }
  }

  /** 清理所有资源：销毁 dash.js 实例 + revoke 所有 Blob URL */
  cleanup(): void {
    this.state = 'disposed'
    // 取消 attach 进行中的网络请求（init segment 预读 / sidx 扫描）
    this.attachAbort?.abort()
    this.attachAbort = null
    // 先销毁 P2P 引擎：避免在 dash.js 销毁后还触发 P2P 回调导致异常
    if (this.p2pEngine) {
      try {
        this.p2pEngine.destroy()
      } catch {
        /* ignore */
      }
      this.p2pEngine = null
      // 重置统计 store 并标记引擎不活跃
      useP2PStatsStore.getState().reset()
    }
    if (this.dashPlayer) {
      try {
        this.dashPlayer.destroy()
      } catch {
        /* ignore */
      }
      this.dashPlayer = null
    }
    if (this.mpdBlobUrl) {
      URL.revokeObjectURL(this.mpdBlobUrl)
      this.mpdBlobUrl = null
    }
    // 缓冲模式：释放 video/audio blob URL
    if (this.videoBlobUrl) {
      URL.revokeObjectURL(this.videoBlobUrl)
      this.videoBlobUrl = null
    }
    if (this.audioBlobUrl) {
      URL.revokeObjectURL(this.audioBlobUrl)
      this.audioBlobUrl = null
    }
  }

  /**
   * 创建 SwarmCloud P2P 引擎并包装 dash.js 实例。
   *
   * 实现要点：
   * - 动态 import @swarmcloud/dashjs：避免在禁用 P2P 时加载 WebRTC 相关代码
   * - channelId 使用 videoUrl：所有播放同一视频的客户端 channelId 一致，
   *   SwarmCloud tracker 据此匹配 peer（房主广播的 videoUrl 在所有客户端相同）
   * - 信令地址使用 SwarmCloud 公共服务（main + backup 双通道容灾）
   * - trackerZone 设为 CN（中国大陆节点，与项目主要用户群匹配）
   * - stats 回调写入 zustand store，UI 通过订阅 store 显示实时统计
   *
   * 失败处理：
   * - 浏览器不支持 WebRTC（isSupported()=false）：跳过 P2P，dash.js 自动走 HTTP
   * - 动态 import 失败（网络问题）：警告并跳过，不影响正常播放
   * - P2P 连接失败：SwarmCloud 内部自动回退到 HTTP，无需上层处理
   */
  private async setupP2P(player: MediaPlayerClass): Promise<void> {
    try {
      const P2pEngineDashModule = await import('@swarmcloud/dashjs')
      const P2pEngineDash = P2pEngineDashModule.default
      const { TrackerZone, LogLevel } = P2pEngineDashModule

      if (!P2pEngineDash.isSupported()) {
        console.warn(
          '[DashPlayer] P2P 不被当前浏览器支持（需 WebRTC + MSE），回退到 HTTP'
        )
        return
      }

      // 重置统计 store，标记引擎即将激活
      const statsStore = useP2PStatsStore.getState()
      statsStore.reset()
      statsStore.setEngineActive(true)

      const engine = new P2pEngineDash(player, {
        p2pEnabled: true,
        trackerZone: TrackerZone.CN,
        logLevel: LogLevel.Warn,
        signalConfig: {
          main: 'wss://gz.swarmcloud.net',
          backup: 'wss://signal.cdnbye.com',
        },
        // channelId 取自 videoUrl：房主广播的 videoUrl 在所有客户端相同，
        // SwarmCloud tracker 据此将播放同一视频的客户端分到同一 swarm
        channelId: this.videoUrl,
      })

      engine.on('stats', (stats: unknown) => {
        const s = stats as {
          totalHTTPDownloaded: number
          totalP2PDownloaded: number
          totalP2PUploaded: number
          p2pDownloadSpeed: number
        }
        useP2PStatsStore.getState().updateStats({
          totalHTTPDownloaded: s.totalHTTPDownloaded || 0,
          totalP2PDownloaded: s.totalP2PDownloaded || 0,
          totalP2PUploaded: s.totalP2PUploaded || 0,
          p2pDownloadSpeed: s.p2pDownloadSpeed || 0,
        })
      })

      this.p2pEngine = engine
      console.log(
        `[DashPlayer] P2P 引擎已启用: channelId=${this.videoUrl.substring(0, 80)}...`
      )
    } catch (err) {
      console.warn('[DashPlayer] P2P 引擎初始化失败，回退到 HTTP:', err)
      useP2PStatsStore.getState().reset()
    }
  }

  // ── 内部实现 ──────────────────────────────────────

  /**
   * 预下载 m4s 文件头部，解析 sidx 和 moov 的字节范围。
   *
   * 为什么需要预下载：
   * - B站 m4s 是 fMP4 格式，没有标准 MPD manifest
   * - dash.js 需要 sidx box（segment index）来计算 seek 目标位置的字节偏移
   * - 没有 sidx 时，dash.js 只能顺序播放，seek 会失败（不知道从哪里下载）
   *
   * 预下载策略：
   * 1. 首次下载 256KB，解析 moov 和第一个 sidx
   * 2. 如果 sidx 覆盖时长 < duration，下载 5MB 扫描所有 sidx box
   *    （B站 m4s 可能有多 sidx 结构，每个 sidx 索引一段视频）
   * 3. 输出诊断信息，用于判断 sidx 是否完整
   */
  private async preloadInitSegment(url: string): Promise<DashPlayerInitInfo> {
    // 统一代理策略：DASH m4s 流始终走代理（有防盗链 + 无 CORS）
    const proxyUrl = resolveProxyUrl(url, undefined, 'dash')
    const info: DashPlayerInitInfo = {}
    // CLI 代理是跨域地址，不需要 credentials（Cookie），
    // credentials: 'include' 会导致 CORS 凭证策略冲突
    const credentialsMode: RequestCredentials = isCliProxyUrl(proxyUrl)
      ? 'omit'
      : 'include'

    try {
      // 使用 attach 级取消器：cleanup（切源）时立即中断预读
      const controller = this.attachAbort ?? new AbortController()
      const response = await fetch(proxyUrl, {
        headers: {
          Range: `bytes=0-${INIT_SEGMENT_PRELOAD_BYTES - 1}`,
        },
        credentials: credentialsMode,
        signal: controller.signal,
      })

      if (!response.ok && response.status !== 206) {
        console.warn(
          `[DashPlayer] 预下载 init segment 失败: status=${response.status}`
        )
        return info
      }

      // 从 Content-Range 提取文件总大小
      const contentRange = response.headers.get('Content-Range')
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/)
        if (match) {
          info.totalSize = parseInt(match[1], 10)
        }
      }
      if (!info.totalSize) {
        const contentLength = response.headers.get('Content-Length')
        if (contentLength) {
          info.totalSize = parseInt(contentLength, 10)
        }
      }

      const buffer = await response.arrayBuffer()

      // 解析 moov 范围（用于 init segment 标识）
      const moovRange = findMoovRange(buffer)
      if (moovRange) {
        info.moovRange = moovRange
        const moovEnd = parseInt(moovRange.split('-')[1], 10)
        info.initRange = `0-${moovEnd}`
        info.initEnd = moovEnd + 1
      }

      // 解析所有 sidx box
      const allSidx = findAllSidxInBuffer(buffer)
      if (allSidx.length > 0) {
        const firstSidx = allSidx[0]
        info.sidxRange = firstSidx.range
        info.sidxCount = allSidx.length

        const sidx = firstSidx.info
        if (sidx && sidx.references.length > 0) {
          const totalDuration =
            sidx.references.reduce((sum, r) => sum + r.subsegmentDuration, 0) /
            sidx.timescale
          info.sidxCoverage = totalDuration

          // 构建 segments 列表
          const segments: DashSegmentInfo[] = []
          let currentTime = sidx.earliestPresentationTime / sidx.timescale
          // sidx box 的结束位置 = firstOffset 之前的位置
          // firstOffset 是相对于 sidx box 之后的偏移量
          const sidxEnd = parseInt(firstSidx.range.split('-')[1], 10)
          let byteOffset = sidxEnd + 1 + sidx.firstOffset

          for (const ref of sidx.references) {
            segments.push({
              startTime: currentTime,
              duration: ref.subsegmentDuration / sidx.timescale,
              byteOffset,
              byteSize: ref.referencedSize,
            })
            currentTime += ref.subsegmentDuration / sidx.timescale
            byteOffset += ref.referencedSize
          }
          info.segments = segments

          if (this.duration && totalDuration < this.duration - 1) {
            console.warn(
              `[DashPlayer] sidx 覆盖不足 (${totalDuration.toFixed(1)}s < ${this.duration}s)`
            )

            if (allSidx.length === 1) {
              // 单 sidx：尝试二次扫描更大范围，检测是否有多 sidx 结构
              await this.scanForMoreSidx(proxyUrl, info)
            }

            // 二次扫描后若仍覆盖不足，使用线性估算扩展 segments
            // B站 m4s 的 sidx 通常只索引前若干 segment，剩余部分需按已知 segment 的
            // 平均时长和大小估算，让 dash.js 能 seek 到 sidx 覆盖范围外的位置
            if (
              info.segments &&
              info.sidxCoverage &&
              info.sidxCoverage < this.duration - 1
            ) {
              info.segments = this.extendSegmentsWithLinearEstimation(
                info.segments,
                info.totalSize,
                this.duration
              )
              // 扩展后 sidxCoverage 已等于 duration，避免重复扩展
              info.sidxCoverage = this.duration
            }
          }
        } else {
          // 单 sidx 快速路径（info.segments 已由上方解析填充）
        }
      } else {
        console.warn('[DashPlayer] 未找到 sidx box，seek 可能无法正常工作')
      }

      return info
    } catch (err) {
      console.warn('[DashPlayer] 预下载 init segment 异常:', err)
      return info
    }
  }

  /**
   * 二次扫描：下载更大范围的数据，查找所有 sidx box。
   * 用于检测 B站 m4s 是否有多 sidx 结构。
   */
  private async scanForMoreSidx(
    proxyUrl: string,
    info: DashPlayerInitInfo
  ): Promise<void> {
    try {
      // 使用 attach 级取消器：cleanup（切源）时立即中断 5MB 二次扫描
      const controller = this.attachAbort ?? new AbortController()
      const response = await fetch(proxyUrl, {
        headers: {
          Range: `bytes=0-${SIDX_SCAN_BYTES - 1}`,
        },
        credentials: isCliProxyUrl(proxyUrl) ? 'omit' : 'include',
        signal: controller.signal,
      })

      if (!response.ok && response.status !== 206) {
        console.warn(`[DashPlayer] 二次扫描失败: status=${response.status}`)
        return
      }

      const buffer = await response.arrayBuffer()
      const allSidx = findAllSidxInBuffer(buffer)
      info.sidxCount = allSidx.length

      // 累加每个 sidx 的覆盖时长
      let totalCoverage = 0
      for (let i = 0; i < allSidx.length; i++) {
        const sidx = allSidx[i].info
        if (sidx && sidx.references.length > 0) {
          const duration =
            sidx.references.reduce((sum, r) => sum + r.subsegmentDuration, 0) /
            sidx.timescale
          totalCoverage += duration
        }
      }

      if (totalCoverage > 0) {
        info.sidxCoverage = totalCoverage
      }
    } catch (err) {
      console.warn('[DashPlayer] 二次扫描异常:', err)
    }
  }

  /**
   * 线性估算扩展 segments：当 sidx 覆盖不足时，基于已知 segments 的平均时长和大小
   * 估算剩余 segments，让 dash.js 能 seek 到 sidx 覆盖范围外的位置。
   *
   * 估算策略：
   * - 使用最后 5 个 segment 的平均时长和大小作为估算基准（末尾 segment 更接近未知的剩余部分）
   * - 从最后一个 segment 的字节位置开始，按平均值逐步扩展
   * - 扩展到 duration 或 totalSize（如果已知）
   *
   * 精度说明：
   * - B站 m4s 的 segment 大小通常在 ±20% 范围内波动，估算位置可能略有偏差
   * - dash.js 在 seek 到估算位置后，会从该位置附近的 moof 开始解析
   * - 即使字节位置略有偏差，dash.js 能通过扫描 moof box 找到正确的 segment
   */
  private extendSegmentsWithLinearEstimation(
    segments: DashSegmentInfo[],
    totalSize: number | undefined,
    duration: number | undefined
  ): DashSegmentInfo[] {
    if (segments.length === 0 || !duration) {
      return segments
    }

    const lastSeg = segments[segments.length - 1]
    const coveredDuration = lastSeg.startTime + lastSeg.duration
    const coveredBytes = lastSeg.byteOffset + lastSeg.byteSize

    // 如果 sidx 已覆盖完整，不需要扩展
    if (coveredDuration >= duration - 1) {
      return segments
    }

    // 验证 totalSize 合理性：
    // 后端代理可能未返回 Content-Range 头，导致 totalSize 被错误地设置为
    // 分片大小（如 256KB）而非完整文件大小。如果 totalSize 小于已覆盖字节数，
    // 视为无效，忽略它（仅按 duration 扩展）
    const validTotalSize =
      totalSize && totalSize > coveredBytes + 1024 ? totalSize : undefined

    if (totalSize && !validTotalSize) {
      console.warn(
        `[DashPlayer] totalSize=${totalSize} 小于已覆盖字节 ${coveredBytes}，视为无效，忽略 totalSize`
      )
    }

    // 使用末尾 5 个 segment（或全部，如果不足 5 个）的平均时长和大小
    // 末尾 segment 更接近剩余部分的特征
    const sampleSize = Math.min(5, segments.length)
    const sample = segments.slice(-sampleSize)
    const estDuration =
      sample.reduce((sum, s) => sum + s.duration, 0) / sample.length
    const estSize =
      sample.reduce((sum, s) => sum + s.byteSize, 0) / sample.length

    if (estDuration <= 0 || estSize <= 0) {
      console.warn(
        '[DashPlayer] 线性估算失败: 平均时长或大小为 0',
        `estDuration=${estDuration}, estSize=${estSize}`
      )
      return segments
    }

    const extended: DashSegmentInfo[] = [...segments]
    let currentTime = coveredDuration
    let byteOffset = coveredBytes

    // 扩展到 duration 或 totalSize
    const maxIterations = 5000 // 防止无限循环
    let iter = 0
    let extendedCount = 0

    while (currentTime < duration && iter < maxIterations) {
      // 如果 totalSize 已知且 byteOffset 接近或超过 totalSize，停止
      if (validTotalSize && byteOffset + estSize > validTotalSize) {
        // 最后一个 segment 可能小于平均值，按比例调整
        const remainingBytes = validTotalSize - byteOffset
        if (remainingBytes > 0) {
          const ratio = remainingBytes / estSize
          extended.push({
            startTime: currentTime,
            duration: estDuration * ratio,
            byteOffset,
            byteSize: remainingBytes,
          })
          extendedCount++
        }
        break
      }

      extended.push({
        startTime: currentTime,
        duration: estDuration,
        byteOffset,
        byteSize: estSize,
      })

      currentTime += estDuration
      byteOffset += estSize
      iter++
      extendedCount++
    }

    return extended
  }

  /**
   * 生成虚拟 MPD manifest。
   *
   * 结构：
   * - MPD type="static"，mediaPresentationDuration 来自后端权威值
   * - 单个 Period
   * - 两个 AdaptationSet（video + audio），每个一个 Representation
   *
   * sidx 覆盖判断：
   * - sidx 覆盖完整（sidxCoverage >= duration）：使用 SegmentBase + indexRange，seek 快速准确
   * - sidx 覆盖不足（sidxCoverage < duration）：用线性估算扩展 segments，使用 SegmentList
   *   这样 dash.js 能基于估算的 segment 列表进行 seek，虽然精度略低但能正常跳转
   */
  private generateMpd(): string {
    const duration = this.duration ?? 0
    const durationStr = `PT${duration}S`
    const videoCodec = this.videoCodec || 'avc1.64001E'
    const audioCodec = this.audioCodec || 'mp4a.40.2'
    const sidxRange = this.initInfo.sidxRange
    const segments = this.initInfo.segments
    const initEnd = this.initInfo.initEnd

    // 统一代理策略：DASH m4s 流始终走代理（有防盗链 + 无 CORS）
    // 缓冲模式：使用本地 Blob URL，零网络请求，URL 过期不影响播放
    let videoUrl: string
    let audioUrl: string
    if (this.isBufferMode && this.videoBlob && this.audioBlob) {
      // 生成 blob URL（cleanup 时统一 revoke）
      this.videoBlobUrl = URL.createObjectURL(this.videoBlob)
      this.audioBlobUrl = URL.createObjectURL(this.audioBlob)
      videoUrl = this.videoBlobUrl
      audioUrl = this.audioBlobUrl
    } else {
      videoUrl = resolveProxyUrl(this.videoUrl, undefined, 'dash')
      audioUrl = resolveProxyUrl(this.audioUrl, undefined, 'dash')
    }

    let videoSegmentInfo = ''

    if (segments && segments.length > 0 && initEnd !== undefined) {
      // 使用 SegmentList + SegmentTimeline（支持不等长 segments）
      // SegmentTimeline 指定每个 segment 的精确时长和起始时间，
      // 让 dash.js 能准确计算 seek 目标位置对应的 segment
      const initRange = this.initInfo.initRange || `0-${initEnd - 1}`

      // SegmentTimeline: 第一个 S 需要 t 属性指定起始时间，后续继承
      const timelineEntries = segments
        .map((seg, i) => {
          const d = Math.round(seg.duration * 1000)
          if (i === 0) {
            return `        <S t="${Math.round(seg.startTime * 1000)}" d="${d}" />`
          }
          return `        <S d="${d}" />`
        })
        .join('\n')

      const segmentUrls = segments
        .map(
          (seg) =>
            `      <SegmentURL mediaRange="${seg.byteOffset}-${seg.byteOffset + seg.byteSize - 1}"/>`
        )
        .join('\n')

      videoSegmentInfo = `<SegmentList timescale="1000">
        <Initialization range="${initRange}" />
        <SegmentTimeline>
${timelineEntries}
        </SegmentTimeline>
${segmentUrls}
      </SegmentList>`
    } else if (sidxRange) {
      // fallback: SegmentBase + indexRange
      const sidxStart = parseInt(sidxRange.split('-')[0], 10)
      const initEndForBase = sidxStart - 1
      videoSegmentInfo = `<SegmentBase indexRange="${sidxRange}">
        <Initialization range="0-${initEndForBase}" />
      </SegmentBase>`
    }

    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${durationStr}" minBufferTime="PT1.5S" profiles="urn:mpeg:dash:profile:isoff-main:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="${this.escapeXml(videoCodec)}" contentType="video" startWithSAP="1" segmentAlignment="true">
      <Representation id="v" bandwidth="1000000" codecs="${this.escapeXml(videoCodec)}" mimeType="video/mp4">
        <BaseURL>${this.escapeXml(videoUrl)}</BaseURL>
        ${videoSegmentInfo}
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="${this.escapeXml(audioCodec)}" contentType="audio" startWithSAP="1" segmentAlignment="true">
      <Representation id="a" bandwidth="128000" codecs="${this.escapeXml(audioCodec)}" mimeType="audio/mp4">
        <BaseURL>${this.escapeXml(audioUrl)}</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

    return mpd
  }

  /** XML 特殊字符转义 */
  private escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  /** 等待 video metadata 加载完成（readyState >= 1） */
  private waitForMetadata(): Promise<void> {
    if (this.video.readyState >= 1) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.video.removeEventListener('loadedmetadata', onLoaded)
        this.video.removeEventListener('error', onError)
        reject(new Error('dash.js metadata 加载超时'))
      }, METADATA_TIMEOUT_MS)

      const onLoaded = () => {
        clearTimeout(timeout)
        this.video.removeEventListener('loadedmetadata', onLoaded)
        this.video.removeEventListener('error', onError)
        resolve()
      }

      const onError = () => {
        clearTimeout(timeout)
        this.video.removeEventListener('loadedmetadata', onLoaded)
        this.video.removeEventListener('error', onError)
        const err = this.video.error
        reject(
          new Error(
            `dash.js 加载失败: ${err ? `code=${err.code} ${err.message}` : '未知错误'}`
          )
        )
      }

      this.video.addEventListener('loadedmetadata', onLoaded, { once: true })
      this.video.addEventListener('error', onError, { once: true })
    })
  }

  /** 等待 video seeked 事件（dash.js 完成目标位置数据下载与 append） */
  private waitForSeeked(targetTime: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.video.removeEventListener('seeked', onSeeked)
        this.video.removeEventListener('error', onError)
        reject(new Error(`dash.js seek 到 ${targetTime.toFixed(1)}s 超时`))
      }, SEEK_TIMEOUT_MS)

      const onSeeked = () => {
        clearTimeout(timeout)
        this.video.removeEventListener('seeked', onSeeked)
        this.video.removeEventListener('error', onError)
        resolve()
      }

      const onError = () => {
        clearTimeout(timeout)
        this.video.removeEventListener('seeked', onSeeked)
        this.video.removeEventListener('error', onError)
        const err = this.video.error
        reject(
          new Error(
            `dash.js seek 期间发生错误: ${err ? `code=${err.code} ${err.message}` : '未知错误'}`
          )
        )
      }

      this.video.addEventListener('seeked', onSeeked, { once: true })
      this.video.addEventListener('error', onError, { once: true })
    })
  }
}
