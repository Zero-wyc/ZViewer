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

export interface AnimePlaybackUrl {
  url: string;
  headers?: Record<string, string>;
}

export interface AnimeSourceProvider {
  name: string;
  search(keyword: string): Promise<AnimeSearchResult[]>;
  getEpisodes(identifier: string): Promise<AnimeEpisode[]>;
  getPlaybackUrl(episode: AnimeEpisode): Promise<AnimePlaybackUrl | null>;
}
