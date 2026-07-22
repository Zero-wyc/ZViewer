/**
 * 播放器模块类型定义
 *
 * 定义播放器引擎统一接口与源数据结构，使 MSE / HLS / FLV / Direct 四种引擎
 * 在同一抽象下被 usePlayerSource 统一调度。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

/** 引擎类型标识 */
export type EngineType = 'mse' | 'hls' | 'flv' | 'direct'

/**
 * 播放器源数据：从 WatchTogetherState 中抽取的、引擎 attach 所需的最小字段集。
 * 各引擎按需读取字段，未使用的字段忽略。
 */
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
   * 从特定时间附近开始加载（仅 MSE 引擎使用）。
   *
   * 用于 seek 到 SourceBuffer 中已清理的位置时，通过 Range 请求从目标位置附近
   * 开始下载，避免从头下载导致的数十秒等待。MSE 引擎会先下载 init segment，
   * 然后通过估算的字节偏移从目标位置附近开始下载媒体分片。
   */
  startTime?: number
}

/**
 * 引擎 attach 结果：包含资源清理函数与可选的 blob URL。
 */
export interface EngineAttachResult {
  /** 清理函数：卸载引擎资源（hls.js / flv.js 实例、MSE controller 等） */
  cleanup: () => void
  /** MSE 引擎创建的 blob URL（需由调用方在切换时 revokeObjectURL） */
  blobUrl?: string
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
