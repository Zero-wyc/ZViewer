import {
  DanmakuSourceProvider,
  DanmakuSearchResult,
  DanmakuEpisode,
  DanmakuItem,
  DanmakuProviderContext,
} from '../types';
import {
  getVideoInfo,
  searchVideos,
  type BilibiliSearchVideo,
} from '../../bilibili/video';
import { getDanmaku } from '../../bilibili/danmaku';

function extractBvid(input: string): string | null {
  const match = input.match(/BV[0-9A-Za-z]{10}/);
  if (match) return match[0];
  const avMatch = input.match(/av(\d+)/i);
  if (avMatch) return avMatch[1];
  return null;
}

/** 最大并行获取视频统计信息的数量，避免过多并发请求触发风控 */
const MAX_STAT_FETCH = 10;

/**
 * 将搜索结果转换为 DanmakuSearchResult（不含 like/coin，需后续补充）。
 */
function searchVideoToResult(item: BilibiliSearchVideo): DanmakuSearchResult {
  return {
    id: item.bvid,
    title: item.title,
    cover: item.pic,
    description: item.author,
    source: 'bilibili',
    stats: {
      play: item.play,
      danmaku: item.danmaku,
      favorites: item.favorites,
      reply: item.review,
    },
    extra: { bvid: item.bvid, aid: item.aid },
  };
}

export const bilibiliVideoDanmakuProvider: DanmakuSourceProvider = {
  name: '哔哩哔哩视频',

  async search(keyword: string, ctx?: DanmakuProviderContext): Promise<DanmakuSearchResult[]> {
    const cookie = ctx?.cookie;
    const bvid = extractBvid(keyword);

    // BV/av 号：直接获取视频信息（含完整 stat）
    if (bvid) {
      const info = await getVideoInfo(bvid, cookie);
      if (!info) {
        return [];
      }
      return [
        {
          id: info.bvid,
          title: info.title,
          cover: info.pic,
          source: 'bilibili',
          stats: info.stat
            ? {
                play: info.stat.view,
                danmaku: info.stat.danmaku,
                favorites: info.stat.favorite,
                like: info.stat.like,
                coin: info.stat.coin,
                reply: info.stat.reply,
              }
            : undefined,
          extra: { bvid: info.bvid, aid: info.aid },
        },
      ];
    }

    // 普通关键词：调用搜索 API 获取视频列表
    const searchResults = await searchVideos(keyword, cookie);
    if (searchResults.length === 0) {
      return [];
    }

    // 搜索 API 不返回 like/coin，并行调用 view 接口补充统计数据
    // 限制并发数量避免触发风控，超出部分仅使用搜索 API 的基础数据
    const toFetch = searchResults.slice(0, MAX_STAT_FETCH);
    const statResults = await Promise.allSettled(
      toFetch.map((item) => getVideoInfo(item.bvid, cookie)),
    );

    const results: DanmakuSearchResult[] = searchResults.map(
      (item, index) => {
        const base = searchVideoToResult(item);
        if (index < MAX_STAT_FETCH) {
          const statResult = statResults[index];
          if (statResult.status === 'fulfilled' && statResult.value?.stat) {
            const stat = statResult.value.stat;
            base.stats = {
              play: stat.view,
              danmaku: stat.danmaku,
              favorites: stat.favorite,
              like: stat.like,
              coin: stat.coin,
              reply: stat.reply,
            };
          }
        }
        return base;
      },
    );

    return results;
  },

  async getEpisodes(identifier: string, ctx?: DanmakuProviderContext): Promise<DanmakuEpisode[]> {
    const cookie = ctx?.cookie;
    const bvid = extractBvid(identifier);
    if (!bvid) {
      throw new Error('无法解析 BV 号');
    }

    const info = await getVideoInfo(bvid, cookie);
    if (!info) {
      throw new Error('获取视频信息失败');
    }

    if (!info.pages || info.pages.length <= 1) {
      return [
        {
          id: `${info.bvid}-${info.cid}`,
          title: info.title,
          episodeNumber: 1,
          playbackParams: { bvid: info.bvid, cid: info.cid },
        },
      ];
    }

    return info.pages.map((page) => ({
      id: `${info.bvid}-${page.cid}`,
      title: [info.title, page.part].filter(Boolean).join(' - '),
      episodeNumber: page.page,
      playbackParams: { bvid: info.bvid, cid: page.cid },
    }));
  },

  async getDanmaku(episode: DanmakuEpisode, _ctx?: DanmakuProviderContext): Promise<DanmakuItem[]> {
    const cid = episode.playbackParams.cid;
    if (typeof cid !== 'number') {
      throw new Error('缺少 cid 参数');
    }
    const items = await getDanmaku(cid);
    return items.map((item) => ({
      id: item.id,
      content: item.content,
      time: item.time,
      mode: item.mode,
      color: item.color,
      size: item.size,
    }));
  },
};
