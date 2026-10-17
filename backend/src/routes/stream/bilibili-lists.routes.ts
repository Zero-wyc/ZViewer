/**
 * B站 自定义栏目路由（合集 / 系列，哔哩哔哩页顶栏通过链接添加）。
 *
 *   GET /bilibili/link-meta          解析栏目链接元信息
 *   GET /bilibili/collection-videos  合集/系列视频分页
 */

import { Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { bilibiliFetch } from '../../services/bilibili/client';
import { DEFAULT_PROXY_UA } from '../../services/proxy';
import { getUserCookie, normalizeBilibiliImageUrl } from './helpers';
import { TtlCache } from '../../utils/ttl-cache';

const router = Router();

// ===== 自定义栏目：视频合集 / 系列 / 收藏夹（哔哩哔哩页顶栏通过链接添加） =====
// 链接形式（space.bilibili.com）：
//   合集    /{mid}/lists/{sid}（新版）· /{mid}/channel/collectiondetail?sid={sid}
//   系列    /{mid}/lists/{sid}（新版）· /{mid}/channel/seriesdetail?sid={sid}
//   收藏夹  /{mid}/favlist?fid={fid}
// 注意：合集(season)与系列(series)的 id 是两个独立命名空间——/lists/{sid}
// 无法从链接区分类型，用 seasons_archives_list 返回的 meta.mid 与链接 mid
// 比对：一致 → 合集；不一致（该数字恰为其他 UP 的合集 id）或请求失败 →
// 按系列（x/series/archives）查询。以上接口均无需 WBI 签名（实测匿名可用）。

/** 合集 / 系列 / 收藏夹条目的统一 payload（收藏夹子路由复用） */
export interface BiliListPayloadItem {
  bvid: string;
  title: string;
  pic: string;
  upName: string;
  view: number;
  danmaku: number;
  duration: number;
  date: number;
}

const BILI_CUSTOM_LIST_TTL_MS = 5 * 60 * 1000;
const collectionVideoCache = new TtlCache<{
  items: BiliListPayloadItem[];
  total: number | null;
}>({ ttlMs: BILI_CUSTOM_LIST_TTL_MS, maxSize: 64 });

type BiliCustomKind = 'season' | 'series' | 'favlist';

/** 合集/系列条目 → 列表 payload（两接口条目同构：stat 可能缺 danmaku，无 UP 信息） */
function mapBiliArchiveItem(a: {
  bvid?: string;
  title?: string;
  pic?: string;
  duration?: number;
  pubdate?: number;
  stat?: { view?: number; danmaku?: number };
}): BiliListPayloadItem | null {
  if (!a.bvid) return null;
  return {
    bvid: a.bvid,
    title: a.title || '',
    pic: normalizeBilibiliImageUrl(a.pic || ''),
    upName: '',
    view: a.stat?.view ?? 0,
    danmaku: a.stat?.danmaku ?? 0,
    duration: a.duration || 0,
    date: a.pubdate || 0,
  };
}

/** b23.tv 短链展开（跟随 302 取最终地址；非短链原样返回） */
async function expandBiliShortLink(url: URL): Promise<URL> {
  if (!/(^|\.)b23\.tv$/i.test(url.hostname)) return url;
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': DEFAULT_PROXY_UA, Referer: 'https://www.bilibili.com' },
  });
  const finalUrl = new URL(res.url);
  if (/(^|\.)b23\.tv$/i.test(finalUrl.hostname)) {
    throw new Error('短链展开失败');
  }
  return finalUrl;
}

/** 解析 B站 栏目链接 → 类型 + UP mid + 列表 id（sid / fid） */
function parseBiliSpaceLink(url: URL):
  | { kind: BiliCustomKind; mid: number | null; listId: number }
  | null {
  if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/(\d+)\/(favlist|lists(?:\/[^/]+)?|channel\/(?:collectiondetail|seriesdetail))\/?$/);
  if (!m) return null;
  const mid = Number(m[1]);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const seg = m[2];
  if (seg === 'favlist') {
    const fid = Math.floor(Number(url.searchParams.get('fid')));
    if (!Number.isFinite(fid) || fid <= 0) return null;
    return { kind: 'favlist', mid, listId: fid };
  }
  const sid = Math.floor(
    Number(
      url.searchParams.get('sid') ??
        (url.pathname.match(/^\/\d+\/lists\/(\d+)/)?.[1] ?? NaN),
    ),
  );
  if (!Number.isFinite(sid) || sid <= 0) return null;
  if (seg.startsWith('channel/collectiondetail')) return { kind: 'season', mid, listId: sid };
  if (seg.startsWith('channel/seriesdetail')) return { kind: 'series', mid, listId: sid };
  // /lists/{sid}：类型未知，交给 link-meta 自动甄别（season/series）
  return { kind: 'season', mid, listId: sid };
}

// 解析栏目链接元信息：返回类型、mid、列表 id 与 B站 侧标题（前端添加栏目时
// 预填名称并校验链接有效性；收藏夹私密/不存在时 B站 返回业务错误透出）
router.get('/bilibili/link-meta', async (req: AuthenticatedRequest, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) {
    res.status(400).json({ success: false, message: '缺少链接' });
    return;
  }
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  try {
    let url: URL;
    try {
      url = await expandBiliShortLink(new URL(rawUrl));
    } catch {
      res.status(400).json({ success: false, message: '链接无效' });
      return;
    }
    const parsed = parseBiliSpaceLink(url);
    if (!parsed) {
      res.status(400).json({
        success: false,
        message: '无法识别的链接：支持合集、系列或收藏夹页面链接',
      });
      return;
    }
    if (parsed.kind === 'favlist') {
      const info = await bilibiliFetch<{
        info?: { title?: string; total?: number; media_count?: number };
      }>(
        `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${parsed.listId}&pn=1&ps=1&keyword=&type=0&tid=0&platform=web`,
        { cookie },
      );
      res.json({
        success: true,
        kind: 'favlist',
        mid: parsed.mid,
        listId: parsed.listId,
        title: info.data?.info?.title || '',
        total: info.data?.info?.total ?? info.data?.info?.media_count ?? null,
      });
      return;
    }
    // 合集优先（meta.mid 与链接 mid 比对排除 id 撞上其他 UP 合集的情况）
    try {
      const season = await bilibiliFetch<{
        meta?: { mid?: number; name?: string; title?: string; total?: number };
        page?: { total?: number };
      }>(
        `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${parsed.mid}&season_id=${parsed.listId}&page_num=1&page_size=1`,
        { cookie },
      );
      const meta = season.data?.meta;
      if (meta && meta.mid === parsed.mid) {
        res.json({
          success: true,
          kind: 'season',
          mid: parsed.mid,
          listId: parsed.listId,
          title: meta.name || meta.title || '',
          total: meta.total ?? season.data?.page?.total ?? null,
        });
        return;
      }
    } catch {
      // 合集查询失败 → 尝试系列
    }
    const series = await bilibiliFetch<{
      page?: { total?: number };
    }>(
      `https://api.bilibili.com/x/series/archives?mid=${parsed.mid}&series_id=${parsed.listId}&pn=1&ps=1`,
      { cookie },
    );
    let title = '';
    try {
      const seriesMeta = await bilibiliFetch<{
        meta?: { name?: string };
      }>(`https://api.bilibili.com/x/series/series?series_id=${parsed.listId}`, {
        cookie,
      });
      title = seriesMeta.data?.meta?.name || '';
    } catch {
      // 系列标题获取失败不阻塞添加
    }
    res.json({
      success: true,
      kind: 'series',
      mid: parsed.mid,
      listId: parsed.listId,
      title,
      total: series.data?.page?.total ?? null,
    });
  } catch (err) {
    console.error('[bilibili] link-meta error:', err);
    res.status(502).json({
      success: false,
      message:
        err instanceof Error ? err.message : '解析链接失败',
    });
  }
});

// 合集/系列视频分页（自定义栏目浏览；kind 由添加时的 link-meta 解析确定）
router.get(
  '/bilibili/collection-videos',
  async (req: AuthenticatedRequest, res) => {
    const mid = Math.floor(Number(req.query.mid));
    const sid = Math.floor(Number(req.query.sid));
    const kind: BiliCustomKind =
      req.query.kind === 'series' ? 'series' : 'season';
    const pn = Math.max(Number(req.query.pn) || 1, 1);
    const ps = Math.min(Math.max(Number(req.query.ps) || 20, 1), 20);
    if (!Number.isFinite(mid) || mid <= 0 || !Number.isFinite(sid) || sid <= 0) {
      res.status(400).json({ success: false, message: '参数无效' });
      return;
    }
    const cacheKey = `${kind}|${mid}|${sid}|${pn}|${ps}`;
    const cached = collectionVideoCache.get(cacheKey);
    if (cached) {
      res.json({ success: true, items: cached.items, total: cached.total });
      return;
    }
    const userId = req.user?.userId;
    const cookie = (await getUserCookie(userId)) || undefined;
    try {
      if (kind === 'season') {
        const season = await bilibiliFetch<{
          archives?: Array<
            Parameters<typeof mapBiliArchiveItem>[0]
          > | null;
          page?: { total?: number };
        }>(
          `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${sid}&page_num=${pn}&page_size=${ps}`,
          { cookie },
        );
        const items = (season.data?.archives ?? [])
          .map(mapBiliArchiveItem)
          .filter((it): it is BiliListPayloadItem => it != null);
        const total = season.data?.page?.total ?? null;
        if (items.length > 0) {
          collectionVideoCache.set(cacheKey, { items, total });
        }
        res.json({ success: true, items, total });
        return;
      }
      const series = await bilibiliFetch<{
        archives?: Array<
          Parameters<typeof mapBiliArchiveItem>[0]
        > | null;
        page?: { total?: number };
      }>(
        `https://api.bilibili.com/x/series/archives?mid=${mid}&series_id=${sid}&pn=${pn}&ps=${ps}`,
        { cookie },
      );
      const items = (series.data?.archives ?? [])
        .map(mapBiliArchiveItem)
        .filter((it): it is BiliListPayloadItem => it != null);
      const total = series.data?.page?.total ?? null;
      if (items.length > 0) {
        collectionVideoCache.set(cacheKey, { items, total });
      }
      res.json({ success: true, items, total });
    } catch (err) {
      console.error('[bilibili] collection-videos error:', err);
      res.status(502).json({
        success: false,
        message: err instanceof Error ? err.message : '获取合集视频失败',
      });
    }
  },
);

export default router;
