/**
 * B站 扫码登录与账号信息路由（需登录态，由父路由统一 authenticateToken）。
 *
 *   GET  /bilibili/qr                 获取登录二维码
 *   GET  /bilibili/qr/poll            轮询扫码状态
 *   GET  /bilibili/login-status       查询登录状态
 *   POST /bilibili/logout             退出登录
 *   GET  /bilibili/user-info          当前账号信息
 *   GET  /bilibili/following-bangumi  关注的番剧列表
 *   GET  /bilibili/bangumi-episodes   番剧集数列表
 */

import { Router, Response } from 'express';
import QRCode from 'qrcode';
import { AuthenticatedRequest } from '../../middleware/auth';
import { bilibiliFetch } from '../../services/bilibili/client';
import type { BilibiliResponse } from '../../services/bilibili/client';
import {
  getVideoInfo,
  searchVideosPaged,
  searchTagId,
  tagVideosPaged,
} from '../../services/bilibili/video';
import { getWbiKeys, signParams } from '../../services/bilibili/wbi';
import { fetchBilibiliSubtitle } from '../../services/bilibili/subtitle';
import {
  saveCredential,
  clearCredential,
} from '../../services/bilibili/credential';
import {
  getCachedUserInfo,
  setCachedUserInfo,
  invalidateUserInfo,
} from '../../services/bilibili/cache';
import { TtlCache } from '../../utils/ttl-cache';
import { DEFAULT_PROXY_UA } from '../../services/proxy';
import {
  getUserCookie,
  normalizeBilibiliImageUrl,
  extractMidFromCookie,
  parseSetCookieHeader,
  fetchCookiesFromSsoUrl,
  validateCookieAndCacheUserInfo,
  type BilibiliQrPollResponse,
  type BilibiliNavData,
} from './helpers';

const router = Router();

// 获取二维码（扫码登录 B站）
router.get('/bilibili/qr', async (_req, res) => {
  try {
    const data = await bilibiliFetch<{ url: string; qrcode_key: string }>(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
    );
    if (!data.data.qrcode_key || !data.data.url) {
      res.status(500).json({ success: false, message: '获取二维码失败' });
      return;
    }
    const qrDataUrl = await QRCode.toDataURL(data.data.url);
    res.json({
      success: true,
      qrcodeKey: data.data.qrcode_key,
      qrUrl: data.data.url,
      qrDataUrl,
    });
  } catch (err) {
    console.error('[bilibili] qr generate error:', err);
    res.status(500).json({ success: false, message: '生成二维码失败' });
  }
});

// 轮询二维码扫描状态
router.get('/bilibili/qr/poll', async (req: AuthenticatedRequest, res) => {
  const key = req.query.qrcode_key;
  const userId = req.user?.userId;
  if (typeof key !== 'string' || !key.trim()) {
    res.status(400).json({ success: false, message: '缺少 qrcode_key' });
    return;
  }

  try {
    const pollRes = await fetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${key}`,
      {
        headers: {
          'User-Agent': DEFAULT_PROXY_UA,
          Referer: 'https://www.bilibili.com',
        },
      },
    );
    if (!pollRes.ok) {
      res.status(500).json({ success: false, message: '轮询二维码状态失败' });
      return;
    }

    const pollResData = (await pollRes.json()) as BilibiliQrPollResponse;
    const pollData = pollResData.data;

    // 新版二维码接口使用 data.code 表示状态，需映射为前端约定的 0/1/2/3
    const innerCode = pollData?.code;
    let status = pollData?.status ?? -1;
    if (innerCode === 0 && pollData?.url) status = 2;
    else if (innerCode === 86101) status = 0;
    else if (innerCode === 86090) status = 1;
    else if (innerCode === 86038) status = 3;

    // status: 0 未扫码, 1 已扫码未确认, 2 已确认登录, 3 二维码过期
    if (status === 2 && userId) {
      let cookie: string | null = null;

      // 新版流程：通过扫码成功后返回的跨域 URL 获取最终登录 Cookie
      if (pollData?.url) {
        cookie = await fetchCookiesFromSsoUrl(pollData.url);
      }

      // 兼容旧版：poll 响应头中直接包含 Set-Cookie
      if (!cookie) {
        cookie = parseSetCookieHeader(pollRes.headers) || null;
      }

      if (!cookie) {
        res.status(500).json({
          success: false,
          message: '登录确认成功，但未能获取 B站 Cookie',
        });
        return;
      }

      const validation = await validateCookieAndCacheUserInfo(
        cookie,
        String(userId),
      );
      if (!validation.valid) {
        res.status(500).json({
          success: false,
          message: '获取到 Cookie，但无法通过 B站 登录验证',
        });
        return;
      }

      await saveCredential(
        String(userId),
        cookie,
        pollData?.refresh_token || undefined,
      );
      console.log('[bilibili] login success, cookie saved for user', userId);
    }

    res.json({
      success: true,
      status,
      message: pollData?.message || '',
      loggedIn: !!(await getUserCookie(userId)),
    });
  } catch (err) {
    console.error('[bilibili] qr poll error:', err);
    res.status(500).json({ success: false, message: '轮询二维码状态失败' });
  }
});

// 查询当前登录状态
router.get('/bilibili/login-status', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    res.json({ success: true, loggedIn: !!(await getUserCookie(userId)) });
  } catch (err) {
    console.error('login-status error:', err);
    res.status(500).json({ success: false, message: '查询登录状态失败' });
  }
});

// 获取当前绑定的 B站 Cookie（仅返回用户自己的凭据，供「复制 Cookie」功能使用）
router.get('/bilibili/cookie', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    const cookie = await getUserCookie(userId);
    if (!cookie) {
      res.json({ success: false, message: '未登录 B站' });
      return;
    }
    res.json({ success: true, cookie });
  } catch (err) {
    console.error('bilibili cookie error:', err);
    res.status(500).json({ success: false, message: '获取 Cookie 失败' });
  }
});

// Cookie 登录 B站（手动粘贴 Cookie）
router.post('/bilibili/cookie-login', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  const cookie = typeof req.body?.cookie === 'string' ? req.body.cookie.trim() : '';

  if (!userId) {
    res.status(401).json({ success: false, message: '未登录' });
    return;
  }
  if (!cookie) {
    res.status(400).json({ success: false, message: '请输入 Cookie' });
    return;
  }

  // 基本格式校验：至少包含 SESSDATA
  if (!/SESSDATA\s*=/.test(cookie)) {
    res.status(400).json({
      success: false,
      message: 'Cookie 中未找到 SESSDATA，请确认已复制完整的 Cookie',
    });
    return;
  }

  try {
    const validation = await validateCookieAndCacheUserInfo(
      cookie,
      String(userId),
    );
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        message: 'Cookie 验证失败，可能已过期或不正确',
      });
      return;
    }

    await saveCredential(String(userId), cookie);
    console.log('[bilibili] cookie login success, user:', validation.name, 'for user', userId);

    res.json({
      success: true,
      message: 'B站 Cookie 登录成功',
      name: validation.name,
      avatar: validation.avatar,
    });
  } catch (err) {
    console.error('[bilibili] cookie login error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Cookie 登录失败',
    });
  }
});

// 退出 B站登录
router.post('/bilibili/logout', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.userId;
    if (userId !== undefined && userId !== null) {
      const userIdStr = String(userId);
      await clearCredential(userIdStr);
      invalidateUserInfo(userIdStr);
    }
    res.json({ success: true, message: '已退出登录' });
  } catch (err) {
    console.error('bilibili logout error:', err);
    res.status(500).json({ success: false, message: '退出登录失败' });
  }
});

// 获取当前登录 B站 账号信息
router.get('/bilibili/user-info', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  const cookie = await getUserCookie(userId);
  if (!cookie) {
    res.json({ success: false, message: '未登录 B站' });
    return;
  }

  const userIdStr = String(userId);
  // 缓存命中即返回（TTL 由 cache 模块内部保证）
  const cached = getCachedUserInfo(userIdStr);
  if (cached) {
    console.log('[bilibili] user-info served from cache:', cached.name);
    res.json({
      success: true,
      name: cached.name,
      avatar: cached.avatar,
      vipStatus: cached.vipStatus ?? 0,
    });
    return;
  }

  try {
    const data = await bilibiliFetch<BilibiliNavData>(
      'https://api.bilibili.com/x/web-interface/nav',
      { cookie },
    );

    if (!data.data.isLogin) {
      res.json({
        success: false,
        message: '获取 B站 用户信息失败',
      });
      return;
    }

    const name = data.data.uname || '';
    const avatar = normalizeBilibiliImageUrl(data.data.face || '');
    const mid = data.data.mid;
    const vipStatus = data.data.vipStatus;
    setCachedUserInfo(userIdStr, {
      name,
      avatar,
      mid,
      vipStatus,
      vipType: data.data.vipType,
    });

    console.log(
      '[bilibili] user-info fetched, name:',
      name,
      'avatar length:',
      avatar.length,
    );
    res.json({
      success: true,
      name,
      avatar,
      vipStatus: vipStatus ?? 0,
    });
  } catch (err) {
    console.error('[bilibili] user-info error:', err);
    res.json({
      success: false,
      message: err instanceof Error ? err.message : '获取 B站 用户信息失败',
    });
  }
});

// 获取当前登录账号已关注的番剧列表
router.get('/bilibili/following-bangumi', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.userId;
  const cookie = await getUserCookie(userId);
  if (!cookie) {
    res.status(401).json({ success: false, message: '未登录 B站' });
    return;
  }

  const userIdStr = String(userId);
  let mid = extractMidFromCookie(cookie);

  // 如果 Cookie 中没有 DedeUserID，尝试从缓存或 nav 接口获取
  if (!mid) {
    const cached = getCachedUserInfo(userIdStr);
    if (cached?.mid) {
      mid = String(cached.mid);
    } else {
      try {
        const nav = await bilibiliFetch<BilibiliNavData>(
          'https://api.bilibili.com/x/web-interface/nav',
          { cookie },
        );
        if (nav.data.mid) {
          mid = String(nav.data.mid);
          setCachedUserInfo(userIdStr, {
            name: nav.data.uname || '',
            avatar: normalizeBilibiliImageUrl(nav.data.face || ''),
            mid: nav.data.mid,
          });
        }
      } catch (err) {
        console.error('[bilibili] following-bangumi fetch mid error:', err);
      }
    }
  }

  if (!mid) {
    res.status(400).json({ success: false, message: '无法获取 B站 用户 ID' });
    return;
  }

  try {
    const page =
      typeof req.query.page === 'string' && req.query.page.trim()
        ? Number(req.query.page.trim())
        : 1;
    const pageSize =
      typeof req.query.pageSize === 'string' && req.query.pageSize.trim()
        ? Number(req.query.pageSize.trim())
        : 50;
    const pn = Number.isFinite(page) && page > 0 ? page : 1;
    const ps = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 50;

    interface AppBangumiItem {
      title?: string;
      cover?: string;
      param?: string;
      uri?: string;
      newest_ep_index?: string;
      total_count?: string | number;
      index?: string;
    }

    // 原 web 接口 x/space/bangumi/follow/list 已返回 -400，改为可用的 app 端接口
    const bangumiRes = await bilibiliFetch<{
      count?: number;
      item?: AppBangumiItem[];
    }>(
      `https://app.bilibili.com/x/v2/space/bangumi?vmid=${mid}&pn=${pn}&ps=${ps}`,
      { cookie },
    );

    const rawList = Array.isArray(bangumiRes.data.item)
      ? bangumiRes.data.item
      : [];
    const list = rawList.map((item: any) => {
      const seasonId =
        Number(item.param) ||
        Number(item.uri?.split('/').pop()) ||
        0;
      return {
        seasonId,
        title: item.title || '',
        cover: normalizeBilibiliImageUrl(item.cover || ''),
        progress: item.newest_ep_index || item.index || '',
        total: Number(item.total_count) || 0,
      };
    });

    res.json({ success: true, list });
  } catch (err) {
    console.error('[bilibili] following-bangumi error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取关注番剧列表失败',
    });
  }
});

// 获取指定番剧的集数列表
router.get('/bilibili/bangumi-episodes', async (req: AuthenticatedRequest, res: Response) => {
  const seasonId = req.query.seasonId;
  if (typeof seasonId !== 'string' || !seasonId.trim()) {
    res.status(400).json({ success: false, message: '缺少 seasonId 参数' });
    return;
  }

  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;

  try {
    interface BangumiSeasonResult {
      episodes?: any[];
      main_section?: { episodes?: any[] };
      section?: { episodes?: any[] }[];
    }

    const data = await bilibiliFetch<{
      result?: BangumiSeasonResult;
    }>(
      `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId.trim()}`,
      { cookie },
    );

    // pgc/view/web/season 实际返回 { code, message, result }
    // 同时兼容旧代码期望的 { code, message, data: { result } }
    const result =
      (data as unknown as { result?: BangumiSeasonResult }).result ??
      data.data?.result;

    let rawEpisodes: any[] = [];
    if (result) {
      rawEpisodes =
        result.episodes || result.main_section?.episodes || [];
      if (!rawEpisodes.length && Array.isArray(result.section)) {
        rawEpisodes = result.section.flatMap((s) => s.episodes || []);
      }
    }

    const episodes = rawEpisodes.map((ep: any, idx: number) => ({
      bvid: ep.bvid || '',
      cid: ep.cid || 0,
      title:
        [ep.title_format, ep.long_title].filter(Boolean).join(' ') ||
        ep.long_title ||
        ep.title ||
        '',
      index: ep.title || ep.index || idx + 1,
    }));

    res.json({ success: true, episodes });
  } catch (err) {
    console.error('[bilibili] bangumi-episodes error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取番剧集数失败',
    });
  }
});

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

// ===== 自定义栏目：视频合集 / 系列 / 收藏夹（哔哩哔哩页顶栏通过链接添加） =====
// 链接形式（space.bilibili.com）：
//   合集    /{mid}/lists/{sid}（新版）· /{mid}/channel/collectiondetail?sid={sid}
//   系列    /{mid}/lists/{sid}（新版）· /{mid}/channel/seriesdetail?sid={sid}
//   收藏夹  /{mid}/favlist?fid={fid}
// 注意：合集(season)与系列(series)的 id 是两个独立命名空间——/lists/{sid}
// 无法从链接区分类型，用 seasons_archives_list 返回的 meta.mid 与链接 mid
// 比对：一致 → 合集；不一致（该数字恰为其他 UP 的合集 id）或请求失败 →
// 按系列（x/series/archives）查询。以上接口均无需 WBI 签名（实测匿名可用）。
interface BiliListPayloadItem {
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
const favListVideoCache = new TtlCache<{
  items: BiliListPayloadItem[];
  total: number | null;
}>({ ttlMs: BILI_CUSTOM_LIST_TTL_MS, maxSize: 64 });

type BiliCustomKind = 'season' | 'series' | 'favlist';
const isBiliCustomKind = (v: unknown): v is BiliCustomKind =>
  v === 'season' || v === 'series' || v === 'favlist';

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

// ==================== B站 视频评论区（哔哩哔哩歌词播放页） ====================
// 主楼走现行 web 接口 x/v2/reply/main（需 WBI 签名 + buvid cookie；旧版
// x/v2/reply 的 pn 分页已废——实测 pn>1 恒空、ps 大值无效）。
// 未登录游客 B站 仅开放前 3 条主楼（is_end 提前为 true），登录态完整分页；
// 楼中楼 x/v2/reply/reply 旧版 pn 分页匿名可用。

/** 评论条目（主楼 / 楼中楼通用归一化结构） */
interface BiliCommentItem {
  rpid: number;
  mid: number;
  name: string;
  avatar: string;
  content: string;
  /** 发布时间（秒级 Unix） */
  time: number;
  like: number;
  replyCount: number;
  /** 表情映射：键为 [名称] 原文，值为表情图 URL（前端经代理渲染） */
  emote: Record<string, string>;
  /** IP 属地（如「广东」，可能为空） */
  location: string;
}

/** reply/main 与 reply/reply 的原始回复结构（字段子集） */
interface BiliReplyRaw {
  rpid?: number;
  mid?: number;
  like?: number;
  rcount?: number;
  ctime?: number;
  member?: { uname?: string; avatar?: string };
  content?: {
    message?: string;
    emote?: Record<string, { url?: string }> | null;
  };
  reply_control?: { location?: string };
}

function mapBiliReplyItem(r: BiliReplyRaw): BiliCommentItem | null {
  if (!r || !r.rpid) return null;
  const emote: Record<string, string> = {};
  for (const [key, value] of Object.entries(r.content?.emote ?? {})) {
    if (value?.url) emote[key] = normalizeBilibiliImageUrl(value.url);
  }
  return {
    rpid: r.rpid,
    mid: r.mid ?? 0,
    name: r.member?.uname || '',
    avatar: normalizeBilibiliImageUrl(r.member?.avatar || ''),
    content: r.content?.message || '',
    time: r.ctime ?? 0,
    like: r.like ?? 0,
    replyCount: r.rcount ?? 0,
    emote,
    location: (r.reply_control?.location || '').replace(/^IP属地[:：]\s*/, ''),
  };
}

/** buvid3/buvid4 cookie 模块级缓存（finger/spi 一次拉取，进程内复用）。
 *  reply/main 缺 buvid 时命中 -352 风控 */
let buvidCookieCache = '';

async function getBuvidCookie(): Promise<string> {
  if (buvidCookieCache) return buvidCookieCache;
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: {
        'User-Agent': DEFAULT_PROXY_UA,
        Referer: 'https://www.bilibili.com',
      },
    });
    const json = (await res.json()) as {
      data?: { b_3?: string; b_4?: string };
    };
    if (json.data?.b_3) {
      buvidCookieCache = `buvid3=${json.data.b_3}`;
      if (json.data.b_4) buvidCookieCache += `; buvid4=${json.data.b_4}`;
    }
  } catch {
    // 静默：取不到时靠用户登录 cookie 兜底
  }
  return buvidCookieCache;
}

/** bvid → aid + 评论总数（10 分钟缓存；主楼/楼中楼分页都要 oid） */
const biliAidCache = new TtlCache<{ aid: number; reply: number }>({
  ttlMs: 10 * 60_000,
  maxSize: 128,
});

async function resolveBiliAid(
  bvid: string,
  cookie?: string,
): Promise<{ aid: number; reply: number }> {
  const cached = biliAidCache.get(bvid);
  if (cached) return cached;
  const info = await getVideoInfo(bvid, cookie);
  if (!info?.aid) throw new Error('视频不存在');
  const value = { aid: info.aid, reply: info.stat?.reply ?? 0 };
  biliAidCache.set(bvid, value);
  return value;
}

/** 组装评论请求 cookie：用户登录态 + buvid（游客风控） */
async function buildBiliCommentCookie(
  userId: string | number | undefined,
): Promise<{ cookie?: string; hasUserCookie: boolean }> {
  const userCookie = await getUserCookie(userId);
  const buvid = await getBuvidCookie();
  const cookie = [userCookie, buvid].filter(Boolean).join('; ') || undefined;
  return { cookie, hasUserCookie: !!userCookie };
}

// GET /bilibili/comments?bvid=&mode=&next=  主楼评论列表
// mode: 2=按时间（最新，游标分页）/ 3=按热度（热评，通常只取首页）
router.get('/bilibili/comments', async (req: AuthenticatedRequest, res) => {
  const bvid = typeof req.query.bvid === 'string' ? req.query.bvid.trim() : '';
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    res.status(400).json({ success: false, message: 'BV 号格式无效' });
    return;
  }
  const mode = req.query.mode === '3' ? '3' : '2';
  const nextRaw = Math.floor(Number(req.query.next));
  const next = Number.isFinite(nextRaw) && nextRaw > 0 ? nextRaw : 0;
  const userId = req.user?.userId;
  try {
    const { cookie, hasUserCookie } = await buildBiliCommentCookie(userId);
    const { aid, reply } = await resolveBiliAid(bvid, cookie);
    const { imgKey, subKey } = await getWbiKeys(cookie);
    const signed = signParams(
      {
        oid: String(aid),
        type: '1',
        mode,
        next: String(next),
        ps: '20',
        plat: '1',
        web_location: '1315875',
      },
      imgKey,
      subKey,
    );
    const body = await bilibiliFetch<{
      cursor?: { all_count?: number; next?: number; is_end?: boolean };
      replies?: BiliReplyRaw[] | null;
    }>(
      `https://api.bilibili.com/x/v2/reply/main?${new URLSearchParams(signed).toString()}`,
      { cookie },
    );
    const cursor = body.data?.cursor;
    const replies = (body.data?.replies ?? [])
      .map(mapBiliReplyItem)
      .filter((r): r is BiliCommentItem => r !== null);
    let nextCursor: number | null = null;
    if (cursor && !cursor.is_end && typeof cursor.next === 'number') {
      nextCursor = cursor.next;
    }
    res.json({
      success: true,
      total: cursor?.all_count ?? reply,
      replies,
      next: nextCursor,
      loginLimited: !hasUserCookie,
    });
  } catch (err) {
    console.error('[bilibili] comments error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取评论失败',
    });
  }
});

// GET /bilibili/comment-replies?bvid=&rpid=&pn=&ps=  楼中楼回复（pn 分页）
router.get(
  '/bilibili/comment-replies',
  async (req: AuthenticatedRequest, res) => {
    const bvid =
      typeof req.query.bvid === 'string' ? req.query.bvid.trim() : '';
    const rpid = Math.floor(Number(req.query.rpid));
    const pn = Math.max(Math.floor(Number(req.query.pn)) || 1, 1);
    const ps = Math.min(
      Math.max(Math.floor(Number(req.query.ps)) || 10, 1),
      20,
    );
    if (
      !/^BV[0-9A-Za-z]{10}$/.test(bvid) ||
      !Number.isFinite(rpid) ||
      rpid <= 0
    ) {
      res.status(400).json({ success: false, message: '参数无效' });
      return;
    }
    const userId = req.user?.userId;
    try {
      const { cookie } = await buildBiliCommentCookie(userId);
      const { aid } = await resolveBiliAid(bvid, cookie);
      const body = await bilibiliFetch<{
        page?: { count?: number };
        replies?: BiliReplyRaw[] | null;
      }>(
        `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${rpid}&pn=${pn}&ps=${ps}`,
        { cookie },
      );
      const replies = (body.data?.replies ?? [])
        .map(mapBiliReplyItem)
        .filter((r): r is BiliCommentItem => r !== null);
      res.json({
        success: true,
        total: body.data?.page?.count ?? 0,
        replies,
      });
    } catch (err) {
      console.error('[bilibili] comment-replies error:', err);
      res.status(502).json({
        success: false,
        message: err instanceof Error ? err.message : '获取回复失败',
      });
    }
  },
);


/** 标签链路（search_type=tag / tag/videos）失败后的冷却期：
 *  连续失败多半是风控/接口下线，60s 内直接跳过标签尝试，避免每个分类都触发 */
let tagChainBlockedUntil = 0;

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
