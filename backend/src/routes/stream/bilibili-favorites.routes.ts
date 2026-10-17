/**
 * B站 收藏夹路由（需登录态，由父路由统一 authenticateToken）。
 *
 *   GET  /bilibili/fav-videos      登录用户的收藏视频（默认收藏夹）
 *   GET  /bilibili/fav-folders     登录用户的收藏夹列表
 *   GET  /bilibili/fav-list-videos 任意公开收藏夹视频分页
 *   POST /bilibili/fav/collect     收藏 / 取消收藏视频
 *   GET  /bilibili/fav/status      查询视频是否已收藏
 */

import { Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { bilibiliFetch } from '../../services/bilibili/client';
import {
  getUserCookie,
  normalizeBilibiliImageUrl,
  extractMidFromCookie,
} from './helpers';
import { TtlCache } from '../../utils/ttl-cache';
import type { BiliListPayloadItem } from './bilibili-lists.routes';

const router = Router();

// fav-list-videos 的收藏夹条目缓存（5 分钟，与合集/系列列表缓存同策略）
const BILI_CUSTOM_LIST_TTL_MS = 5 * 60 * 1000;
const favListVideoCache = new TtlCache<{
  items: BiliListPayloadItem[];
  total: number | null;
}>({ ttlMs: BILI_CUSTOM_LIST_TTL_MS, maxSize: 64 });

// 登录用户的收藏视频（默认收藏夹）：
// x/web-interface/nav 取 mid → x/v3/fav/folder/created/list-all 取收藏夹
// （旧接口 x/v3/fav/folder/owned/list 已被 B站 下线，返回 404）→
// x/v3/fav/resource/list 取视频条目
router.get('/bilibili/fav-videos', async (req: AuthenticatedRequest, res) => {
  const ps = Math.min(Math.max(Number(req.query.ps) || 20, 1), 50);
  const pn = Math.max(Number(req.query.pn) || 1, 1);
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  if (!cookie) {
    res.status(401).json({ success: false, message: 'B站 未登录' });
    return;
  }
  try {
    const nav = await bilibiliFetch<{ mid?: number }>(
      'https://api.bilibili.com/x/web-interface/nav',
      { cookie },
    );
    const mid = nav.data?.mid;
    if (!mid) {
      res.status(401).json({ success: false, message: 'B站 凭证失效' });
      return;
    }
    const folders = await bilibiliFetch<{
      list?: Array<{ id: number; title: string; media_count?: number }> | null;
    }>(
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
      { cookie },
    );
    const folderList = folders.data?.list ?? [];
    // mediaId：指定收藏夹（列表页切换）；缺省取默认收藏夹（id 与用户 mid
    // 相同），兜底第一个；列表中找不到指定收藏夹时直接按该 id 查询
    const mediaId = Math.floor(Number(req.query.mediaId));
    const folder =
      (Number.isFinite(mediaId) && mediaId > 0
        ? folderList.find((f) => f.id === mediaId)
        : undefined) ??
      folderList.find((f) => f.id === Number(mid)) ??
      folderList[0] ??
      (Number.isFinite(mediaId) && mediaId > 0
        ? { id: mediaId, title: '' }
        : undefined);
    if (!folder) {
      res.json({ success: true, folderTitle: '', items: [], total: 0 });
      return;
    }
    const resources = await bilibiliFetch<{
      info?: { total?: number; media_count?: number };
      medias?: Array<{
        id: number;
        bvid?: string;
        title?: string;
        cover?: string;
        duration?: number;
        upper?: { name?: string };
        type?: number;
        fav_time?: number;
        cnt_info?: { play?: number; danmaku?: number };
        stat?: { view?: number; danmaku?: number };
      }>;
    }>(
      `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${folder.id}&pn=${pn}&ps=${ps}&keyword=`,
      { cookie },
    );
    const items = (resources.data?.medias ?? [])
      .filter((m) => typeof m.bvid === 'string' && m.bvid)
      .map((m) => ({
        bvid: m.bvid as string,
        title: m.title || '',
        pic: normalizeBilibiliImageUrl(m.cover || ''),
        duration: m.duration || 0,
        upName: m.upper?.name || '',
        view: m.cnt_info?.play ?? m.stat?.view ?? 0,
        danmaku: m.cnt_info?.danmaku ?? m.stat?.danmaku ?? 0,
        // 收藏时间（秒级时间戳）
        date: m.fav_time || 0,
      }));
    res.json({
      success: true,
      folderTitle: folder.title || '默认收藏夹',
      items,
      // 收藏夹内容总数（resource/list info.total），分页用；缺失时前端按页满估算
      total: resources.data?.info?.total ?? resources.data?.info?.media_count ?? null,
    });
  } catch (err) {
    console.error('[bilibili] fav-videos error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取收藏视频失败',
    });
  }
});

// 登录用户的收藏夹列表（左列切换用）：
// 分页版 x/v3/fav/folder/created/list 条目带 cover（收藏夹封面，通常为
// 收藏的首个视频封面），精简版 created/list-all 无封面字段。ps 上限 20，
// 循环 pn 拉全（自建收藏夹数量有限，20 页防御性截断）。
router.get('/bilibili/fav-folders', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  if (!cookie) {
    res.status(401).json({ success: false, message: 'B站 未登录' });
    return;
  }
  try {
    const nav = await bilibiliFetch<{ mid?: number }>(
      'https://api.bilibili.com/x/web-interface/nav',
      { cookie },
    );
    const mid = nav.data?.mid;
    if (!mid) {
      res.status(401).json({ success: false, message: 'B站 凭证失效' });
      return;
    }
    type FavFolderRaw = {
      id: number;
      title?: string;
      media_count?: number;
      cover?: string;
    };
    const rawList: FavFolderRaw[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let pn = 1; pn <= 20 && rawList.length < total; pn++) {
      const page = await bilibiliFetch<{
        count?: number;
        has_more?: boolean;
        list?: FavFolderRaw[] | null;
      }>(
        `https://api.bilibili.com/x/v3/fav/folder/created/list?up_mid=${mid}&pn=${pn}&ps=20`,
        { cookie },
      );
      total =
        typeof page.data?.count === 'number'
          ? page.data.count
          : rawList.length;
      const items = page.data?.list ?? [];
      if (items.length === 0) break;
      rawList.push(...items);
    }
    const list = rawList.map((f) => ({
      id: f.id,
      title: f.title || '默认收藏夹',
      mediaCount: f.media_count ?? 0,
      cover: f.cover ? normalizeBilibiliImageUrl(f.cover) : '',
    }));
    res.json({ success: true, folders: list });
  } catch (err) {
    console.error('[bilibili] fav-folders error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取收藏夹列表失败',
    });
  }
});

// 任意公开收藏夹视频分页（media_id=收藏夹 fid；匿名可查公开夹，
// 携带登录 Cookie 可查自己的私密夹）
router.get('/bilibili/fav-list-videos', async (req: AuthenticatedRequest, res) => {
  const fid = Math.floor(Number(req.query.fid));
  const pn = Math.max(Number(req.query.pn) || 1, 1);
  const ps = Math.min(Math.max(Number(req.query.ps) || 20, 1), 50);
  if (!Number.isFinite(fid) || fid <= 0) {
    res.status(400).json({ success: false, message: '参数无效' });
    return;
  }
  const cacheKey = `${fid}|${pn}|${ps}`;
  const cached = favListVideoCache.get(cacheKey);
  if (cached) {
    res.json({ success: true, items: cached.items, total: cached.total });
    return;
  }
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  try {
    const resources = await bilibiliFetch<{
      info?: { title?: string; total?: number; media_count?: number };
      medias?: Array<{
        bvid?: string;
        title?: string;
        cover?: string;
        duration?: number;
        upper?: { name?: string };
        type?: number;
        fav_time?: number;
        cnt_info?: { play?: number; danmaku?: number };
        stat?: { view?: number; danmaku?: number };
      }> | null;
    }>(
      `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${fid}&pn=${pn}&ps=${ps}&keyword=&type=0&tid=0&platform=web&order=mtime`,
      { cookie },
    );
    const items = (resources.data?.medias ?? [])
      .filter((m) => typeof m.bvid === 'string' && m.bvid)
      .map(
        (m): BiliListPayloadItem => ({
          bvid: m.bvid as string,
          title: m.title || '',
          pic: normalizeBilibiliImageUrl(m.cover || ''),
          upName: m.upper?.name || '',
          view: m.cnt_info?.play ?? m.stat?.view ?? 0,
          danmaku: m.cnt_info?.danmaku ?? m.stat?.danmaku ?? 0,
          duration: m.duration || 0,
          date: m.fav_time || 0,
        }),
      );
    const total =
      resources.data?.info?.total ?? resources.data?.info?.media_count ?? null;
    if (items.length > 0) {
      favListVideoCache.set(cacheKey, { items, total });
    }
    res.json({ success: true, items, total });
  } catch (err) {
    console.error('[bilibili] fav-list-videos error:', err);
    res.status(502).json({
      success: false,
      message:
        err instanceof Error ? err.message : '获取收藏夹视频失败',
    });
  }
});

// B站 视频收藏 / 取消收藏（哔哩哔哩页/播放控制栏红心）：
// view 拿 aid → 定位目标收藏夹（mediaId 指定，或按 folderTitle 自动创建，
// 默认「Music」）→ x/v3/fav/resource/deal：
//   收藏 = add_media_ids=<fid>、取消收藏 = del_media_ids=<fid>（同一端点）。
// 写操作需要 csrf（Cookie 里的 bili_jct）。取消收藏时若目标收藏夹不存在
// 则不创建（直接判定为"尚未收藏"）。
function extractCsrf(cookie: string): string | null {
  const match = cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
  return match ? match[1] : null;
}

router.post('/bilibili/fav/collect', async (req: AuthenticatedRequest, res) => {
  const bvid =
    typeof req.body?.bvid === 'string' ? req.body.bvid.trim() : '';
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    res.status(400).json({ success: false, message: 'BV 号格式无效' });
    return;
  }
  const mediaId = Math.floor(Number(req.body?.mediaId));
  const folderTitle =
    typeof req.body?.folderTitle === 'string' && req.body.folderTitle.trim()
      ? req.body.folderTitle.trim()
      : 'Music';
  /** add = 收藏（默认）；remove = 取消收藏 */
  const action: 'add' | 'remove' = req.body?.action === 'remove' ? 'remove' : 'add';
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  if (!cookie) {
    res.status(401).json({ success: false, message: 'B站 未登录' });
    return;
  }
  const csrf = extractCsrf(cookie);
  if (!csrf) {
    res.status(401).json({ success: false, message: 'B站 凭证缺少 csrf' });
    return;
  }
  try {
    // 1) bvid → aid
    const view = await bilibiliFetch<{ aid?: number }>(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      { cookie },
    );
    const aid = view.data?.aid;
    if (!aid) {
      res.status(404).json({ success: false, message: '视频不存在' });
      return;
    }
    // 2) 定位/创建目标收藏夹
    let targetId = Number.isFinite(mediaId) && mediaId > 0 ? mediaId : 0;
    let targetTitle =
      typeof req.body?.mediaId === 'number' ? '' : folderTitle;
    if (!targetId) {
      const folders = await bilibiliFetch<{
        list?: Array<{ id: number; title: string }> | null;
      }>(
        `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${extractMidFromCookie(cookie) ?? ''}`,
        { cookie },
      );
      const list = folders.data?.list ?? [];
      const existing = list.find((f) => f.title === folderTitle);
      if (existing) {
        targetId = existing.id;
      } else if (action === 'remove') {
        // 取消收藏：目标收藏夹不存在 → 视为尚未收藏，不创建
        res.status(404).json({
          success: false,
          message: `尚未收藏到「${folderTitle}」`,
        });
        return;
      } else {
        const created = await bilibiliFetch<{ id?: number }>(
          'https://api.bilibili.com/x/v3/fav/folder/add',
          {
            cookie,
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `title=${encodeURIComponent(folderTitle)}&privacy=0&csrf=${encodeURIComponent(csrf)}`,
          },
        );
        targetId = Number(created.data?.id);
        targetTitle = folderTitle;
      }
      if (!targetId) {
        res.status(502).json({
          success: false,
          message: '创建收藏夹失败',
        });
        return;
      }
    } else {
      // 指定 mediaId 时补一个标题用于提示
      const folders = await bilibiliFetch<{
        list?: Array<{ id: number; title: string }> | null;
      }>(
        `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${extractMidFromCookie(cookie) ?? ''}`,
        { cookie },
      );
      targetTitle =
        folders.data?.list?.find((f) => f.id === targetId)?.title ?? '';
    }
    // 3) 收藏 / 取消收藏视频（type=2 视频）。add_media_ids 与
    // del_media_ids 均为逗号分隔的纯数字 id（B站 web 同款；JSON 数组
    // 字符串带方括号会被 B站 解析为非法参数，返回「业务错误 [-400]」）
    const dealBody =
      action === 'remove'
        ? `rid=${aid}&type=2&add_media_ids=&del_media_ids=${encodeURIComponent(String(targetId))}&csrf=${encodeURIComponent(csrf)}`
        : `rid=${aid}&type=2&add_media_ids=${encodeURIComponent(String(targetId))}&del_media_ids=&csrf=${encodeURIComponent(csrf)}`;
    await bilibiliFetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
      cookie,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: dealBody,
    });
    res.json({
      success: true,
      action,
      folderId: targetId,
      folderTitle: targetTitle,
    });
  } catch (err) {
    console.error('[bilibili] fav/collect error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '收藏失败',
    });
  }
});

// 查询视频是否已收藏（歌词页一键收藏红心回显）：
// bvid → aid → folder/created/list-all 带 rid 参数，B站 对每个收藏夹
// 返回 fav_state=1 表示当前视频已收藏在该夹（B站 web 收藏弹窗同款做法）。
// 「已收藏」= 用户创建的**任意**收藏夹命中（不限标题）——视频可能被在
// B站 端手动收进别的夹/夹改名，按标题单查会漏；命中夹的 id/标题一并
// 返回，取消收藏时可定向移除。未登录 401，前端静默降级不回显。
router.get('/bilibili/fav/status', async (req: AuthenticatedRequest, res) => {
  const bvid =
    typeof req.query?.bvid === 'string' ? req.query.bvid.trim() : '';
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    res.status(400).json({ success: false, message: 'BV 号格式无效' });
    return;
  }
  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;
  if (!cookie) {
    res.status(401).json({ success: false, message: 'B站 未登录' });
    return;
  }
  try {
    // 1) bvid → aid
    const view = await bilibiliFetch<{ aid?: number }>(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      { cookie },
    );
    const aid = view.data?.aid;
    if (!aid) {
      res.status(404).json({ success: false, message: '视频不存在' });
      return;
    }
    // 2) 官方接口聚合查询：rid 参数 → fav_state 生效，任一夹命中即已收藏
    const folders = await bilibiliFetch<{
      list?: Array<{ id: number; title: string; fav_state?: number }> | null;
    }>(
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?rid=${aid}&type=2&up_mid=${extractMidFromCookie(cookie) ?? ''}`,
      { cookie },
    );
    const hit = folders.data?.list?.find((f) => (f.fav_state ?? 0) === 1);
    res.json({
      success: true,
      collected: hit != null,
      folderId: hit?.id,
      folderTitle: hit?.title,
    });
  } catch (err) {
    console.error('[bilibili] fav/status error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '查询收藏状态失败',
    });
  }
});

export default router;
