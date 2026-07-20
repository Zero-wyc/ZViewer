export interface AnimeSearchResult {
  id: string;
  title: string;
  cover?: string;
  description?: string;
  source: string;
  extra?: Record<string, unknown>;
}

export interface AnimeEpisode {
  id: string;
  title: string;
  episodeNumber: number;
  playbackParams: Record<string, unknown>;
}

/**
 * 媒体容器格式。
 * - mp4：浏览器原生可播放
 * - hls：m3u8 播放列表，Safari 原生支持，其他浏览器需 hls.js
 * - flv：FLV 容器，需 flv.js
 * - dash：MSE 合并（音视频分离），由前端 msePlayer 处理
 * - unknown：未知格式，前端按直链兜底
 */
export type AnimeMediaFormat =
  | 'mp4'
  | 'hls'
  | 'flv'
  | 'dash'
  | 'unknown';

export interface AnimePlaybackUrl {
  url: string;
  headers?: Record<string, string>;
  /** 媒体容器格式，未提供时前端按 URL 后缀推断 */
  format?: AnimeMediaFormat;
  /** DASH 场景下的独立音频流地址 */
  audioUrl?: string;
  /** DASH 场景下的视频编码（如 avc1.640028） */
  videoCodec?: string;
  /** DASH 场景下的音频编码（如 mp4a.40.2） */
  audioCodec?: string;
  /** 时长（秒），可选 */
  duration?: number;
}

export interface AnimeSourceProvider {
  name: string;
  search(keyword: string): Promise<AnimeSearchResult[]>;
  getEpisodes(identifier: string): Promise<AnimeEpisode[]>;
  getPlaybackUrl(episode: AnimeEpisode): Promise<AnimePlaybackUrl | null>;
}
