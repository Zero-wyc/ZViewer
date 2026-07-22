import { bilibiliFetch } from './client';
import { getWbiKeys, signParams, clearWbiKeyCache } from './wbi';

export interface BilibiliVideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

/** B站视频统计数据 */
export interface BilibiliVideoStat {
  /** 播放量 */
  view: number;
  /** 弹幕数 */
  danmaku: number;
  /** 评论数 */
  reply: number;
  /** 收藏数 */
  favorite: number;
  /** 投币数 */
  coin: number;
  /** 分享数 */
  share: number;
  /** 点赞数 */
  like: number;
}

export interface BilibiliVideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  /** 视频封面 */
  pic?: string;
  duration: number;
  pages: BilibiliVideoPage[];
  /** 视频统计数据（view/like/coin 等） */
  stat?: BilibiliVideoStat;
}

/** B站搜索结果视频项 */
export interface BilibiliSearchVideo {
  bvid: string;
  aid: number;
  title: string;
  /** 封面图 URL */
  pic: string;
  /** 播放量 */
  play: number;
  /** 弹幕数 */
  danmaku: number;
  /** 收藏数 */
  favorites: number;
  /** 评论数 */
  review: number;
  /** 视频时长（秒） */
  duration: number;
  /** 作者 */
  author: string;
  /** 视频描述 */
  description: string;
}

interface RawVideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

interface RawVideoStat {
  view?: number;
  danmaku?: number;
  reply?: number;
  favorite?: number;
  coin?: number;
  share?: number;
  like?: number;
}

interface RawVideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  pic?: string;
  duration: number;
  pages?: RawVideoPage[];
  stat?: RawVideoStat;
}

interface RawSearchItem {
  bvid: string;
  aid: number;
  title: string;
  pic: string;
  play: number;
  video_review: number;
  favorites: number;
  review: number;
  duration: string;
  author: string;
  description: string;
}

interface RawSearchResponse {
  result?: RawSearchItem[];
}

function buildQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');
}

/**
 * 使用 WBI 签名调用 /x/web-interface/wbi/view 获取视频信息。
 */
async function getVideoInfoWbi(
  bvid: string,
  cookie?: string,
): Promise<BilibiliVideoInfo | null> {
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams({ bvid }, imgKey, subKey);
  const query = buildQueryString(signed);

  const res = await bilibiliFetch<RawVideoInfo>(
    `https://api.bilibili.com/x/web-interface/wbi/view?${query}`,
    { cookie },
  );

  return normalizeVideoInfo(res.data);
}

/**
 * 使用未签名接口 /x/web-interface/view 作为降级方案。
 */
async function getVideoInfoLegacy(
  bvid: string,
  cookie?: string,
): Promise<BilibiliVideoInfo | null> {
  const res = await bilibiliFetch<RawVideoInfo>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    { cookie },
  );

  return normalizeVideoInfo(res.data);
}

function normalizeVideoInfo(data?: RawVideoInfo): BilibiliVideoInfo | null {
  if (!data) return null;
  const stat = data.stat
    ? {
        view: data.stat.view ?? 0,
        danmaku: data.stat.danmaku ?? 0,
        reply: data.stat.reply ?? 0,
        favorite: data.stat.favorite ?? 0,
        coin: data.stat.coin ?? 0,
        share: data.stat.share ?? 0,
        like: data.stat.like ?? 0,
      }
    : undefined;
  return {
    bvid: data.bvid,
    aid: data.aid,
    cid: data.cid,
    title: data.title,
    pic: data.pic,
    duration: data.duration,
    pages: (data.pages || []).map((p) => ({
      cid: p.cid,
      page: p.page,
      part: p.part,
      duration: p.duration,
    })),
    stat,
  };
}

/**
 * 获取 B站 视频信息。
 * 优先使用 WBI 签名接口，失败时自动降级到未签名接口。
 */
export async function getVideoInfo(
  bvid: string,
  cookie?: string,
): Promise<BilibiliVideoInfo | null> {
  try {
    return await getVideoInfoWbi(bvid, cookie);
  } catch (err) {
    console.warn('[bilibili] WBI view 失败，降级到未签名接口:', err);
    clearWbiKeyCache();
    return getVideoInfoLegacy(bvid, cookie);
  }
}

/** 将搜索 API 返回的时长字符串 "mm:ss" 或 "hh:mm:ss" 转为秒 */
function parseDuration(durationStr: string): number {
  const parts = durationStr.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** 清理搜索结果标题中的 <em class="keyword"> 高亮标签 */
function cleanTitle(title: string): string {
  return title.replace(/<[^>]+>/g, '');
}

/**
 * 使用 WBI 签名调用 /x/web-interface/wbi/search/type 按关键词搜索视频。
 * 返回最多 20 条结果，含封面、播放量、收藏数、弹幕数等。
 * 注意：搜索 API 不返回点赞/投币数据，需调用方按需通过 getVideoInfo 补充。
 */
export async function searchVideos(
  keyword: string,
  cookie?: string,
): Promise<BilibiliSearchVideo[]> {
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams(
    {
      keyword,
      search_type: 'video',
      page: '1',
      page_size: '20',
    },
    imgKey,
    subKey,
  );
  const query = buildQueryString(signed);

  const res = await bilibiliFetch<RawSearchResponse>(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`,
    { cookie },
  );

  const items = res.data.result || [];
  return items.map((item) => ({
    bvid: item.bvid,
    aid: item.aid,
    title: cleanTitle(item.title),
    pic: item.pic.startsWith('//') ? `https:${item.pic}` : item.pic,
    play: item.play ?? 0,
    danmaku: item.video_review ?? 0,
    favorites: item.favorites ?? 0,
    review: item.review ?? 0,
    duration: parseDuration(item.duration),
    author: item.author ?? '',
    description: item.description ?? '',
  }));
}
