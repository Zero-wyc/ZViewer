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
  /** 空格分隔的视频标签（屏蔽词过滤用） */
  tag: string;
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
  /** 空格分隔的视频标签（屏蔽词过滤用） */
  tag?: string;
}

interface RawSearchResponse {
  result?: RawSearchItem[];
  /** 搜索结果总数（分页用） */
  numResults?: number;
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
 * B站 搜索分页的排序分片：单一排序最多翻 50 页（numResults 封顶 1000、
 * numPages 封顶 50，是 B站 接口硬限制）。超过 50 页后按排序维度分片继续，
 * 每种排序各 50 页，虚拟页共 200 页可翻。
 * 「最新发布」（pubdate）分片不参与合并——时间线跳变过于突兀（页与页之间
 * 内容新旧无序），对刷分类场景体验差。
 */
export const SEARCH_PAGES_PER_ORDER = 50;
export const SEARCH_ORDER_SHARDS = ['', 'click', 'dm', 'stow'] as const;
export const SEARCH_MAX_PAGES = SEARCH_ORDER_SHARDS.length * SEARCH_PAGES_PER_ORDER;

/** 虚拟页 → (排序 order, 真实页码)：空串 = 综合排序（不传 order 参数） */
function resolveSearchPage(page: number): { order: string; page: number } {
  const shardIdx = Math.min(
    Math.floor((page - 1) / SEARCH_PAGES_PER_ORDER),
    SEARCH_ORDER_SHARDS.length - 1,
  );
  return {
    order: SEARCH_ORDER_SHARDS[shardIdx],
    page: Math.min(
      page - shardIdx * SEARCH_PAGES_PER_ORDER,
      SEARCH_PAGES_PER_ORDER,
    ),
  };
}

/**
 * 使用 WBI 签名调用 /x/web-interface/wbi/search/type 按关键词搜索视频。
 * 返回最多 20 条结果，含封面、播放量、收藏数、弹幕数等。
 * 注意：搜索 API 不返回点赞/投币数据，需调用方按需通过 getVideoInfo 补充。
 */
export async function searchVideos(
  keyword: string,
  cookie?: string,
  page = 1,
): Promise<BilibiliSearchVideo[]> {
  const { items } = await searchVideosPaged(keyword, cookie, page);
  return items;
}

/** 带总数的搜索（哔哩哔哩页分页用）：total 为 null 时前端按「页满即有下一页」估算。
 *  page 为虚拟页码（>50 自动切换排序分片）；total=numResults 被 B站 封顶 1000，
 *  前端搜索模式下总页数需按 SEARCH_MAX_PAGES 兜底扩展 */
export async function searchVideosPaged(
  keyword: string,
  cookie?: string,
  page = 1,
): Promise<{ items: BilibiliSearchVideo[]; total: number | null }> {
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const { order, page: realPage } = resolveSearchPage(page);
  const signed = signParams(
    {
      keyword,
      search_type: 'video',
      page: String(realPage),
      page_size: '20',
      ...(order ? { order } : {}),
    },
    imgKey,
    subKey,
  );
  const query = buildQueryString(signed);

  const res = await bilibiliFetch<RawSearchResponse>(
    `https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`,
    { cookie },
  );

  const items = (res.data.result || []).map((item) => ({
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
    tag: item.tag ?? '',
  }));
  return {
    items,
    total:
      typeof res.data.numResults === 'number' ? res.data.numResults : null,
  };
}

/** 标签搜索结果条目（search_type=tag） */
interface RawSearchTag {
  tag_id?: number | string;
  tag_name?: string;
}

interface RawSearchTagResponse {
  result?: RawSearchTag[];
}

/** 标签下视频条目（x/web-interface/tag/videos，响应结构做过版本兼容） */
interface RawTagVideo {
  bvid?: string;
  aid?: number;
  title?: string;
  pic?: string;
  author?: string;
  owner?: { name?: string };
  /** 老接口为 "mm:ss" 字符串（length），新接口为数字秒（duration） */
  duration?: number | string;
  length?: string;
  play?: number;
  danmaku?: number;
  video_review?: number;
  stat?: { view?: number; danmaku?: number };
}

interface RawTagVideoResponse {
  vlist?: RawTagVideo[];
  videos?: RawTagVideo[];
  list?: RawTagVideo[];
}

/**
 * 按关键词查找 B站 标签：search_type=tag（WBI 签名）返回候选标签，
 * tag_name 精确匹配优先，其次第一个候选；找不到返回 null。
 */
export async function searchTagId(
  keyword: string,
  cookie?: string,
): Promise<number | null> {
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams(
    { keyword, search_type: 'tag', page: '1', page_size: '20' },
    imgKey,
    subKey,
  );
  const res = await bilibiliFetch<RawSearchTagResponse>(
    `https://api.bilibili.com/x/web-interface/search/type?${buildQueryString(signed)}`,
    { cookie },
  );
  const candidates = (res.data.result ?? []).filter(
    (t) => typeof t.tag_id === 'number' || typeof t.tag_id === 'string',
  );
  if (candidates.length === 0) return null;
  const exact = candidates.find((t) => t.tag_name === keyword);
  const chosen = exact ?? candidates[0];
  const id = Number(chosen.tag_id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * 拉取标签下的视频（x/web-interface/tag/videos，WBI 签名）。
 * 响应结构做了 vlist/videos/list 兼容；无 bvid 的条目丢弃（下游链路以 bvid 为 key）。
 */
export async function tagVideosPaged(
  tagId: number,
  cookie?: string,
  page = 1,
): Promise<{ items: BilibiliSearchVideo[]; total: number | null }> {
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams(
    { tag_id: String(tagId), pn: String(page), ps: '20' },
    imgKey,
    subKey,
  );
  const res = await bilibiliFetch<RawTagVideoResponse>(
    `https://api.bilibili.com/x/web-interface/tag/videos?${buildQueryString(signed)}`,
    { cookie },
  );
  const raw =
    res.data.vlist ?? res.data.videos ?? res.data.list ?? [];
  const items = raw
    .filter((v) => typeof v.bvid === 'string' && v.bvid)
    .map((v) => {
      const duration =
        typeof v.duration === 'number'
          ? v.duration
          : parseDuration(v.duration ?? v.length ?? '');
      return {
        bvid: v.bvid as string,
        aid: v.aid ?? 0,
        title: cleanTitle(v.title ?? ''),
        pic: v.pic
          ? v.pic.startsWith('//')
            ? `https:${v.pic}`
            : v.pic
          : '',
        play: v.play ?? v.stat?.view ?? 0,
        danmaku: v.video_review ?? v.danmaku ?? v.stat?.danmaku ?? 0,
        favorites: 0,
        review: 0,
        duration,
        author: v.author ?? v.owner?.name ?? '',
        description: '',
        tag: '',
      };
    });
  // 标签接口不返回总数，交由前端按「页满即有下一页」估算
  return { items, total: null };
}
