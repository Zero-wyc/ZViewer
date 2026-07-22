/**
 * ani-subs 独立模块 — 类型定义
 *
 * 该模块完全独立于 anime 服务，实现自己的数据源注册、搜索、集数解析与播放地址解析。
 * 通过 routes/anisubs.ts 暴露独立 REST API，前端通过 modules/anisubs/ 客户端调用。
 */

/** 媒体容器格式 */
export type AniSubsMediaFormat = 'mp4' | 'hls' | 'flv' | 'unknown';

/** 搜索结果 */
export interface AniSubsSearchResult {
  id: string;
  title: string;
  cover?: string;
  description?: string;
  source: string;
}

/** 剧集信息 */
export interface AniSubsEpisode {
  id: string;
  title: string;
  episodeNumber: number;
  /** 源特定回传参数，透传到 getPlaybackUrl */
  playbackParams: Record<string, unknown>;
}

/** 解析后的播放地址 */
export interface AniSubsPlaybackUrl {
  url: string;
  headers?: Record<string, string>;
  format?: AniSubsMediaFormat;
}

/** 数据源提供者接口 */
export interface AniSubsSourceProvider {
  name: string;
  search(keyword: string): Promise<AniSubsSearchResult[]>;
  getEpisodes(identifier: string): Promise<AniSubsEpisode[]>;
  getPlaybackUrl(episode: AniSubsEpisode): Promise<AniSubsPlaybackUrl | null>;
}

/** ani-subs 订阅 JSON 根结构 */
export interface AniSubsSubscription {
  exportedMediaSourceDataList?: {
    mediaSources?: AniSubsMediaSource[];
  };
}

/** 订阅中的单个媒体源 */
export interface AniSubsMediaSource {
  factoryId: 'web-selector' | 'rss' | string;
  version?: number;
  arguments: {
    name: string;
    description?: string;
    iconUrl?: string;
    tier?: number;
    searchConfig?: AniSubsSearchConfig;
  };
}

/** web-selector 抓取配置（ani-subs JSON schema 子集） */
export interface AniSubsSearchConfig {
  searchUrl: string;
  searchUseOnlyFirstWord?: boolean;
  searchRemoveSpecial?: boolean;
  searchUseSubjectNamesCount?: number;
  subjectFormatId?: 'a' | 'indexed' | 'json-path-indexed' | string;
  selectorSubjectFormatA?: {
    selectLists: string;
    preferShorterName?: boolean;
  };
  selectorSubjectFormatIndexed?: {
    selectNames: string;
    selectLinks: string;
    preferShorterName?: boolean;
  };
  selectorSubjectFormatJsonPathIndexed?: {
    selectNames: string;
    selectLinks: string;
    preferShorterName?: boolean;
  };
  channelFormatId?: 'index-grouped' | 'no-channel' | string;
  selectorChannelFormatFlattened?: {
    selectChannelNames: string;
    matchChannelName?: string;
    selectEpisodeLists: string;
    selectEpisodesFromList: string;
    selectEpisodeLinksFromList?: string;
    matchEpisodeSortFromName?: string;
  };
  selectorChannelFormatNoChannel?: {
    selectEpisodes: string;
    selectEpisodeLinks?: string;
    matchEpisodeSortFromName?: string;
  };
  defaultResolution?: string;
  defaultSubtitleLanguage?: string;
  filterByEpisodeSort?: boolean;
  filterBySubjectName?: boolean;
  selectMedia?: {
    distinguishSubjectName?: boolean;
    distinguishChannelName?: boolean;
  };
  matchVideo?: {
    enableNestedUrl?: boolean;
    matchNestedUrl?: string;
    matchVideoUrl: string;
    cookies?: string;
    addHeadersToVideo?: {
      referer?: string;
      userAgent?: string;
      origin?: string;
    };
  };
}
