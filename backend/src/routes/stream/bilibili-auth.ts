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
import {
  saveCredential,
  clearCredential,
} from '../../services/bilibili/credential';
import {
  getCachedUserInfo,
  setCachedUserInfo,
  invalidateUserInfo,
} from '../../services/bilibili/cache';
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

export default router;
