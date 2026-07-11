import {
  AnimeSourceProvider,
  AnimeSearchResult,
  AnimeEpisode,
  AnimePlaybackUrl,
} from '../types';
import { getBangumiEpisodes, searchBangumi } from '../../bilibili/bangumi';

function extractSeasonId(input: string): string | null {
  const ssMatch = input.match(/ss(\d+)/i);
  if (ssMatch) return ssMatch[1];
  const epMatch = input.match(/ep(\d+)/i);
  if (epMatch) return epMatch[1];
  const raw = input.match(/\d+/);
  if (raw) return raw[0];
  return null;
}

export const bilibiliBangumiAnimeProvider: AnimeSourceProvider = {
  name: '哔哩哔哩番剧',

  async search(keyword: string): Promise<AnimeSearchResult[]> {
    const directSeasonId = extractSeasonId(keyword);
    if (directSeasonId && /^\d+$/.test(directSeasonId)) {
      try {
        const season = await getBangumiEpisodes(directSeasonId);
        if (season.seasonId) {
          return [
            {
              id: String(season.seasonId),
              title: season.title,
              cover: season.cover,
              source: 'bilibili_bangumi',
              extra: { seasonId: season.seasonId },
            },
          ];
        }
      } catch (err) {
        console.warn('[anime:bilibiliBangumi] 直接解析 seasonId 失败:', err);
      }
    }

    const results = await searchBangumi(keyword);
    return results
      .filter((r) => r.seasonId)
      .map((r) => ({
        id: String(r.seasonId),
        title: r.title,
        cover: r.cover,
        description: r.description,
        source: 'bilibili_bangumi',
        extra: { seasonId: r.seasonId },
      }));
  },

  async getEpisodes(identifier: string): Promise<AnimeEpisode[]> {
    const seasonId = extractSeasonId(identifier);
    if (!seasonId) {
      throw new Error('无法解析番剧 ID');
    }

    const season = await getBangumiEpisodes(seasonId);
    if (!season.episodes.length) {
      return [
        {
          id: `${season.seasonId}-1`,
          title: season.title,
          episodeNumber: 1,
          playbackParams: { seasonId: season.seasonId },
        },
      ];
    }

    return season.episodes.map((ep, idx) => ({
      id: `${season.seasonId}-${ep.cid || idx + 1}`,
      title: [season.title, ep.title].filter(Boolean).join(' - '),
      episodeNumber:
        typeof ep.index === 'number'
          ? ep.index
          : Number(ep.index) || idx + 1,
      playbackParams: {
        seasonId: season.seasonId,
        bvid: ep.bvid,
        cid: ep.cid,
        aid: ep.aid,
      },
    }));
  },

  async getPlaybackUrl(episode: AnimeEpisode): Promise<AnimePlaybackUrl | null> {
    const bvid = episode.playbackParams.bvid;
    const cid = episode.playbackParams.cid;
    if (typeof bvid !== 'string' || typeof cid !== 'number' || cid <= 0) {
      throw new Error('缺少有效的 B站 BV/CID 参数');
    }
    // 返回 /api/stream/resolve-bilibili 的代理播放地址
    const url = `/api/stream/resolve-bilibili?url=${encodeURIComponent(
      `https://www.bilibili.com/video/${bvid}`,
    )}`;
    return {
      url,
      headers: { Referer: 'https://www.bilibili.com' },
    };
  },
};
