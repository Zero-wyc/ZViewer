import {
  DanmakuSourceProvider,
  DanmakuSearchResult,
  DanmakuEpisode,
  DanmakuItem,
} from '../types';

const API_BASE = 'https://api.dandanplay.net/api/v2';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface DandanplaySearchResult {
  animeId: number;
  animeTitle: string;
  imageUrl?: string;
  type?: string;
  typeDescription?: string;
  episodes?: number;
  started?: string;
}

interface DandanplayEpisode {
  episodeId: number;
  episodeTitle: string;
  episodeNumber?: number | string;
}

interface DandanplayBangumiDetail {
  animeId?: number;
  animeTitle?: string;
  imageUrl?: string;
  episodes?: DandanplayEpisode[];
}

interface DandanplayComment {
  cid?: number | string;
  p?: string;
  m?: string;
}

async function dandanFetch<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const query = params
    ? `?${new URLSearchParams(params).toString()}`
    : '';
  const url = `${API_BASE}${path}${query}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`弹弹 play API 请求失败 [${res.status}]: ${url}`);
  }

  return res.json() as Promise<T>;
}

function parseCommentParams(p: string): {
  time: number;
  mode: number;
  size: number;
  color: number;
} {
  const parts = p.split(',');
  return {
    time: parseFloat(parts[0] || '0'),
    mode: parseInt(parts[1] || '1', 10),
    size: parseInt(parts[2] || '25', 10),
    color: parseInt(parts[3] || '16777215', 10),
  };
}

export const dandanplayDanmakuProvider: DanmakuSourceProvider = {
  name: '弹弹 play',

  async search(keyword: string): Promise<DanmakuSearchResult[]> {
    interface SearchResponse {
      success?: boolean;
      errorMessage?: string;
      animes?: DandanplaySearchResult[];
    }

    const data = await dandanFetch<SearchResponse>('/search/anime', {
      keyword,
    });

    if (!data.success) {
      throw new Error(data.errorMessage || '弹弹 play 搜索失败');
    }

    const list = Array.isArray(data.animes) ? data.animes : [];
    return list.slice(0, 20).map((item) => ({
      id: String(item.animeId),
      title: item.animeTitle,
      cover: item.imageUrl,
      description: [item.typeDescription, item.started]
        .filter(Boolean)
        .join(' / '),
      source: 'dandanplay',
      extra: { animeId: item.animeId },
    }));
  },

  async getEpisodes(identifier: string): Promise<DanmakuEpisode[]> {
    const animeId = Number(identifier.replace(/\D/g, ''));
    if (!Number.isFinite(animeId) || animeId <= 0) {
      throw new Error('无法解析弹弹 play animeId');
    }

    interface BangumiResponse {
      success?: boolean;
      errorMessage?: string;
      bangumi?: DandanplayBangumiDetail;
    }

    const data = await dandanFetch<BangumiResponse>(`/bangumi/${animeId}`);
    if (!data.success) {
      throw new Error(data.errorMessage || '弹弹 play 获取番剧详情失败');
    }

    const episodes = data.bangumi?.episodes || [];
    if (!episodes.length) {
      return [
        {
          id: `${animeId}-1`,
          title: data.bangumi?.animeTitle || '第 1 集',
          episodeNumber: 1,
          playbackParams: { animeId },
        },
      ];
    }

    return episodes.map((ep, idx) => ({
      id: `${animeId}-${ep.episodeId}`,
      title: [data.bangumi?.animeTitle, ep.episodeTitle]
        .filter(Boolean)
        .join(' - '),
      episodeNumber:
        typeof ep.episodeNumber === 'number'
          ? ep.episodeNumber
          : Number(ep.episodeNumber) || idx + 1,
      playbackParams: { animeId, episodeId: ep.episodeId },
    }));
  },

  async getDanmaku(episode: DanmakuEpisode): Promise<DanmakuItem[]> {
    const episodeId = episode.playbackParams.episodeId;
    if (typeof episodeId !== 'number' || episodeId <= 0) {
      throw new Error('缺少有效的弹弹 play episodeId');
    }

    interface CommentResponse {
      count?: number;
      comments?: DandanplayComment[];
    }

    const data = await dandanFetch<CommentResponse>(
      `/comment/${episodeId}`,
      { withRelated: 'true', chConvert: '0' },
    );

    const comments = Array.isArray(data.comments) ? data.comments : [];
    return comments
      .filter((c) => typeof c.m === 'string' && c.m.trim())
      .map((c) => {
        const params = parseCommentParams(c.p || '0,1,25,16777215');
        return {
          id: String(c.cid ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          content: c.m as string,
          time: params.time,
          mode: params.mode,
          color: params.color,
          size: params.size,
        };
      });
  },
};
