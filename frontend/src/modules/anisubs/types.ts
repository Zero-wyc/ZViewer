/**
 * ani-subs 前端模块 — 类型定义
 *
 * 与后端 services/anisubs/types.ts 对应。
 * 完全独立于 resolveSource.ts 中的 Anime* 类型。
 */

/** 媒体容器格式 */
export type AniSubsMediaFormat = 'mp4' | 'hls' | 'flv' | 'unknown'

/** 数据源信息 */
export interface AniSubsSource {
  id: string
  name: string
}

/** 搜索结果 */
export interface AniSubsSearchResult {
  id: string
  title: string
  cover?: string
  description?: string
  source: string
  /**
   * 结果来自哪个站点（显示用）。
   *
   * 只有「全部站点」聚合搜索会带：单站点搜索时下拉里已经写明是哪个站了。
   */
  sourceName?: string
  /** 同样命中这个标题的其他站点名（聚合搜索去重后剩下的那些） */
  altSources?: string[]
}

/** 剧集信息 */
export interface AniSubsEpisode {
  id: string
  title: string
  episodeNumber: number
  playbackParams: Record<string, unknown>
}

/** 解析后的播放地址 */
export interface AniSubsResolvedSource {
  url: string
  headers?: Record<string, string>
  format?: AniSubsMediaFormat
}
