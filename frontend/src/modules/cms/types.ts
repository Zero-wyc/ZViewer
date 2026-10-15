/**
 * CMS 采集源前端模块 — 类型定义
 *
 * 与后端 services/cms/types.ts / routes/cms.ts 对应。
 * 完全独立于 anisubs/kazumi 模块的类型。
 */

/** 媒体容器格式 */
export type CmsMediaFormat = 'mp4' | 'hls' | 'flv' | 'unknown'

/** 采集站点信息（/cms/sources） */
export interface CmsSource {
  id: string
  name: string
}

/** 搜索结果（/cms/search） */
export interface CmsSearchResult {
  /** vodId */
  id: string
  title: string
  cover?: string
  description?: string
  /** 备注（如「更新至第12集」） */
  remark?: string
  source: string
}

/** 聚合搜索结果项（/cms/search-all，跨站点去重后） */
export interface CmsAggregateSearchResult {
  /** 复合 id：`${source}::${vodId}` */
  id: string
  /** 真实站点 key */
  source: string
  siteName: string
  vodId: string
  title: string
  cover?: string
  description?: string
  remark?: string
}

/** 播放组定位参数（/cms/resolve 的 params） */
export interface CmsPlaybackParams {
  vodId: string
  playFromIndex: number
  episodeIndex: number
}

/** 剧集（展平自播放组，id 编码组/集定位） */
export interface CmsEpisode {
  /** `${vodId}|${playFromIndex}|${episodeIndex}` */
  id: string
  title: string
  /** 组内序号（0-based，来自后端） */
  index: number
  episodeNumber: number
  playbackParams: CmsPlaybackParams
}

/** 播放组（详情返回） */
export interface CmsPlayGroup {
  name: string
  episodes: CmsEpisode[]
}

/** 影片详情（/cms/detail） */
export interface CmsVodDetail {
  id: string
  title: string
  cover?: string
  description?: string
  year?: string
  area?: string
  typeName?: string
  remark?: string
  playGroups: CmsPlayGroup[]
  source: string
}

/** 解析后的播放地址（/cms/resolve） */
export interface CmsResolvedSource {
  url: string
  headers?: Record<string, string>
  format?: CmsMediaFormat
}

/**
 * CMS 采集源影片元数据（持久化到 Movie.sourceMeta，与后端 CmsSourceMeta 对齐）。
 * 采集站直链短时效/防盗链，播放时经此实时重解析，不依赖落库 URL。
 */
export interface CmsSourceMeta {
  sourceId: string
  vodId: string
  vodTitle: string
  playFromIndex: number
  episodeIndex: number
  episodeTitle: string
}
