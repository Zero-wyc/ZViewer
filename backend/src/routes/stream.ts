import { Router, Request, Response } from 'express';
import { Readable } from 'node:stream';
import QRCode from 'qrcode';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import { getVideoInfo } from '../services/bilibili/video';
import { getDanmaku } from '../services/bilibili/danmaku';
import { bilibiliFetch } from '../services/bilibili/client';
import {
  getCredential,
  saveCredential,
  clearCredential,
} from '../services/bilibili/credential';
import {
  resolveBilibiliVideo,
  extractBvid,
  normalizeResolveError,
  type ResolveProgress,
} from '../services/bilibili/resolver';
import {
  getCachedUserInfo,
  setCachedUserInfo,
  invalidateUserInfo,
} from '../services/bilibili/cache';
import { statFTPFile, createFTPReadStream } from '../services/ftp';

const router = Router();

interface BilibiliQrGenerateResponse {
  data?: {
    url: string;
    qrcode_key: string;
  };
}

interface BilibiliQrPollResponse {
  data?: {
    qrcode_key?: string;
    status?: number;
    code?: number;
    message?: string;
    url?: string;
    refresh_token?: string;
    timestamp?: number;
  };
}

async function getUserCookie(
  userId: string | number | undefined,
): Promise<string | null> {
  if (userId === undefined || userId === null) return null;
  const credential = await getCredential(String(userId));
  return credential?.cookie ?? null;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 用户信息缓存 TTL，由 cache.ts 统一管理，此处仅用于路由层决策。 */
const USER_INFO_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 从响应头中提取 Set-Cookie 中的 Cookie 名值对，合并为单一字符串。
 */
function parseSetCookieHeader(headers: Headers): string {
  const getSetCookies = (headers as unknown as { getSetCookies?: () => string[] })
    .getSetCookies;
  let values: string[] = [];

  if (typeof getSetCookies === 'function') {
    values = getSetCookies.call(headers);
  } else {
    const single = headers.get('set-cookie');
    if (single) {
      values = single.split(',').map((s) => s.trim());
    }
  }

  return values
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

/**
 * 解析响应头中的 Set-Cookie，返回 name -> value 的 Map（只保留名值对）。
 */
function parseSetCookieToMap(headers: Headers): Map<string, string> {
  const getSetCookies = (headers as unknown as { getSetCookies?: () => string[] })
    .getSetCookies;
  let values: string[] = [];

  if (typeof getSetCookies === 'function') {
    values = getSetCookies.call(headers);
  } else {
    const single = headers.get('set-cookie');
    if (single) {
      values = single.split(',').map((s) => s.trim());
    }
  }

  const map = new Map<string, string>();
  for (const cookie of values) {
    const [nameValue] = cookie.split(';');
    const trimmed = nameValue.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const name = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      map.set(name, value);
    }
  }
  return map;
}

function cookieMapToString(map: Map<string, string>): string {
  const parts: string[] = [];
  map.forEach((value, name) => {
    parts.push(`${name}=${value}`);
  });
  return parts.join('; ');
}

/**
 * 将 B站 返回的图片地址统一补全为 HTTPS 完整 URL。
 * B站 部分接口会返回以 // 开头的协议相对地址或 http:// 地址，直接使用会导致前端/代理解析失败。
 */
function normalizeBilibiliImageUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

/**
 * 从 B站 Cookie 中提取当前登录用户的 mid（DedeUserID）。
 */
function extractMidFromCookie(cookie: string): string | null {
  const match = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
  return match?.[1] ?? null;
}

/**
 * 访问二维码登录成功后返回的跨域 URL，手动跟随重定向链并收集所有 Set-Cookie。
 */
async function fetchCookiesFromSsoUrl(ssoUrl: string): Promise<string | null> {
  try {
    const cookieMap = new Map<string, string>();
    let currentUrl = ssoUrl;
    const seenUrls = new Set<string>();
    const maxRedirects = 10;

    for (let i = 0; i <= maxRedirects; i++) {
      if (seenUrls.has(currentUrl)) {
        console.warn('[bilibili] sso redirect loop detected at', currentUrl);
        break;
      }
      seenUrls.add(currentUrl);

      const res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Referer: 'https://www.bilibili.com',
          ...(cookieMap.size > 0
            ? { Cookie: cookieMapToString(cookieMap) }
            : {}),
        },
      });

      const setCookies = parseSetCookieToMap(res.headers);
      for (const [name, value] of setCookies) {
        cookieMap.set(name, value);
      }

      const location = res.headers.get('location');
      if (!location) {
        break;
      }

      currentUrl = new URL(location, currentUrl).toString();
      if (res.status < 300 || res.status >= 400) {
        break;
      }
    }

    const requiredCookies = ['SESSDATA', 'bili_jct', 'DedeUserID'];
    const missing = requiredCookies.filter((name) => !cookieMap.has(name));
    if (missing.length > 0) {
      console.warn(
        '[bilibili] sso cookie missing required keys:',
        missing.join(', '),
      );
      return null;
    }

    const cookie = cookieMapToString(cookieMap);
    console.log(
      '[bilibili] sso cookie collected, keys:',
      Array.from(cookieMap.keys()).join(', '),
    );
    return cookie;
  } catch (err) {
    console.error('[bilibili] fetch sso url error:', err);
    return null;
  }
}

interface BilibiliNavData {
  isLogin?: boolean;
  mid?: number;
  uname?: string;
  face?: string;
  vipStatus?: number;
  vipType?: number;
}

/**
 * 使用给定 Cookie 调用 B站 nav 接口验证登录状态并缓存用户信息。
 */
async function validateCookieAndCacheUserInfo(
  cookie: string,
  userId: string,
): Promise<{ valid: boolean; name?: string; avatar?: string; mid?: number }> {
  try {
    const nav = await bilibiliFetch<BilibiliNavData>(
      'https://api.bilibili.com/x/web-interface/nav',
      { cookie },
    );

    if (!nav.data.isLogin) {
      console.warn('[bilibili] cookie validation failed: isLogin=false');
      return { valid: false };
    }

    const name = nav.data.uname || '';
    const avatar = normalizeBilibiliImageUrl(nav.data.face || '');
    const mid = nav.data.mid;
    const vipStatus = nav.data.vipStatus;
    const vipType = nav.data.vipType;
    setCachedUserInfo(userId, {
      name,
      avatar,
      mid,
      vipStatus,
      vipType,
    });

    return { valid: true, name, avatar, mid };
  } catch (err) {
    console.error('[bilibili] cookie validation error:', err);
    return { valid: false };
  }
}

// 公共图片代理：B站 CDN 图片需要 referer，且 img 标签无法携带认证头，
// 因此提供免认证的 B站 图片代理，仅允许 bilibili 域名的图片地址。
router.get('/proxy-image', async (req: Request, res: Response) => {
  const url = req.query.url;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少 url 参数' });
    return;
  }

  const trimmedUrl = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    res.status(400).json({ success: false, message: '非法的 URL' });
    return;
  }

  const allowedImageDomains = [
    'bilibili.com',
    'hdslb.com',
    'bilivideo.com',
    'biliimg.com',
  ];
  const isAllowed = allowedImageDomains.some((domain) => {
    return (
      parsed.hostname === domain ||
      parsed.hostname.endsWith(`.${domain}`)
    );
  });
  if (!isAllowed) {
    res.status(403).json({ success: false, message: '仅允许 B站 域名图片' });
    return;
  }

  try {
    const upstream = await fetch(trimmedUrl, {
      headers: {
        Referer: 'https://www.bilibili.com',
        'User-Agent': DEFAULT_USER_AGENT,
      },
    });

    if (!upstream.ok) {
      res.status(upstream.status);
      res.end();
      return;
    }

    const contentType = upstream.headers.get('content-type');
    res.setHeader('Content-Type', contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (upstream.body) {
      Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (err) {
    console.error('[stream] proxy-image error:', err);
    res.status(502).json({ success: false, message: '代理图片失败' });
  }
});

// 所有 B站 相关接口需要登录后才能使用
router.use(authenticateToken);

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
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
  const userId = req.user?.userId;
  res.json({ success: true, loggedIn: !!(await getUserCookie(userId)) });
});

// 退出 B站登录
router.post('/bilibili/logout', async (req: AuthenticatedRequest, res) => {
  const userId = req.user?.userId;
  if (userId !== undefined && userId !== null) {
    const userIdStr = String(userId);
    await clearCredential(userIdStr);
    invalidateUserInfo(userIdStr);
  }
  res.json({ success: true, message: '已退出登录' });
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
  const cached = getCachedUserInfo(userIdStr);
  if (cached && Date.now() - cached.cachedAt < USER_INFO_CACHE_TTL_MS) {
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
router.get('/bilibili/following-bangumi', async (req: AuthenticatedRequest, res) => {
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
router.get('/bilibili/bangumi-episodes', async (req: AuthenticatedRequest, res) => {
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

interface ResolveProgressMessage {
  success?: boolean;
  status: 'parsing' | 'done' | 'error';
  step?: string;
  message?: string;
  code?: string;
  title?: string;
  duration?: number;
  cid?: number;
  videoUrl?: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  format?: 'dash' | 'mp4';
  loggedIn?: boolean;
  vipStatus?: number;
  currentQn?: number;
  acceptQuality?: { id: number; label: string; resolution?: string }[];
}

router.get('/resolve-bilibili', async (req: AuthenticatedRequest, res) => {
  const url = req.query.url;
  const userId = req.user?.userId;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少视频链接' });
    return;
  }

  // 提前校验 BV 号，避免进入流式响应后才返回 400
  if (!extractBvid(url)) {
    res.status(400).json({ success: false, message: '无法解析 B站 BV 号' });
    return;
  }

  const qn =
    typeof req.query.qn === 'string' && req.query.qn.trim()
      ? Number(req.query.qn.trim())
      : undefined;

  const fnval =
    typeof req.query.fnval === 'string' && req.query.fnval.trim()
      ? Number(req.query.fnval.trim())
      : undefined;

  const preferCdn =
    typeof req.query.preferCdn === 'string' && req.query.preferCdn.trim()
      ? req.query.preferCdn.trim()
      : undefined;

  // 启用 NDJSON 流式响应，让前端实时看到解析进度
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  // 流式错误响应使用短连接，避免浏览器因 keep-alive 连接被服务端提前关闭而报 abort
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (payload: ResolveProgressMessage) => {
    res.write(JSON.stringify(payload) + '\n');
    if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
      (res as unknown as { flush: () => void }).flush();
    }
  };

  const sendError = (message: string, code?: string) => {
    send({ success: false, status: 'error', message, code });
    res.end();
  };

  const cookie = (await getUserCookie(userId)) || undefined;
  console.log('[bilibili] resolve-bilibili, cookie present:', !!cookie);

  try {
    const result = await resolveBilibiliVideo({
      url,
      userId: userId !== undefined ? String(userId) : undefined,
      cookie,
      qn,
      fnval,
      preferCdn,
      onProgress: (msg: ResolveProgress) => {
        send({ status: msg.status, step: msg.step, message: msg.message });
      },
    });

    send({
      success: true,
      status: 'done',
      title: result.title,
      duration: result.duration,
      cid: result.cid,
      videoUrl: result.videoUrl,
      audioUrl: result.audioUrl,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      format: result.format,
      loggedIn: result.loggedIn,
      vipStatus: result.vipStatus,
      currentQn: result.currentQn,
      acceptQuality: result.acceptQuality,
    });
    res.end();
  } catch (err) {
    console.error('[bilibili] resolve-bilibili error:', err);
    const normalized = normalizeResolveError(err);
    sendError(normalized.message, normalized.code);
  }
});

router.get('/bilibili/danmaku', async (req: AuthenticatedRequest, res) => {
  const cid = req.query.cid;
  const bvidRaw = req.query.bvid;

  let effectiveCid: number | undefined;

  if (typeof cid === 'string' && cid.trim()) {
    effectiveCid = Number(cid);
  } else if (typeof bvidRaw === 'string' && bvidRaw.trim()) {
    const bvid = extractBvid(bvidRaw.trim());
    if (!bvid) {
      res.status(400).json({ success: false, message: '无法解析 BV 号' });
      return;
    }
    try {
      const info = await getVideoInfo(bvid);
      if (!info) {
        res.status(500).json({ success: false, message: '获取视频信息失败' });
        return;
      }
      effectiveCid = info.cid;
    } catch (err) {
      console.error('[bilibili] danmaku video info error:', err);
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : '获取 B站 视频信息失败',
      });
      return;
    }
  }

  if (!effectiveCid) {
    res.status(400).json({ success: false, message: '缺少 cid 或 bvid 参数' });
    return;
  }

  try {
    const danmaku = await getDanmaku(effectiveCid);
    res.json({ success: true, danmaku });
  } catch (err) {
    console.error('[bilibili] danmaku fetch error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '解析 B站 弹幕失败',
    });
  }
});

function buildProxyUrl(req: AuthenticatedRequest, type: string, params: Record<string, string>): string {
  const protocol = req.protocol;
  const host = req.get('host') || 'localhost';
  const query = new URLSearchParams(params).toString();
  return `${protocol}://${host}/api/stream/proxy-${type}?${query}`;
}

// WebDAV 解析（已迁移到 /api/webdav/resolve，保留 301 重定向以兼容旧客户端）
router.get('/resolve-webdav', (req, res) => {
  const { serverUrl, path, username, password } = req.query;
  const params = new URLSearchParams();
  if (serverUrl) params.set('serverUrl', serverUrl as string);
  if (path) params.set('path', path as string);
  if (username) params.set('username', username as string);
  if (password) params.set('password', password as string);
  res.redirect(301, `/api/webdav/resolve?${params.toString()}`);
});

// WebDAV 流式代理（已迁移到 /api/webdav/proxy，保留 301 重定向以兼容旧客户端）
router.get('/proxy-webdav', (req, res) => {
  const { serverUrl, path, username, password } = req.query;
  const params = new URLSearchParams();
  if (serverUrl) params.set('serverUrl', serverUrl as string);
  if (path) params.set('path', path as string);
  if (username) params.set('username', username as string);
  if (password) params.set('password', password as string);
  res.redirect(301, `/api/webdav/proxy?${params.toString()}`);
});

// FTP 解析
router.get('/resolve-ftp', async (req: AuthenticatedRequest, res: Response) => {
  const serverUrl = req.query.serverUrl;
  const path = req.query.path;
  const username = req.query.username;
  const password = req.query.password;
  const port = req.query.port;

  if (typeof serverUrl !== 'string' || !serverUrl.trim() || typeof path !== 'string' || !path.trim()) {
    res.status(400).json({ success: false, message: '缺少服务器地址或路径' });
    return;
  }

  try {
    const info = await statFTPFile({
      serverUrl: serverUrl.trim(),
      path: path.trim(),
      username: typeof username === 'string' ? username : undefined,
      password: typeof password === 'string' ? password : undefined,
      port: typeof port === 'string' && port.trim() ? Number(port.trim()) : undefined,
    });

    const proxyUrl = buildProxyUrl(req, 'ftp', {
      serverUrl: serverUrl.trim(),
      path: path.trim(),
      username: typeof username === 'string' ? username : '',
      password: typeof password === 'string' ? password : '',
      port: typeof port === 'string' && port.trim() ? port.trim() : '21',
    });

    res.json({
      success: true,
      title: info.name,
      videoUrl: proxyUrl,
      format: 'mp4',
      duration: 0,
    });
  } catch (err) {
    console.error('[stream] resolve-ftp error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '解析 FTP 文件失败',
    });
  }
});

// FTP 流式代理
router.get('/proxy-ftp', async (req: AuthenticatedRequest, res: Response) => {
  const serverUrl = req.query.serverUrl;
  const path = req.query.path;
  const username = req.query.username;
  const password = req.query.password;
  const port = req.query.port;

  if (typeof serverUrl !== 'string' || !serverUrl.trim() || typeof path !== 'string' || !path.trim()) {
    res.status(400).json({ success: false, message: '缺少服务器地址或路径' });
    return;
  }

  try {
    const stream = createFTPReadStream({
      serverUrl: serverUrl.trim(),
      path: path.trim(),
      username: typeof username === 'string' ? username : undefined,
      password: typeof password === 'string' ? password : undefined,
      port: typeof port === 'string' && port.trim() ? Number(port.trim()) : undefined,
    });

    res.setHeader('Content-Type', 'video/mp4');
    stream.on('error', (err) => {
      console.error('[stream] proxy-ftp stream error:', err);
      if (!res.headersSent) {
        res.status(502).json({ success: false, message: 'FTP 代理失败' });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[stream] proxy-ftp error:', err);
    res.status(502).json({ success: false, message: 'FTP 代理失败' });
  }
});

// OpenList 解析（已迁移到 /api/openlist/resolve，保留 301 重定向以兼容旧客户端）
router.get('/resolve-openlist', (req, res) => {
  const url = req.query.url;
  res.redirect(301, `/api/openlist/resolve?url=${encodeURIComponent(url as string)}`);
});

// OpenList 代理（已迁移到 /api/openlist/proxy，保留 301 重定向以兼容旧客户端）
router.get('/proxy-openlist', (req, res) => {
  const url = req.query.url;
  res.redirect(301, `/api/openlist/proxy?url=${encodeURIComponent(url as string)}`);
});

// 媒体代理：绕过浏览器对 B站 CDN 的 Referer/UA 限制
router.get('/proxy', async (req: AuthenticatedRequest, res: Response) => {
  const url = req.query.url;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少 url 参数' });
    return;
  }

  try {
    const range = req.headers.range;
    const upstream = await fetch(url, {
      headers: {
        Referer: 'https://www.bilibili.com',
        Origin: 'https://www.bilibili.com',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(range ? { Range: range } : {}),
      },
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Range',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');

    if (!upstream.ok) {
      res.status(upstream.status);
      res.end();
      return;
    }

    const contentType = upstream.headers.get('content-type');
    res.setHeader('Content-Type', contentType || 'video/mp4');

    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) {
      res.setHeader('Accept-Ranges', acceptRanges);
    }
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    if (upstream.body) {
      Readable.fromWeb(upstream.body as unknown as import('node:stream/web').ReadableStream).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (err) {
    console.error('[stream] proxy error:', err);
    res.status(502).json({ success: false, message: '代理媒体失败' });
  }
});

export default router;
