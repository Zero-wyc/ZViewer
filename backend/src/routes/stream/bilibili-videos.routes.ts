/**
 * B站 视频浏览与搜索路由（需登录态，由父路由统一 authenticateToken）。
 *
 *   GET /bilibili/view          按 BV 号取视频信息（添加视频弹窗「搜索」）
 *   GET /bilibili/region-new    音乐分区视频（一起听「哔哩哔哩」页）
 *   GET /bilibili/related       相关推荐视频（自动连播）
 *   GET /bilibili/search        视频搜索（search / tag / mixed 三模式）
 *   GET /bilibili/ai-subtitle   视频 AI 字幕（歌词页歌词数据源）
 */

import { Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { bilibiliFetch } from '../../services/bilibili/client';
import {
  getVideoInfo,
  searchVideosPaged,
  searchTagId,
  tagVideosPaged,
} from '../../services/bilibili/video';
import { fetchBilibiliSubtitle } from '../../services/bilibili/subtitle';
import { getUserCookie, normalizeBilibiliImageUrl } from './helpers';
import { TtlCache } from '../../utils/ttl-cache';

const router = Router();

// 查询视频信息（添加视频弹窗「搜索」）：按 BV 号取 x/web-interface/view
router.get('/bilibili/view', async (req: AuthenticatedRequest, res) => {
  const bvid = req.query.bvid;
  if (typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(bvid.trim())) {
    res.status(400).json({ success: false, message: 'BV 号格式无效' });
    return;
  }
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  try {
    const data = await bilibiliFetch<{
      title: string;
      pic: string;
      cid: number;
      duration: number;
      owner?: { name?: string };
      pages?: { page: number; part: string; cid: number }[];
    }>(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid.trim()}`, {
      cookie,
    });

    const v = data.data;
    res.json({
      success: true,
      bvid: bvid.trim(),
      title: v.title || '',
      pic: normalizeBilibiliImageUrl(v.pic || ''),
      duration: v.duration || 0,
      upName: v.owner?.name || '',
      cid: v.cid || 0,
      pages: (v.pages || []).map((p) => ({
        page: p.page,
        part: p.part || '',
        cid: p.cid,
      })),
    });
  } catch (err) {
    console.error('[bilibili] view error:', err instanceof Error ? err.message : err,);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取视频信息失败',
    });
  }
});

// ==================== 一起听「哔哩哔哩」页 ====================

// 音乐分区视频（rid=3 音乐）。
// 旧接口 x/web-interface/dynamic/region 已被 B站 下线（返回 -404），
// 改用仍可用的 x/web-interface/ranking/v2（分区排行榜）。
//
// 榜单缓存：ranking/v2 是全量榜单（本地切页），同一 rid 短时间内内容
// 不变，缓存后切换「推荐榜单」与翻页均即时返回。
interface BiliRegionRankItem {
  bvid: string;
  title: string;
  pic: string;
  duration: number;
  upName: string;
  cid: number;
  view: number;
  danmaku: number;
  date: number;
}
const REGION_RANKING_CACHE_TTL_MS = 5 * 60 * 1000;
const regionRankingCache = new TtlCache<BiliRegionRankItem[]>({
  ttlMs: REGION_RANKING_CACHE_TTL_MS,
  maxSize: 16,
});

router.get('/bilibili/region-new', async (req: AuthenticatedRequest, res) => {
  const rid = Number(req.query.rid) || 3;
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  try {
    let mapped = regionRankingCache.get(`rank:${rid}`);
    if (!mapped) {
      const data = await bilibiliFetch<{
        list?: Array<{
          bvid: string;
          title: string;
          pic: string;
          duration: number;
          pubdate?: number;
          owner?: { name?: string };
          cid: number;
          stat?: { view?: number; danmaku?: number };
        }>;
      }>(
        `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${rid}&type=all`,
        { cookie },
      );
      mapped = (data.data?.list ?? []).map((a) => ({
        bvid: a.bvid,
        title: a.title || '',
        pic: normalizeBilibiliImageUrl(a.pic || ''),
        duration: a.duration || 0,
        upName: a.owner?.name || '',
        cid: a.cid || 0,
        view: a.stat?.view || 0,
        danmaku: a.stat?.danmaku || 0,
        date: a.pubdate || 0,
      }));
      if (mapped.length > 0) {
        regionRankingCache.set(`rank:${rid}`, mapped);
      }
    }
    const ps = Math.min(Math.max(Number(req.query.ps) || 24, 1), 100);
    const pn = Math.max(Number(req.query.pn) || 1, 1);
    // ranking/v2 为全量榜单，本地按 pn/ps 切页；total 供前端算总页数
    const items = mapped.slice((pn - 1) * ps, pn * ps);
    res.json({ success: true, items, total: mapped.length });
  } catch (err) {
    console.error('[bilibili] region-new error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取分区视频失败',
    });
  }
});

// B站 相关推荐视频（B站 视频自动连播）：archive/related 公开接口，
// 按当前视频返回相关推荐列表（含 cid，可直接插播）。
router.get('/bilibili/related', async (req: AuthenticatedRequest, res) => {
  const bvid =
    typeof req.query.bvid === 'string' ? req.query.bvid.trim() : '';
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    res.status(400).json({ success: false, message: 'BV 号格式无效' });
    return;
  }
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  try {
    const view = await bilibiliFetch<{ aid?: number }>(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      { cookie },
    );
    const aid = view.data?.aid;
    if (!aid) {
      res.status(404).json({ success: false, message: '视频不存在' });
      return;
    }
    const rel = await bilibiliFetch<
      Array<{
        bvid: string;
        cid: number;
        title: string;
        pic: string;
        duration: number;
        owner?: { name?: string };
        stat?: { view?: number; danmaku?: number };
      }>
    >(`https://api.bilibili.com/x/web-interface/archive/related?aid=${aid}`, {
      cookie,
    });
    const items = (Array.isArray(rel.data) ? rel.data : []).map((v) => ({
      bvid: v.bvid,
      cid: v.cid,
      title: v.title || '',
      pic: normalizeBilibiliImageUrl(v.pic || ''),
      upName: v.owner?.name || '',
      view: v.stat?.view || 0,
      danmaku: v.stat?.danmaku || 0,
      duration: v.duration || 0,
    }));
    res.json({ success: true, items });
  } catch (err) {
    console.error('[bilibili] related error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取相关推荐失败',
    });
  }
});

// B站 视频搜索（哔哩哔哩页顶栏搜索框用）：复用弹幕搜索同款 searchVideos
// 服务（web 搜索接口），返回 bvid/标题/封面/UP主/播放量/弹幕数/时长；
// cid 由前端点击时经 view 接口补取（与收藏列表条目同路径）。
// 分页：pn 透传搜索接口 page（page_size 固定 20），total=numResults。
//
// 结果缓存：切换分区/翻页回退/多成员同请求时直接命中（B站 搜索单次
// 300-800ms），同时削峰 B站 侧请求压力。仅缓存非空成功结果——空结果
// 可能是 B站 抖动，不缓存以便下次重试。
interface BiliSearchPayloadItem {
  bvid: string;
  title: string;
  pic: string;
  upName: string;
  view: number;
  danmaku: number;
  duration: number;
  tag: string;
}
const SEARCH_RESULT_CACHE_TTL_MS = 2 * 60 * 1000;
const searchResultCache = new TtlCache<{
  items: BiliSearchPayloadItem[];
  total: number | null;
}>({ ttlMs: SEARCH_RESULT_CACHE_TTL_MS, maxSize: 300 });

/** 标签链路（search_type=tag / tag/videos）失败后的冷却期：
 *  连续失败多半是风控/接口下线，60s 内直接跳过标签尝试，避免每个分类都触发 */
let tagChainBlockedUntil = 0;

router.get('/bilibili/search', async (req: AuthenticatedRequest, res) => {
  const keyword =
    typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
  if (!keyword) {
    res.status(400).json({ success: false, message: '缺少关键词' });
    return;
  }
  const pn = Math.max(Number(req.query.pn) || 1, 1);
  // 数据源模式：search=关键词搜索 / tag=B站标签检索 / mixed=两者合并去重
  const mode =
    typeof req.query.mode === 'string' &&
    ['search', 'tag', 'mixed'].includes(req.query.mode)
      ? req.query.mode
      : 'search';
  const cacheKey = `${mode}|${keyword}|${pn}`;
  const cachedSearch = searchResultCache.get(cacheKey);
  if (cachedSearch) {
    res.json({
      success: true,
      items: cachedSearch.items,
      total: cachedSearch.total,
    });
    return;
  }
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  try {
    const toPayload = (videos: {
      bvid: string;
      title: string;
      pic: string;
      author: string;
      play: number;
      danmaku: number;
      duration: number;
      tag: string;
    }[]) =>
      videos.map((v) => ({
        bvid: v.bvid,
        title: v.title,
        pic: normalizeBilibiliImageUrl(v.pic),
        upName: v.author,
        view: v.play,
        danmaku: v.danmaku,
        duration: v.duration,
        tag: v.tag,
      }));

    if (mode === 'tag' || mode === 'mixed') {
      // 标签链路（search_type=tag / tag/videos）B站 侧不稳定，可能返回
      // HTML 错误页——失败时静默降级，tag 模式回退关键词搜索
      let tagItems: Parameters<typeof toPayload>[0] = [];
      if (Date.now() >= tagChainBlockedUntil) {
        try {
          const tagId = await searchTagId(keyword, cookie);
          if (tagId) {
            tagItems = (await tagVideosPaged(tagId, cookie, pn)).items;
          }
        } catch (err) {
          tagChainBlockedUntil = Date.now() + 60_000;
          console.error('[bilibili] tag 链路失败，回退关键词搜索:', err);
        }
      }
      if (mode === 'tag') {
        if (tagItems.length > 0) {
          const items = toPayload(tagItems);
          searchResultCache.set(cacheKey, { items, total: null });
          res.json({ success: true, items, total: null });
        } else {
          const sr = await searchVideosPaged(keyword, cookie, pn);
          const items = toPayload(sr.items);
          if (items.length > 0) {
            searchResultCache.set(cacheKey, { items, total: sr.total });
          }
          res.json({ success: true, items, total: sr.total });
        }
        return;
      }
      // mixed：搜索结果在前，标签独有的追加其后（bvid 去重）
      const sr = await searchVideosPaged(keyword, cookie, pn);
      const seen = new Set<string>();
      const merged: Parameters<typeof toPayload>[0] = [];
      for (const v of [...sr.items, ...tagItems]) {
        if (!seen.has(v.bvid)) {
          seen.add(v.bvid);
          merged.push(v);
        }
      }
      const mixedItems = toPayload(merged);
      if (mixedItems.length > 0) {
        searchResultCache.set(cacheKey, { items: mixedItems, total: sr.total });
      }
      res.json({ success: true, items: mixedItems, total: sr.total });
      return;
    }

    const { items: videos, total } = await searchVideosPaged(
      keyword,
      cookie,
      pn,
    );
    const searchItems: BiliSearchPayloadItem[] = videos.map((v) => ({
      bvid: v.bvid,
      title: v.title,
      pic: normalizeBilibiliImageUrl(v.pic),
      upName: v.author,
      view: v.play,
      danmaku: v.danmaku,
      duration: v.duration,
      tag: v.tag,
    }));
    if (searchItems.length > 0) {
      searchResultCache.set(cacheKey, { items: searchItems, total });
    }
    res.json({ success: true, items: searchItems, total });
  } catch (err) {
    console.error('[bilibili] search error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '搜索失败',
    });
  }
});

// 视频 AI 字幕（x/player/v2，需登录 Cookie 才返回 AI 字幕轨道）。
// 字幕获取标准链路（bilibili-API-collect / yt-dlp 同款）：
//   view 拿 cid → player/v2 拿字幕列表（data.subtitle.subtitles）→
//   下载 subtitle_url 的 JSON（aisubtitle.hdslb.com 公开 CDN，无需 Cookie）。
// 旧实现用的 x/web-interface/view/conclusion/get 是「AI 视频摘要」接口，
// 其 subtitle 字段经常为空且依赖 WBI 签名，已弃用。
// 请求必须携带 Referer，否则返回 412（yt-dlp#11089）。
//
// B站 字幕服务端不稳定：同一 (bvid, cid) 会偶发返回「其他视频」的字幕文件
// （字幕 JSON 内不含可校验的 cid/bvid）。完整对策已下沉到
// services/bilibili/subtitle.ts（oid 带外校验 + 时长带内校验 + 一致性投票
// + 缓存；未通过校验返回空而非可疑字幕）。

/**
 * GET /bilibili/ai-subtitle：B站 视频字幕（歌词页 B站 条目的歌词数据源）。
 *
 * 实现整体下沉到 services/bilibili/subtitle.ts：元数据 + WBI/未签名双通道取
 * 字幕轨道 + oid 带外校验 + 时长带内校验 + 一致性投票 + 成功/失败缓存，
 * 未通过校验一律返回空（绝不返回可疑字幕）。本路由只做参数校验与响应封装。
 */
router.get('/bilibili/ai-subtitle', async (req: AuthenticatedRequest, res) => {
  const bvid = req.query.bvid;
  const cid = Number(req.query.cid);
  // 视频时长（秒，可选）：带内校验基准；非法值时服务端用官方时长兜底
  const durationRaw = Number(req.query.duration);
  const durationSec =
    Number.isFinite(durationRaw) && durationRaw > 0 && durationRaw < 86400
      ? durationRaw
      : undefined;
  if (
    typeof bvid !== 'string' ||
    !/^BV[0-9A-Za-z]{10}$/.test(bvid.trim()) ||
    !Number.isFinite(cid) ||
    cid <= 0
  ) {
    res.status(400).json({ success: false, message: '参数无效' });
    return;
  }
  try {
    const cookie = (await getUserCookie(req.user?.userId)) || undefined;
    const result = await fetchBilibiliSubtitle(
      bvid.trim(),
      cid,
      cookie,
      durationSec
    );
    if (result.lines.length > 0 && 'source' in result) {
      res.json({ success: true, lines: result.lines, source: result.source });
      return;
    }
    res.json({
      success: true,
      lines: [],
      message: 'reason' in result ? result.reason : undefined,
    });
  } catch (err) {
    console.error('[bilibili] ai-subtitle error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取 AI 字幕失败',
    });
  }
});

export default router;
