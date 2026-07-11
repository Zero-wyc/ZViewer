export interface DanmakuSearchResult {
  id: string;
  title: string;
  cover?: string;
  description?: string;
  source: string;
  extra?: Record<string, unknown>;
}

export interface DanmakuEpisode {
  id: string;
  title: string;
  episodeNumber: number;
  playbackParams: Record<string, unknown>;
}

export interface DanmakuItem {
  id: string;
  content: string;
  time: number;
  mode: number;
  color: number;
  size?: number;
}

export interface DanmakuSourceProvider {
  name: string;
  search(keyword: string): Promise<DanmakuSearchResult[]>;
  getEpisodes(identifier: string): Promise<DanmakuEpisode[]>;
  getDanmaku(episode: DanmakuEpisode): Promise<DanmakuItem[]>;
}
