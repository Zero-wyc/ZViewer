/**
 * Kazumi 独立模块 — 类型定义
 *
 * 与前端 modules/kazumi/types.ts 对称。
 * 完全独立于 anime 服务的类型。
 */

/** 媒体容器格式 */
export type KazumiMediaFormat = 'mp4' | 'hls' | 'flv' | 'unknown';

/** 搜索结果 */
export interface KazumiSearchResult {
  id: string;
  title: string;
  cover?: string;
  description?: string;
  source: string;
}

/** 剧集信息 */
export interface KazumiEpisode {
  id: string;
  title: string;
  episodeNumber: number;
  /** 源特定回传参数，透传到 getPlaybackUrl */
  playbackParams: Record<string, unknown>;
}

/** 解析后的播放地址 */
export interface KazumiPlaybackUrl {
  url: string;
  headers?: Record<string, string>;
  format?: KazumiMediaFormat;
}

/** 数据源提供者接口 */
export interface KazumiSourceProvider {
  name: string;
  search(keyword: string): Promise<KazumiSearchResult[]>;
  getEpisodes(identifier: string): Promise<KazumiEpisode[]>;
  getPlaybackUrl(episode: KazumiEpisode): Promise<KazumiPlaybackUrl | null>;
}

/** Kazumi 规则模式（对齐上游 RuleMode：搜索/选集各自独立选择） */
export type KazumiRuleMode = 'xpath' | 'api';

/** Kazumi API 规则请求模板（对齐上游 ApiRequestConfig） */
export interface KazumiApiRequestConfig {
  /** GET | POST，默认 GET */
  method?: unknown;
  /** 请求地址模板，可含 @变量 */
  url?: unknown;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  /** none | json | form，默认 none（仅 POST 时生效） */
  bodyType?: unknown;
  body?: unknown;
}

/** Kazumi API 规则搜索配置（对齐上游 ApiSearchConfig） */
export interface KazumiApiSearchConfig {
  request?: KazumiApiRequestConfig;
  /** 结果列表 JSONPath，默认 $.data[*] */
  listPath?: unknown;
  /** 条目名 JSONPath（相对列表节点），默认 $.name */
  namePath?: unknown;
  /** 条目来源 JSONPath（相对列表节点），默认 $.url */
  sourcePath?: unknown;
  /** 详情页地址模板，@source 替换为来源值（URL 编码）；空=原样保留 */
  sourceTemplate?: unknown;
}

/** 播放页地址模板配置（对齐上游 ApiEpisodePageConfig） */
export interface KazumiApiEpisodePageConfig {
  /** 播放页 URL 模板，变量见上游 @episodeUrl/@roadIndex/@episodeIndex 等 */
  url?: unknown;
  query?: Record<string, unknown>;
}

/** Kazumi API 规则选集配置（对齐上游 ApiChapterConfig） */
export interface KazumiApiChapterConfig {
  request?: KazumiApiRequestConfig;
  /** nested=JSONPath 结构化；delimited=苹果 CMS $$$/#/$ 分隔字符串 */
  format?: unknown;
  roadsPath?: unknown;
  roadNamePath?: unknown;
  episodesPath?: unknown;
  episodeNamePath?: unknown;
  /** 播放入口 URL JSONPath（可为空，此时必须配置 episodePage） */
  episodeUrlPath?: unknown;
  roadNamesPath?: unknown;
  roadEpisodesPath?: unknown;
  roadSeparator?: unknown;
  episodeSeparator?: unknown;
  fieldSeparator?: unknown;
  /** 命名变量捕获：变量名 → 章节 JSON 响应上的 JSONPath */
  variables?: Record<string, unknown>;
  episodePage?: KazumiApiEpisodePageConfig;
}

/** Kazumi 规则 JSON 结构（apiLevel 9：XPath 与 API 双模式，可混搭） */
export interface KazumiRule {
  api?: string;
  type?: string;
  name: string;
  version?: string;
  muliSources?: boolean;
  useWebview?: boolean;
  useNativePlayer?: boolean;
  usePost?: boolean;
  useLegacyParser?: boolean;
  adBlocker?: boolean;
  userAgent?: string;
  referer?: string;
  baseURL: string;
  searchURL: string;
  searchList: string;
  searchName: string;
  searchResult: string;
  chapterRoads: string;
  chapterResult: string;
  /** 搜索模式，默认 xpath */
  searchMode?: unknown;
  /** 选集模式，默认 xpath */
  chapterMode?: unknown;
  searchApiConfig?: KazumiApiSearchConfig;
  chapterApiConfig?: KazumiApiChapterConfig;
}
