import {
  DanmakuSourceProvider,
  DanmakuSearchResult,
  DanmakuEpisode,
  DanmakuItem,
} from '../types';
import { getVideoInfo } from '../../bilibili/video';
import { getDanmaku } from '../../bilibili/danmaku';

function extractBvid(input: string): string | null {
  const match = input.match(/BV[0-9A-Za-z]{10}/);
  if (match) return match[0];
  const avMatch = input.match(/av(\d+)/i);
  if (avMatch) return avMatch[1];
  return null;
}

export const bilibiliVideoDanmakuProvider: DanmakuSourceProvider = {
  name: '哔哩哔哩视频',

  async search(keyword: string): Promise<DanmakuSearchResult[]> {
    const bvid = extractBvid(keyword);
    if (!bvid) {
      return [];
    }

    const info = await getVideoInfo(bvid);
    if (!info) {
      return [];
    }

    return [
      {
        id: info.bvid,
        title: info.title,
        source: 'bilibili',
        extra: { bvid: info.bvid, aid: info.aid },
      },
    ];
  },

  async getEpisodes(identifier: string): Promise<DanmakuEpisode[]> {
    const bvid = extractBvid(identifier);
    if (!bvid) {
      throw new Error('无法解析 BV 号');
    }

    const info = await getVideoInfo(bvid);
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

  async getDanmaku(episode: DanmakuEpisode): Promise<DanmakuItem[]> {
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
