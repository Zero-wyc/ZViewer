/**
 * B站 扫码登录与账号信息路由（需登录态，由父路由统一 authenticateToken）。
 *
 *   GET  /bilibili/qr                 获取登录二维码
 *   GET  /bilibili/qr/poll            轮询扫码状态
 *   GET  /bilibili/login-status       查询登录状态
 *   GET  /bilibili/cookie             获取当前绑定的 B站 Cookie
 *   POST /bilibili/cookie-login       手动粘贴 Cookie 登录
 *   POST /bilibili/logout             退出登录
 *   GET  /bilibili/user-info          当前账号信息
 */

import { Router } from 'express';
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

export default router;
