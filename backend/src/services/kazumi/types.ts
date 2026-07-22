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

/** Kazumi 规则 JSON 结构 */
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
}
