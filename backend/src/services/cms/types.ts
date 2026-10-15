/**
 * CMS 采集源模块 — 类型定义
 *
 * 对接苹果 CMS V10 JSON 采集接口（api.php/provide/vod），
 * 源站点来自 TVBox 配置 JSON（sites 中 type === 1 的条目）。
 * 与前端 modules/kazumi/types.ts 的设计对称，完全独立于 anime 服务的类型。
 */

/** 媒体容器格式 */
export type CmsMediaFormat = 'mp4' | 'hls' | 'flv' | 'unknown';

/** 采集站点（来自 TVBox 配置的 type 1 源） */
export interface CmsSite {
  /** 注册表唯一键（cms{配置序号}_{站点key}） */
  key: string;
  /** 显示名（TVBox sites.name） */
  name: string;
  /** CMS JSON API 根地址（如 https://host/api.php/provide/vod） */
  api: string;
  /** 是否支持搜索 */
  searchable: boolean;
}

/** 搜索结果 */
export interface CmsSearchResult {
  /** vod_id */
  id: string;
  title: string;
  cover?: string;
  description?: string;
  /** 备注（如「更新至第12集」「HD」） */
  remark?: string;
  /** 所属站点 key */
  source: string;
}

/** 播放组解析参数（透传到 getPlaybackUrl） */
export interface CmsPlaybackParams {
  vodId: string;
  /** 播放组（vod_play_from 组）序号，默认 0 */
  playFromIndex: number;
  /** 组内集序号（0-based） */
  episodeIndex: number;
}

/** 剧集 */
export interface CmsEpisode {
  index: number;
  title: string;
  playbackParams: CmsPlaybackParams;
}

/** 播放组（对应 vod_play_from / vod_play_url 的 $$$ 分组） */
export interface CmsPlayGroup {
  name: string;
  episodes: CmsEpisode[];
}

/** 影片详情 */
export interface CmsVodDetail {
  id: string;
  title: string;
  cover?: string;
  description?: string;
  year?: string;
  area?: string;
  typeName?: string;
  remark?: string;
  playGroups: CmsPlayGroup[];
  /** 所属站点 key */
  source: string;
}

/** 解析后的播放地址 */
export interface CmsPlaybackUrl {
  url: string;
  headers?: Record<string, string>;
  format?: CmsMediaFormat;
}

/** 单站点数据源提供者接口 */
export interface CmsSourceProvider {
  site: CmsSite;
  search(keyword: string): Promise<CmsSearchResult[]>;
  getDetail(vodId: string): Promise<CmsVodDetail>;
  getPlaybackUrl(
    params: CmsPlaybackParams,
  ): Promise<CmsPlaybackUrl | null>;
}

/** TVBox 配置站点条目（sites 数组元素，字段宽松） */
export interface TvboxSiteEntry {
  key?: unknown;
  name?: unknown;
  type?: unknown;
  api?: unknown;
  searchable?: unknown;
  filterable?: unknown;
  ext?: unknown;
  header?: unknown;
  timeout?: unknown;
}
