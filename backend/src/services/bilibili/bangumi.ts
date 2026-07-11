import { bilibiliFetch } from './client';

export interface BangumiEpisode {
  bvid: string;
  cid: number;
  title: string;
  index: string | number;
  aid?: number;
}

export interface BangumiSeasonInfo {
  seasonId: number;
  title: string;
  cover?: string;
  description?: string;
  link?: string;
  episodes: BangumiEpisode[];
}

interface BangumiSeasonResult {
  season_id?: number;
  title?: string;
  cover?: string;
  episodes?: unknown[];
  main_section?: { episodes?: unknown[] };
  section?: { episodes?: unknown[] }[];
}

function normalizeImageUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

export async function getBangumiEpisodes(
  seasonId: string,
  cookie?: string,
): Promise<BangumiSeasonInfo> {
  const data = await bilibiliFetch<{ result?: BangumiSeasonResult }>(
    `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId.trim()}`,
    { cookie },
  );

  const result =
    (data as unknown as { result?: BangumiSeasonResult }).result ??
    data.data?.result;

  if (!result) {
    throw new Error('获取番剧信息失败');
  }

  let rawEpisodes: unknown[] = [];
  if (result.episodes && result.episodes.length > 0) {
    rawEpisodes = result.episodes;
  } else if (result.main_section?.episodes && result.main_section.episodes.length > 0) {
    rawEpisodes = result.main_section.episodes;
  } else if (Array.isArray(result.section)) {
    rawEpisodes = result.section.flatMap((s) => s.episodes || []);
  }

  const episodes = rawEpisodes.map((ep: unknown, idx: number) => {
    const item = ep as {
      bvid?: string;
      cid?: number;
      aid?: number;
      title_format?: string;
      long_title?: string;
      title?: string;
      index?: string | number;
    };
    return {
      bvid: item.bvid || '',
      cid: item.cid || 0,
      aid: item.aid,
      title:
        [item.title_format, item.long_title].filter(Boolean).join(' ') ||
        item.long_title ||
        item.title ||
        '',
      index: item.title || item.index || idx + 1,
    };
  });

  return {
    seasonId: Number(result.season_id) || 0,
    title: result.title || '',
    cover: normalizeImageUrl(result.cover || ''),
    episodes,
  };
}

export async function searchBangumi(
  keyword: string,
  cookie?: string,
): Promise<BangumiSeasonInfo[]> {
  const res = await bilibiliFetch<{
    result?: { pages?: number; numResults?: number; result?: unknown[] };
  }>(
    `https://api.bilibili.com/x/web-interface/search/type?keyword=${encodeURIComponent(
      keyword,
    )}&search_type=media_bangumi`,
    { cookie },
  );

  const list = res.data?.result?.result;
  if (!Array.isArray(list)) {
    return [];
  }

  return list.slice(0, 10).map((item: unknown) => {
    const raw = item as {
      season_id?: number | string;
      title?: string;
      cover?: string;
      description?: string;
      media_id?: number | string;
      link?: string;
    };
    const seasonId =
      Number(raw.season_id) ||
      Number(raw.media_id) ||
      0;
    return {
      seasonId,
      title: (raw.title || '').replace(/<[^>]+>/g, ''),
      cover: normalizeImageUrl(raw.cover || ''),
      episodes: [],
      description: raw.description,
      link: raw.link,
    };
  }) as BangumiSeasonInfo[];
}
