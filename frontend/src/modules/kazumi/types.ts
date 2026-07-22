/**
 * Kazumi 前端模块 — 类型定义
 *
 * 与后端 services/kazumi/types.ts 对应。
 * 完全独立于 resolveSource.ts 中的 Anime* 类型。
 */

/** 媒体容器格式 */
export type KazumiMediaFormat = 'mp4' | 'hls' | 'flv' | 'unknown'

/** 数据源信息 */
export interface KazumiSource {
  id: string
  name: string
}

/** 搜索结果 */
export interface KazumiSearchResult {
  id: string
  title: string
  cover?: string
  description?: string
  source: string
}

/** 剧集信息 */
export interface KazumiEpisode {
  id: string
  title: string
  episodeNumber: number
  playbackParams: Record<string, unknown>
}

/** 解析后的播放地址 */
export interface KazumiResolvedSource {
  url: string
  headers?: Record<string, string>
  format?: KazumiMediaFormat
}
