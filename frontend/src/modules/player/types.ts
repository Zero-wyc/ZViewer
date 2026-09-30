/**
 * 播放器模块类型定义（v2 重写，接口契约保持不变）。
 *
 * 定义播放器引擎统一接口与源数据结构，使 DASH / HLS / FLV / Direct 四种引擎
 * 在同一抽象下被 usePlayerSource 统一调度。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

/** 引擎类型标识（videojs10 = Video.js 10 试点引擎，见 engines/videojs10-engine.ts；
 *  videojs10-dash = DASH 引擎（自研 MPD 构建 + v10 状态层 + dash.js 5.2.0 执行层），
 *  见 engines/videojs10-dash-engine.ts） */
export type EngineType =
  'hls' | 'flv' | 'direct' | 'playsvideo' | 'videojs10' | 'videojs10-dash'

/**
 * seek 操作返回结果（公共类型，供 MSE / DASH 等引擎实现共享）。
 *
 * - success: seek 是否成功执行
 * - needReload: 是否需要上层 forceReload（video.error / InvalidStateError 等不可恢复错误）
 *   false 表示正常 abort（并发操作）/ superseded / 非 MSE 流，不需要 reload
 * - busy: true 表示另一个执行流正在对同一实例 seek（本次未执行）
 * - message: 失败原因（用于日志）
 */
export interface SeekResult {
  success: boolean
  message?: string
  needReload?: boolean
  busy?: boolean
}

/**
 * 引擎控制器接口：DASH 引擎实例的抽象。
 *
 * 使 usePlayerSource 可以用统一的 ref 类型持有 DASH 引擎控制器，
 * seek-service 通过此接口调用 seekTo，无需感知底层引擎实现。
 */
export interface PlayerController {
  /**
   * 创建并挂载媒体源到构造时传入的 video 元素。
   * @param startTime 可选，从该时间附近开始加载（用于房主刷新恢复 / 重载按钮保留进度）
   * @returns blob URL（用于调用方在切换时 revokeObjectURL）
   */
  attach(startTime?: number): Promise<string>
  /**
   * seek 到目标时间。不重建媒体源。
   * @returns SeekResult
   */
  seekTo(targetTime: number): Promise<SeekResult>
  /** 清理所有资源（MediaSource / dash.js 实例 / blob URL） */
  cleanup(): void
  /** 是否已 attach（包括 seeking 状态） */
  readonly isAttached: boolean
  /** 是否正在 seek */
  readonly isSeeking: boolean
}

/**
 * 播放器源数据：从 WatchTogetherState 中抽取的、引擎 attach 所需的最小字段集。
 * 各引擎按需读取字段，未使用的字段忽略。
 */
/**
 * FLV 引擎直播模式运行时事件（由引擎内部 flv.js 实例发出）。
 *
 * 引擎负责重连与生命周期，UI 层只消费事件驱动状态机：
 * - 连接中：onRetrying（或初始 attach 未 resolve）
 * - 播放中：onReady
 * - 失败：onExhausted（重试耗尽）
 * - 已停止：onStreamEnd（推流端停止）
 */
export interface FlvRuntimeEvents {
  /** flv.js ERROR：引擎将按指数退避内部重连，attempt/max 描述当前进度 */
  onRetrying?: (attempt: number, max: number) => void
  /** 流可用（MEDIA_INFO / loadedmetadata），重连成功计数复位 */
  onReady?: () => void
  /** 指数退避重连耗尽后的最终失败 */
  onExhausted?: (message: string) => void
  /** 推流端停止（直播流不应触发 LOADING_COMPLETE，触发即流结束） */
  onStreamEnd?: () => void
  /**
   * 网络层统计（flv.js STATISTICS_INFO，约每秒一次）。
   * fps 不在此提供：由消费方按 decodedFrames 差值计算。
   */
  onStatistics?: (info: {
    speed: number
    decodedFrames: number
    droppedFrames: number
  }) => void
}

export interface PlayerSource {
  /** 视频流 URL（MSE 引擎下为视频 m4s 片段 URL；其他引擎为完整媒体 URL） */
  url: string
  /** DASH 音频流 URL（仅 MSE 引擎使用） */
  audioUrl?: string
  /** 媒体容器格式（用于引擎选择与格式预检） */
  format?: MediaFormat
  /** 视频编码（仅 MSE 引擎用于构造 MIME） */
  videoCodec?: string
  /** 音频编码（仅 MSE 引擎用于构造 MIME） */
  audioCodec?: string
  /** 防盗链 headers（由后端 resolve 返回，走代理时使用） */
  headers?: Record<string, string>
  /**
   * 直播流标记：FLV 引擎据此启用 isLive 模式（延迟追赶、已播放
   * SourceBuffer 自动清理、内部指数退避重连）。
   */
  isLive?: boolean
  /**
   * FLV 直播运行时事件出口（仅 FLV 引擎 isLive 源使用）。
   *
   * 引擎内部 flv.js 实例的网络层事件经此上报，供 UI 层驱动连接
   * 状态机（connecting/playing/error/stopped）与统计展示。
   */
  flvRuntimeEvents?: FlvRuntimeEvents
  /**
   * 从特定时间附近开始加载（仅 MSE 引擎使用）。
   *
   * 用于 seek 到 SourceBuffer 中已清理的位置时，通过 Range 请求从目标位置附近
   * 开始下载，避免从头下载导致的数十秒等待。MSE 引擎会先下载 init segment，
   * 然后通过估算的字节偏移从目标位置附近开始下载媒体分片。
   */
  startTime?: number
  /**
   * 媒体总时长（秒，仅 MSE 引擎使用）。
   *
   * 来自后端 resolve 接口返回的视频元数据（如 B站 view API 的 duration 字段），
   * 用于显式设置 MediaSource.duration。
   *
   * B站 fMP4 流的 mvhd.duration 通常为 0（整体 duration 在 moof 的 tfdt 中累积），
   * 浏览器从 mvhd 推断的 video.duration 不可靠（0 或仅覆盖已缓冲区间），
   * 导致控制栏时间显示错误、进度条比例失真、seek 行为异常。
   * 此处用后端权威值覆盖，确保 video.duration 反映真实视频时长。
   */
  duration?: number
  /**
   * 视频流 Blob（缓冲模式专用，仅 DASH 引擎使用）。
   *
   * 传入时 dash.js 用本地 blob URL 加载，跳过服务器代理：
   * - 零网络流量，URL 过期不影响播放
   * - seek 直接从内存读取，无延迟
   * - 与 audioBlob 必须同时传入或同时缺失
   */
  videoBlob?: Blob
  /**
   * 音频流 Blob（缓冲模式专用，仅 DASH 引擎使用）。
   * 与 videoBlob 配对使用。
   */
  audioBlob?: Blob
  /**
   * 影片级浏览器播放引擎（playsvideo）开关（添加影片时设置）。
   * - true（默认）：允许 playsvideo 管线
   * - false：强制原生直连播放，**唯一门控**（原生失败不回退管线，
   *   playsvideo 失败也不降级原生）
   */
  playsvideoEnabled?: boolean
  /**
   * 挂载直链模式（movie.directLink）：直连失败时**不回退服务器代理**，
   * 直接把错误抛给调用方提示用户。
   * 直链模式的设计意图是源站直传（服务器零媒体流量），静默转代理
   * 会让服务器带宽悄悄跑满，且掩盖了源站/直链本身的问题。
   */
  noProxyFallback?: boolean
}

/**
 * 引擎 attach 结果：包含资源清理函数与可选的 blob URL。
 */
export interface EngineAttachResult {
  /** 清理函数：卸载引擎资源（hls.js / flv.js 实例、MSE controller、dash.js 实例等） */
  cleanup: () => void
  /** 引擎创建的 blob URL（需由调用方在切换时 revokeObjectURL） */
  blobUrl?: string
  /**
   * 引擎控制器实例（DASH 引擎返回，供外部调用 seekTo）。
   * 使用 PlayerController 接口抽象，usePlayerSource 无需感知底层引擎实现。
   */
  player?: PlayerController
}

/**
 * 播放器引擎统一接口。
 *
 * 各引擎实现此接口，通过 `attach` 将媒体源挂载到 `<video>` 元素，
 * 返回清理 handle。引擎选择逻辑由 `selectEngine(source)` 统一处理。
 */
export interface PlayerEngine {
  readonly type: EngineType
  /**
   * 将媒体源挂载到 video 元素。
   * 实现内部负责 resetVideoElement、设置 src、加载流等全部操作。
   * 返回 Promise 在媒体 metadata 就绪后 resolve（readyState >= 1），
   * 使调用方可安全设置 currentTime。
   */
  attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult>
}
