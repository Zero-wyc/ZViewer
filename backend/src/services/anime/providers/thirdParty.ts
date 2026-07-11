import {
  AnimeSourceProvider,
  AnimeSearchResult,
  AnimeEpisode,
  AnimePlaybackUrl,
} from '../types';

interface ThirdPartyEndpointConfig {
  searchUrl?: string;
  episodesUrl?: string;
  resolveUrl?: string;
  headers?: Record<string, string>;
  authToken?: string;
}

interface ThirdPartyApiConfig {
  baseUrl?: string;
  endpoints?: ThirdPartyEndpointConfig;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function interpolateUrl(
  template: string,
  params: Record<string, string | number | undefined>,
): string {
  return template.replace(/\{([\w]+)\}/g, (_, key) => {
    const value = params[key];
    return value !== undefined ? encodeURIComponent(String(value)) : '';
  });
}

async function thirdPartyFetch<T>(
  url: string,
  config: ThirdPartyEndpointConfig,
): Promise<T> {
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'application/json',
    ...(config.headers || {}),
  };
  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`第三方数据源请求失败 [${res.status}]: ${url}`);
  }
  return res.json() as Promise<T>;
}

function normalizeSearchResults(
  raw: unknown,
  source: string,
): AnimeSearchResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item: unknown) => {
      const r = item as Record<string, unknown>;
      return {
        id: String(r.id ?? r.animeId ?? r.seasonId ?? ''),
        title: String(r.title ?? r.name ?? ''),
        cover: r.cover ? String(r.cover) : undefined,
        description: r.description ? String(r.description) : undefined,
        source,
        extra:
          r.extra && typeof r.extra === 'object'
            ? (r.extra as Record<string, unknown>)
            : undefined,
      };
    })
    .filter((r) => r.id && r.title);
}

function normalizeEpisodes(raw: unknown): AnimeEpisode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item: unknown, idx: number) => {
      const r = item as Record<string, unknown>;
      const episodeNumber =
        typeof r.episodeNumber === 'number'
          ? r.episodeNumber
          : Number(r.episodeNumber) || idx + 1;
      return {
        id: String(r.id ?? `${idx + 1}`),
        title: String(r.title ?? `第 ${episodeNumber} 集`),
        episodeNumber,
        playbackParams:
          r.playbackParams && typeof r.playbackParams === 'object'
            ? (r.playbackParams as Record<string, unknown>)
            : {},
      };
    })
    .filter((r) => r.id && r.title);
}

export function createThirdPartyAnimeProvider(
  sourceId: string,
  name: string,
  config: ThirdPartyApiConfig,
): AnimeSourceProvider {
  return {
    name,

    async search(keyword: string): Promise<AnimeSearchResult[]> {
      const endpoints = config.endpoints || {};
      const urlTemplate = endpoints.searchUrl || `${config.baseUrl}/search`;
      const url = urlTemplate.includes('{keyword}')
        ? interpolateUrl(urlTemplate, { keyword })
        : `${urlTemplate}?keyword=${encodeURIComponent(keyword)}`;

      const data = await thirdPartyFetch<unknown>(url, endpoints);
      const list =
        data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).data)
          ? (data as Record<string, unknown>).data
          : data;
      return normalizeSearchResults(list, sourceId);
    },

    async getEpisodes(identifier: string): Promise<AnimeEpisode[]> {
      const endpoints = config.endpoints || {};
      const urlTemplate =
        endpoints.episodesUrl || `${config.baseUrl}/episodes/{id}`;
      const url = urlTemplate.includes('{id}')
        ? interpolateUrl(urlTemplate, { id: identifier })
        : `${urlTemplate}?id=${encodeURIComponent(identifier)}`;

      const data = await thirdPartyFetch<unknown>(url, endpoints);
      const list =
        data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).data)
          ? (data as Record<string, unknown>).data
          : data;
      return normalizeEpisodes(list);
    },

    async getPlaybackUrl(episode: AnimeEpisode): Promise<AnimePlaybackUrl | null> {
      const endpoints = config.endpoints || {};
      const urlTemplate =
        endpoints.resolveUrl || `${config.baseUrl}/resolve/{id}`;
      const url = urlTemplate.includes('{id}')
        ? interpolateUrl(urlTemplate, { id: episode.id })
        : `${urlTemplate}?id=${encodeURIComponent(episode.id)}`;

      const data = await thirdPartyFetch<unknown>(url, endpoints);
      if (data && typeof data === 'object') {
        const payload = data as Record<string, unknown>;
        const urlValue = payload.url || payload.playUrl || payload.videoUrl;
        if (typeof urlValue === 'string') {
          return {
            url: urlValue,
            headers:
              payload.headers && typeof payload.headers === 'object'
                ? (payload.headers as Record<string, string>)
                : undefined,
          };
        }
      }
      return null;
    },
  };
}
