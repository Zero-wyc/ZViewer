import {
  AnimeSourceProvider,
  AnimeSearchResult,
  AnimeEpisode,
  AnimePlaybackUrl,
} from '../types';
import { load } from 'cheerio';
import { createRssAnimeProvider } from './rss';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface AniSubsSubscription {
  exportedMediaSourceDataList?: {
    mediaSources?: AniSubsMediaSource[];
  };
}

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

interface EpisodeInfo {
  id: string;
  title: string;
  episodeNumber: number;
  url: string;
}

function toAbsoluteUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function resolveBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

function fetchHtml(url: string, cookies?: string): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  };
  if (cookies) {
    headers.Cookie = cookies;
  }
  return fetch(url, { headers }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`请求失败 [${res.status}]: ${url}`);
    }
    return res.text();
  });
}

function extractEpisodeNumber(name: string, pattern?: string): number {
  if (!pattern) {
    const m = name.match(/第\s*(\d+(?:\.\d+)?)\s*[话集]/);
    return m ? Number(m[1]) : 0;
  }
  try {
    const re = new RegExp(pattern, 'i');
    const m = name.match(re);
    if (m?.groups?.ep) {
      const n = Number(m.groups.ep);
      return Number.isNaN(n) ? 0 : n;
    }
  } catch {
    // ignore invalid regex
  }
  const fallback = name.match(/(\d+(?:\.\d+)?)/);
  return fallback ? Number(fallback[1]) : 0;
}

function matchChannelName(name: string, pattern?: string): boolean {
  if (!pattern) return true;
  try {
    // ani-subs 的 matchChannelName 支持正则和反向断言；简单处理：以 (?! 开头视为必须不匹配
    if (pattern.startsWith('(?!')) {
      const end = pattern.indexOf(')');
      const inner = pattern.slice(3, end);
      const rest = pattern.slice(end + 1);
      if (new RegExp(inner, 'i').test(name)) return false;
      if (!rest) return true;
      return new RegExp(rest, 'i').test(name);
    }
    return new RegExp(pattern, 'i').test(name);
  } catch {
    return true;
  }
}

function findVideoUrl(
  html: string,
  config: NonNullable<AniSubsSearchConfig['matchVideo']>,
  pageUrl: string,
): { url: string; headers?: Record<string, string> } | null {
  const regex = new RegExp(config.matchVideoUrl, 'gi');
  const match = regex.exec(html);
  if (!match) return null;

  let url = match.groups?.v || match[0];
  if (!url) return null;

  // 处理 url=xxx 形式的捕获
  if (url.startsWith('url=')) {
    url = url.slice(4);
  }
  url = toAbsoluteUrl(decodeURIComponent(url), pageUrl);

  const headers: Record<string, string> = {};
  if (config.addHeadersToVideo?.referer) {
    headers.Referer = config.addHeadersToVideo.referer;
  } else {
    headers.Referer = pageUrl;
  }
  if (config.addHeadersToVideo?.userAgent) {
    headers['User-Agent'] = config.addHeadersToVideo.userAgent;
  }
  if (config.addHeadersToVideo?.origin) {
    headers.Origin = config.addHeadersToVideo.origin;
  }
  return { url, headers };
}

async function resolveVideoUrl(
  episodeUrl: string,
  config: NonNullable<AniSubsSearchConfig['matchVideo']>,
): Promise<{ url: string; headers?: Record<string, string> } | null> {
  const html = await fetchHtml(episodeUrl, config.cookies);
  let result = findVideoUrl(html, config, episodeUrl);
  if (result) return result;

  if (config.enableNestedUrl && config.matchNestedUrl) {
    try {
      const nestedRe = new RegExp(config.matchNestedUrl, 'gi');
      const nestedMatch = nestedRe.exec(html);
      if (nestedMatch?.[0]) {
        const nestedUrl = toAbsoluteUrl(nestedMatch[0], episodeUrl);
        const nestedHtml = await fetchHtml(nestedUrl, config.cookies);
        result = findVideoUrl(nestedHtml, config, nestedUrl);
        if (result) return result;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

type CheerioRoot = ReturnType<typeof load>;
type CheerioInput = Parameters<CheerioRoot>[0];

function asCheerioInput(el: unknown): CheerioInput {
  return el as CheerioInput;
}

function selectSubjectLinksA(
  $: CheerioRoot,
  selector: string,
  baseUrl: string,
): Array<{ title: string; url: string }> {
  const results: Array<{ title: string; url: string }> = [];
  $(selector).each((_idx: number, el: unknown) => {
    const $el = $(asCheerioInput(el));
    const title = $el.text().trim();
    let url = $el.attr('href') || '';
    if (!url && $el.is('img')) {
      const parent = $el.closest('a');
      url = parent.attr('href') || '';
    }
    if (title && url) {
      results.push({ title, url: toAbsoluteUrl(url, baseUrl) });
    }
  });
  return results;
}

function selectSubjectLinksIndexed(
  $: CheerioRoot,
  namesSelector: string,
  linksSelector: string,
  baseUrl: string,
): Array<{ title: string; url: string }> {
  const names: string[] = [];
  $(namesSelector).each((_idx: number, el: unknown) => {
    names.push($(asCheerioInput(el)).text().trim());
  });
  const links: string[] = [];
  $(linksSelector).each((_idx: number, el: unknown) => {
    links.push($(asCheerioInput(el)).attr('href') || '');
  });
  return names
    .map((title, idx) =>
      title && links[idx]
        ? { title, url: toAbsoluteUrl(links[idx], baseUrl) }
        : null,
    )
    .filter(Boolean) as Array<{ title: string; url: string }>;
}

function extractEpisodesIndexGrouped(
  $: CheerioRoot,
  channelConfig: NonNullable<AniSubsSearchConfig['selectorChannelFormatFlattened']>,
  baseUrl: string,
): EpisodeInfo[] {
  const episodes: EpisodeInfo[] = [];
  const channelNames: string[] = [];

  $(channelConfig.selectChannelNames).each((_idx: number, el: unknown) => {
    channelNames.push($(asCheerioInput(el)).text().trim());
  });

  const episodeLists = $(channelConfig.selectEpisodeLists);
  episodeLists.each((listIdx: number, listEl: unknown) => {
    const channelName = channelNames[listIdx] || '';
    if (!matchChannelName(channelName, channelConfig.matchChannelName)) {
      return;
    }

    $(asCheerioInput(listEl))
      .find(channelConfig.selectEpisodesFromList)
      .each((_idx: number, epEl: unknown) => {
        const $ep = $(asCheerioInput(epEl));
        const title = $ep.text().trim();
        let url = $ep.attr('href') || '';
        if (!url && channelConfig.selectEpisodeLinksFromList) {
          url = $ep.find(channelConfig.selectEpisodeLinksFromList).attr('href') || '';
        }
        if (!title || !url) return;

        const episodeNumber = extractEpisodeNumber(
          title,
          channelConfig.matchEpisodeSortFromName,
        );
        episodes.push({
          id: `${channelName}-${title}-${episodeNumber}`,
          title: channelName ? `[${channelName}] ${title}` : title,
          episodeNumber,
          url: toAbsoluteUrl(url, baseUrl),
        });
      });
  });

  return episodes;
}

function extractEpisodesNoChannel(
  $: CheerioRoot,
  config: NonNullable<AniSubsSearchConfig['selectorChannelFormatNoChannel']>,
  baseUrl: string,
): EpisodeInfo[] {
  const episodes: EpisodeInfo[] = [];
  $(config.selectEpisodes).each((_idx: number, el: unknown) => {
    const $ep = $(asCheerioInput(el));
    const title = $ep.text().trim();
    let url = $ep.attr('href') || '';
    if (!url && config.selectEpisodeLinks) {
      url = $ep.find(config.selectEpisodeLinks).attr('href') || '';
    }
    if (!title || !url) return;
    const episodeNumber = extractEpisodeNumber(
      title,
      config.matchEpisodeSortFromName,
    );
    episodes.push({
      id: `${title}-${episodeNumber}`,
      title,
      episodeNumber,
      url: toAbsoluteUrl(url, baseUrl),
    });
  });
  return episodes;
}

export function createAniSubsWebSelectorProvider(
  sourceId: string,
  displayName: string,
  config: AniSubsSearchConfig,
): AnimeSourceProvider {
  return {
    name: displayName,

    async search(keyword: string): Promise<AnimeSearchResult[]> {
      const searchUrl = config.searchUrl.replace(
        /\{keyword\}/g,
        encodeURIComponent(keyword),
      );
      const html = await fetchHtml(searchUrl, config.matchVideo?.cookies);
      const $ = load(html);
      const baseUrl = resolveBaseUrl(searchUrl);

      let subjects: Array<{ title: string; url: string }> = [];
      const formatId = config.subjectFormatId || 'a';

      if (formatId === 'a' && config.selectorSubjectFormatA) {
        subjects = selectSubjectLinksA(
          $,
          config.selectorSubjectFormatA.selectLists,
          baseUrl,
        );
      } else if (
        formatId === 'indexed' &&
        config.selectorSubjectFormatIndexed
      ) {
        subjects = selectSubjectLinksIndexed(
          $,
          config.selectorSubjectFormatIndexed.selectNames,
          config.selectorSubjectFormatIndexed.selectLinks,
          baseUrl,
        );
      }

      // 去重并限制数量
      const seen = new Set<string>();
      return subjects
        .filter((s) => {
          if (seen.has(s.url)) return false;
          seen.add(s.url);
          return true;
        })
        .slice(0, 20)
        .map((s) => ({
          id: s.url,
          title: s.title,
          source: sourceId,
          extra: { subjectUrl: s.url },
        }));
    },

    async getEpisodes(identifier: string): Promise<AnimeEpisode[]> {
      const subjectUrl = identifier;
      const html = await fetchHtml(subjectUrl, config.matchVideo?.cookies);
      const $ = load(html);
      const baseUrl = resolveBaseUrl(subjectUrl);

      let infos: EpisodeInfo[] = [];
      const channelFormatId = config.channelFormatId || 'no-channel';

      if (
        channelFormatId === 'index-grouped' &&
        config.selectorChannelFormatFlattened
      ) {
        infos = extractEpisodesIndexGrouped(
          $,
          config.selectorChannelFormatFlattened,
          baseUrl,
        );
      } else if (
        channelFormatId === 'no-channel' &&
        config.selectorChannelFormatNoChannel
      ) {
        infos = extractEpisodesNoChannel(
          $,
          config.selectorChannelFormatNoChannel,
          baseUrl,
        );
      }

      return infos.map((info) => ({
        id: info.id,
        title: info.title,
        episodeNumber: info.episodeNumber || 1,
        playbackParams: { episodeUrl: info.url },
      }));
    },

    async getPlaybackUrl(
      episode: AnimeEpisode,
    ): Promise<AnimePlaybackUrl | null> {
      const episodeUrl = episode.playbackParams.episodeUrl;
      if (typeof episodeUrl !== 'string' || !episodeUrl) {
        throw new Error('缺少剧集页面地址');
      }
      if (!config.matchVideo) {
        throw new Error('数据源未配置视频匹配规则');
      }
      const result = await resolveVideoUrl(episodeUrl, config.matchVideo);
      if (!result) {
        return null;
      }
      return {
        url: result.url,
        headers: result.headers,
      };
    },
  };
}

export async function fetchAniSubsSubscription(
  url: string,
): Promise<AniSubsSubscription> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`获取 ani-subs 订阅失败 [${res.status}]: ${url}`);
  }
  return res.json() as Promise<AniSubsSubscription>;
}

export function buildAniSubsProvidersFromSubscription(
  subscription: AniSubsSubscription,
): Record<string, AnimeSourceProvider> {
  const providers: Record<string, AnimeSourceProvider> = {};
  const sources = subscription.exportedMediaSourceDataList?.mediaSources || [];

  for (const source of sources) {
    const name = source.arguments.name;
    const safeId = name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '');
    const id = `ani_subs_${source.factoryId}_${safeId}`;

    if (source.factoryId === 'rss' && source.arguments.searchConfig) {
      const searchUrl = source.arguments.searchConfig.searchUrl;
      if (searchUrl) {
        providers[id] = createRssAnimeProvider(id, name, { url: searchUrl });
      }
    } else if (source.factoryId === 'web-selector' && source.arguments.searchConfig) {
      providers[id] = createAniSubsWebSelectorProvider(
        id,
        name,
        source.arguments.searchConfig,
      );
    }
  }

  return providers;
}
