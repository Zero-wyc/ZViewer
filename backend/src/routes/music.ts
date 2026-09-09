/**
 * 一起听（Listen Together）音乐模块 REST 路由。
 *
 * 挂载在 /api/music 下，提供以下端点：
 * - ANY  /api/music/ncm/*       通用转发：注入当前用户持久化的网易云 cookie，
 *                               转发到内部 NCM API 服务（127.0.0.1），浏览器不直连网易云
 * - GET  /api/music/login/status 查询当前用户的网易云登录状态
 * - POST /api/music/logout       删除当前用户持久化的网易云凭证
 * - GET  /api/music/stream       音频流代理：先调 /song/url/v1 解析直链
 *                               （含音质降级链），校验直链域名后流式转发（支持 Range/206）
 *
 * 鉴权模型：可选鉴权——携带有效 token 时注入 req.user（登录态转发用），
 * 未登录 / 游客（userId=0）也放行，以匿名（无 cookie）方式调用 NCM API。
 * 游客不持久化凭证（userId 唯一索引，避免全部游客共享同一份 cookie）。
 */
import { Router, type Response, type NextFunction } from 'express';
import { Readable } from 'node:stream';
import { AppDataSource } from '../data-source';
import { NcmCredential } from '../entities/NcmCredential';
import { Room } from '../entities/Room';
import {
  type AuthenticatedRequest,
  extractAccessToken,
  getTokenInvalidBefore,
  verifyAccessToken,
} from '../middleware/auth';
import { getNcmApiBase } from '../modules/music/ncm-api.service';
import { DEFAULT_PROXY_UA } from '../services/proxy/http-proxy';

const router = Router();

// ==================== 可选鉴权 ====================

/**
 * 可选鉴权中间件：携带有效 token 时注入 req.user；未登录 / token 无效时
 * 按匿名放行（音乐功能对游客开放，仅免费歌曲可播）。
 *
 * 与 authenticateToken 的区别：无 token / token 失效不返回 401 而是继续处理。
 * token 失效检查（改密后吊销）逻辑与 authenticateToken 保持一致。
 */
function optionalAuth(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const token = extractAccessToken(req);
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    if (payload.userId !== 0) {
      const invalidBefore = getTokenInvalidBefore(payload.userId);
      const iat = payload.iat;
      if (
        invalidBefore !== null &&
        typeof iat === 'number' &&
        iat * 1000 < invalidBefore
      ) {
        // 已被吊销的 token 按匿名处理
        return next();
      }
    }
    req.user = payload;
  } catch {
    // token 无效按匿名处理
  }
  next();
}

router.use(optionalAuth);

// ==================== Cookie 工具 ====================

/** 从 Set-Cookie 原始串提取 cookie 名（首个 = 之前的部分） */
function cookieName(setCookie: string): string {
  const eq = setCookie.indexOf('=');
  return (eq > 0 ? setCookie.slice(0, eq) : setCookie).trim();
}

/** 将持久化的 cookie JSON 数组转为请求头格式（仅取 name=value 部分，以 "; " 连接） */
function toCookieHeader(cookiesRaw: string): string {
  try {
    const arr = JSON.parse(cookiesRaw) as unknown;
    if (!Array.isArray(arr)) return '';
    return arr
      .filter((c): c is string => typeof c === 'string' && c.length > 0)
      .map((c) => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  } catch {
    return '';
  }
}

/** 将新 Set-Cookie 数组合并进既有数组（按 cookie 名去重，新值覆盖旧值） */
function mergeCookies(existing: string[], incoming: string[]): string[] {
  const map = new Map<string, string>();
  for (const c of [...existing, ...incoming]) {
    if (typeof c !== 'string' || !c) continue;
    map.set(cookieName(c), c);
  }
  return Array.from(map.values());
}

/** 读取当前用户的持久化凭证（游客 / 未登录返回 null） */
async function loadCredential(
  userId: number | undefined,
): Promise<NcmCredential | null> {
  if (!userId || userId <= 0) return null;
  return AppDataSource.getRepository(NcmCredential).findOneBy({ userId });
}

/** 从 NCM 响应体提取网易云账号资料（兼容 body.profile 与 body.data.profile 两种结构） */
function extractProfile(
  body: unknown,
): { nickname: string | null; avatarUrl: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  let raw: unknown = b.profile;
  if (
    (!raw || typeof raw !== 'object') &&
    b.data &&
    typeof b.data === 'object'
  ) {
    raw = (b.data as Record<string, unknown>).profile;
  }
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const nickname = typeof p.nickname === 'string' ? p.nickname : null;
  const avatarUrl = typeof p.avatarUrl === 'string' ? p.avatarUrl : null;
  if (!nickname && !avatarUrl) return null;
  return { nickname, avatarUrl };
}

/**
 * 将合并后的 cookie 持久化到 NcmCredential（同时更新昵称/头像缓存）。
 * 仅在响应携带登录态 cookie（MUSIC_U / __csrf）时调用。
 */
async function persistCookies(
  userId: number,
  mergedCookies: string[],
  body: unknown,
): Promise<void> {
  const repo = AppDataSource.getRepository(NcmCredential);
  const profile = extractProfile(body);
  const existing = await repo.findOneBy({ userId });
  if (existing) {
    existing.cookies = JSON.stringify(mergedCookies);
    if (profile?.nickname) existing.nickname = profile.nickname;
    if (profile?.avatarUrl) existing.avatarUrl = profile.avatarUrl;
    await repo.save(existing);
  } else {
    await repo.save(
      repo.create({
        userId,
        cookies: JSON.stringify(mergedCookies),
        nickname: profile?.nickname ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
      }),
    );
  }
}

/** 判断 Set-Cookie 列表是否包含登录态 cookie（MUSIC_U / __csrf） */
function hasLoginCookies(setCookies: string[]): boolean {
  return setCookies.some((c) => {
    const name = cookieName(c).toLowerCase();
    return name === 'music_u' || name.includes('csrf');
  });
}

// ==================== 内部 NCM API 调用 ====================

/** 内部 NCM API 调用结果 */
interface NcmCallResult {
  status: number;
  body: unknown;
  setCookies: string[];
}

/**
 * 以 GET 方式调用内部 NCM API 并解析 JSON 响应。
 *
 * 每次请求附加 timestamp 参数：内部服务挂有 2 分钟的 apicache 中间件，
 * 缓存 key 仅含 method+URL（不含 cookie），不同登录态的相同 URL 会命中
 * 同一缓存导致串味（匿名结果被 VIP 用户拿到），必须以唯一 URL 绕过。
 */
async function callNcmApi(
  path: string,
  cookieHeader: string,
): Promise<NcmCallResult> {
  const timestamp = Date.now();
  const url = `${getNcmApiBase()}${path}${path.includes('?') ? '&' : '?'}timestamp=${timestamp}`;
  const upstream = await fetch(url, {
    method: 'GET',
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
  const setCookies = upstream.headers.getSetCookie();
  const text = await upstream.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: upstream.status, body, setCookies };
}

// ==================== 通用转发 /api/music/ncm/* ====================

/**
 * 通用转发：/api/music/ncm/<ncm-path> → 内部服务 <ncm-path>。
 *
 * - 方法白名单：仅允许 GET/POST（防任意方法透传到上游）
 * - 注入当前用户 cookie（已登录时）；剥离 query/body 中的 cookie/noCookie
 *   参数，避免客户端覆盖服务端注入的登录态
 * - 响应 Set-Cookie 含 MUSIC_U / __csrf 时，合并后的 cookie 持久化
 *   （扫码登录成功、cookie 自动刷新等场景）
 * - 附加 timestamp 绕过内部服务的 apicache（见 callNcmApi 注释）
 */
router.use(
  '/ncm',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res
        .status(405)
        .json({ code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET/POST 转发' });
      return;
    }

    const base = getNcmApiBase();
    if (!base) {
      res
        .status(503)
        .json({ code: 'NCM_UNAVAILABLE', message: 'NCM 服务未启动' });
      return;
    }

    try {
      // req.url 为去掉 /ncm 挂载前缀后的剩余部分（含 query）
      const rawUrl = req.url || '/';
      const queryIndex = rawUrl.indexOf('?');
      const rawPath = queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl;
      const rawQuery = queryIndex >= 0 ? rawUrl.slice(queryIndex + 1) : '';
      const ncmPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

      const params = new URLSearchParams(rawQuery);
      params.delete('cookie');
      params.delete('noCookie');
      // 唯一化 URL 绕过内部服务 apicache（避免不同登录态共享缓存）
      params.set('timestamp', String(Date.now()));
      const target = `${base}${ncmPath}?${params.toString()}`;

      // POST body 透传（剥离 cookie/noCookie 字段）
      let bodyPayload: unknown = undefined;
      if (req.method === 'POST') {
        const raw = req.body;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const copy = { ...(raw as Record<string, unknown>) };
          delete copy.cookie;
          delete copy.noCookie;
          bodyPayload = copy;
        } else if (raw !== undefined) {
          bodyPayload = raw;
        }
      }

      // 注入当前用户持久化的网易云 cookie。
      // 扫码登录三接口（key/create/check）必须在无 cookie 的干净上下文调用：
      // 网易云以请求携带的 cookie 判定当前登录态，注入旧凭据（尤其是已过期
      // 的 MUSIC_U）会让登录二维码轮询异常（800 循环）导致扫码无效；
      // check 成功（803）响应的 Set-Cookie 仍走下方持久化逻辑正常落库。
      const isQrLoginPath =
        ncmPath === '/login/qr/key' ||
        ncmPath === '/login/qr/create' ||
        ncmPath === '/login/qr/check';
      const credential = isQrLoginPath
        ? null
        : await loadCredential(req.user?.userId);
      const cookieHeader = credential ? toCookieHeader(credential.cookies) : '';

      const upstream = await fetch(target, {
        method: req.method,
        redirect: 'manual',
        headers: {
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(bodyPayload !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        body:
          req.method === 'POST' && bodyPayload !== undefined
            ? JSON.stringify(bodyPayload)
            : undefined,
      });

      // 上游重定向（如 /song/url/v1_302）：不跟随音频直链，以 JSON 形式回传地址
      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location');
        res.status(200).json({ code: 'REDIRECT', location });
        return;
      }

      const setCookies = upstream.headers.getSetCookie();
      const text = await upstream.text();
      let body: unknown = null;
      let parsed = false;
      try {
        body = text ? JSON.parse(text) : null;
        parsed = true;
      } catch {
        body = null;
      }

      if (!parsed) {
        console.warn(
          `[music] ncm 转发响应非 JSON: ${req.method} ${ncmPath} → ${upstream.status}`,
        );
        res.status(502).json({
          code: 'UPSTREAM_ERROR',
          message: 'NCM 服务返回了无法解析的响应',
        });
        return;
      }

      // 登录态 cookie 变化时持久化（仅正式用户；游客 userId=0 不持久化）
      const userId = req.user?.userId ?? 0;
      if (
        userId > 0 &&
        setCookies.length > 0 &&
        hasLoginCookies(setCookies)
      ) {
        const existing = credential
          ? (() => {
              try {
                const arr = JSON.parse(credential.cookies) as unknown;
                return Array.isArray(arr)
                  ? arr.filter((c): c is string => typeof c === 'string')
                  : [];
              } catch {
                return [];
              }
            })()
          : [];
        await persistCookies(userId, mergeCookies(existing, setCookies), body);
      }

      res.status(upstream.status).json(body);
    } catch (err) {
      console.error('[music] ncm 转发失败:', err);
      res
        .status(502)
        .json({ code: 'UPSTREAM_ERROR', message: 'NCM 服务请求失败' });
    }
  },
);

// ==================== 登录状态 / 退出 ====================

/** GET /api/music/login/status - 查询当前用户的网易云登录状态 */
router.get(
  '/login/status',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      let credential = await loadCredential(req.user?.userId);
      // 扫码登录落库时响应不含账号资料（/login/qr/check 只返回 code），
      // 旧凭据可能缺昵称/头像：用凭据 cookie 实时调 /user/account 补全并回写
      if (credential && (!credential.nickname || !credential.avatarUrl)) {
        try {
          const cookieHeader = toCookieHeader(credential.cookies);
          if (cookieHeader) {
            const { body } = await callNcmApi('/user/account', cookieHeader);
            const profile = extractProfile(body);
            if (profile) {
              credential.nickname = profile.nickname ?? credential.nickname;
              credential.avatarUrl = profile.avatarUrl ?? credential.avatarUrl;
              await AppDataSource.getRepository(NcmCredential).save(
                credential,
              );
            }
          }
        } catch (err) {
          console.warn('[music] login/status 账号资料补全失败:', err);
        }
      }
      res.json({
        loggedIn: !!credential,
        nickname: credential?.nickname ?? null,
        avatarUrl: credential?.avatarUrl ?? null,
      });
    } catch (err) {
      console.error('[music] login/status error:', err);
      res
        .status(500)
        .json({ code: 'INTERNAL_ERROR', message: '查询登录状态失败' });
    }
  },
);

/** POST /api/music/logout - 删除当前用户持久化的网易云凭证 */
router.post(
  '/logout',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user?.userId ?? 0;
      if (userId > 0) {
        await AppDataSource.getRepository(NcmCredential).delete({ userId });
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[music] logout error:', err);
      res.status(500).json({ code: 'INTERNAL_ERROR', message: '退出登录失败' });
    }
  },
);

// ==================== 音频流代理 ====================

/**
 * 音质降级链（从高到低）：请求音质起依次降级直至解析出可用直链。
 * 与 spec 一致：后端默认 exhigh，VIP 可播时向上尝试 lossless。
 */
const QUALITY_CHAIN = ['lossless', 'exhigh', 'higher', 'standard'] as const;

/** 音频流转发缓冲区大小（与 serverFiles 的 STREAM_HIGH_WATER_MARK 一致） */
const AUDIO_STREAM_HIGH_WATER_MARK = 1024 * 1024;

/** 网易云音频 CDN 域名白名单（防 SSRF：直链必须位于 *.music.126.net） */
function isNcmAudioHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'music.126.net' || host.endsWith('.music.126.net');
}

/** 提取 /song/url/v1 响应中 data[0]（失败返回 null） */
function extractSongUrlData(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0];
  return first && typeof first === 'object'
    ? (first as Record<string, unknown>)
    : null;
}

/**
 * 流式转发音频：透传 Range 请求头，返回 206/200，
 * 透传 Content-Range / Content-Length / Content-Type / Accept-Ranges。
 * 参考services/proxy/http-proxy.ts 的管道转发模式（此处为上游 HTTP 流）。
 */
async function proxyAudioStream(
  req: AuthenticatedRequest,
  res: Response,
  audioUrl: string,
): Promise<void> {
  // 客户端断连时中断上游请求，避免无效带宽消耗
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  // Range 头归一：极端场景下 req.headers.range 可能是 string[]（重复头）
  const rangeValue = Array.isArray(req.headers.range)
    ? req.headers.range[0]
    : req.headers.range;

  // fetch 的响应类型（express 的 Response 与全局 Response 同名，此处用推断类型消歧）
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(audioUrl, {
      headers: {
        'User-Agent': DEFAULT_PROXY_UA,
        Accept: '*/*',
        ...(rangeValue ? { Range: rangeValue } : {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort && res.writableEnded) return;
    console.error('[music] 音频流上游请求失败:', err);
    if (!res.headersSent) {
      res
        .status(502)
        .json({ code: 'UPSTREAM_ERROR', message: '音频源请求失败' });
    } else {
      res.end();
    }
    return;
  }

  // 上游非 2xx：透传状态码（如 416 的 Content-Range 语义）
  if (!upstream.ok) {
    res.status(upstream.status);
    for (const name of [
      'content-range',
      'accept-ranges',
      'content-length',
    ] as const) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.end();
    return;
  }

  // 转发上游状态码：Range 请求上游返回 206 时必须转发 206
  res.status(upstream.status);
  res.setHeader(
    'Content-Type',
    upstream.headers.get('content-type') || 'audio/mpeg',
  );
  for (const name of [
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ] as const) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  // 确保浏览器知道支持 Range 请求（否则会整文件下载而非流式播放）
  if (!res.getHeader('accept-ranges')) {
    res.setHeader('Accept-Ranges', 'bytes');
  }
  // 提示反向代理不要缓冲整个响应体
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'no-transform');

  if (!upstream.body) {
    res.end();
    return;
  }

  const stream = Readable.fromWeb(
    upstream.body as unknown as import('node:stream/web').ReadableStream,
    { highWaterMark: AUDIO_STREAM_HIGH_WATER_MARK },
  );
  stream.on('error', (err: Error) => {
    console.error('[music] 音频流上游中断:', err);
    if (!res.headersSent) {
      res
        .status(502)
        .json({ code: 'UPSTREAM_ERROR', message: '音频流转发中断' });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/**
 * GET /api/music/stream?songId=&level=&roomId= - 音频流代理。
 *
 * 1. 凭证回退链（spec「房主登录后全房间可播 VIP」）：
 *    当前用户有 NcmCredential 用之；否则请求带 roomId 时查 Room 表
 *    ownerUserId，房主有凭证则借用其凭证解析。stream 请求来自 <audio>
 *    标签无法携带 Authorization 头，token 从 query 读取（optionalAuth），
 *    观众未登录/无凭证时经 roomId 仍可播 VIP 曲目。
 * 2. 以解析到的 cookie（或匿名）调内部服务 /song/url/v1 解析直链，
 *    url 为 null 时沿降级链 lossless→exhigh→higher→standard 依次重试
 *    （从请求 level 开始；带 freeTrialInfo 的试听直链视为不可用）
 * 3. 全链失败时错误分类：freeTrialInfo → VIP_REQUIRED；
 *    /check/music 判定无版权 → NO_COPYRIGHT；其余 → RESOLVE_FAILED
 * 4. 直链 hostname 必须匹配 *.music.126.net（防 SSRF），否则 RESOLVE_FAILED
 * 5. 流式转发（Range/206 透传）
 */
router.get(
  '/stream',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const songId = Number(req.query.songId);
    if (!Number.isInteger(songId) || songId <= 0) {
      res
        .status(400)
        .json({ code: 'INVALID_PARAMS', message: 'songId 参数无效' });
      return;
    }

    const base = getNcmApiBase();
    if (!base) {
      res
        .status(503)
        .json({ code: 'NCM_UNAVAILABLE', message: 'NCM 服务未启动' });
      return;
    }

    try {
      // 请求音质（默认 exhigh）；未知名质从降级链头部开始
      const requestedLevel =
        typeof req.query.level === 'string' && req.query.level
          ? req.query.level
          : 'exhigh';
      const chainStart = (QUALITY_CHAIN as readonly string[]).indexOf(
        requestedLevel,
      );
      const levels = (QUALITY_CHAIN as readonly string[]).slice(
        chainStart >= 0 ? chainStart : 0,
      );

      // 凭证回退链：当前用户凭证 → 房主凭证（请求带 roomId 时）。
      // 实现 spec「房主登录网易云后全房间可播 VIP」：观众自己未登录/
      // 无凭证时，借用房主的持久化凭证解析直链。
      let credential = await loadCredential(req.user?.userId);
      if (!credential) {
        const roomId =
          typeof req.query.roomId === 'string' ? req.query.roomId : '';
        if (roomId) {
          const room = await AppDataSource.getRepository(Room).findOneBy({
            roomId,
          });
          if (room?.ownerUserId) {
            credential = await loadCredential(room.ownerUserId);
          }
        }
      }
      const cookieHeader = credential
        ? toCookieHeader(credential.cookies)
        : '';

      // 沿降级链解析直链；记录最后一次响应的 data 供错误分类
      let resolved: Record<string, unknown> | null = null;
      let lastData: Record<string, unknown> | null = null;
      for (const level of levels) {
        const result = await callNcmApi(
          `/song/url/v1?id=${songId}&level=${level}`,
          cookieHeader,
        );
        const data = extractSongUrlData(result.body);
        if (!data) continue;
        lastData = data;
        const url = data.url;
        // freeTrialInfo 非空表示试听片段（30s），与不可用同等对待
        if (typeof url === 'string' && url && data.freeTrialInfo == null) {
          resolved = data;
          break;
        }
      }

      if (!resolved) {
        // 错误分类：试听标记 → VIP；无版权 → NO_COPYRIGHT；其余 → 解析失败
        if (lastData && lastData.freeTrialInfo != null) {
          res.status(403).json({
            code: 'VIP_REQUIRED',
            message: '需要登录网易云 VIP 账号',
          });
          return;
        }
        const check = await callNcmApi(
          `/check/music?id=${songId}`,
          cookieHeader,
        );
        const checkBody =
          check.body && typeof check.body === 'object'
            ? (check.body as Record<string, unknown>)
            : null;
        if (checkBody && checkBody.success === false) {
          res
            .status(404)
            .json({ code: 'NO_COPYRIGHT', message: '该歌曲暂无版权' });
          return;
        }
        res.status(502).json({
          code: 'RESOLVE_FAILED',
          message: '歌曲播放地址解析失败',
        });
        return;
      }

      // 直链域名校验（防 SSRF）：仅允许 *.music.126.net
      const audioUrl = resolved.url as string;
      let parsed: URL;
      try {
        parsed = new URL(audioUrl);
      } catch {
        res.status(502).json({
          code: 'RESOLVE_FAILED',
          message: '歌曲播放地址解析失败',
        });
        return;
      }
      if (!isNcmAudioHost(parsed.hostname)) {
        console.warn(
          `[music] 拒绝非网易云域名的音频直链: ${parsed.hostname}`,
        );
        res.status(502).json({
          code: 'RESOLVE_FAILED',
          message: '歌曲播放地址解析失败',
        });
        return;
      }

      await proxyAudioStream(req, res, audioUrl);
    } catch (err) {
      console.error('[music] stream error:', err);
      if (!res.headersSent) {
        res
          .status(502)
          .json({ code: 'UPSTREAM_ERROR', message: '音频流代理失败' });
      }
    }
  },
);

export default router;
