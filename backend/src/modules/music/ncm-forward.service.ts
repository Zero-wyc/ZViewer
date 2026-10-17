/**
 * 网易云通用转发与云盘上传转发。
 *
 * 浏览器不直连网易云：/api/music/ncm/* 与 /api/music/cloud/upload 都在
 * 服务端注入当前用户持久化的 cookie 后转发到内部 NCM 服务。
 */
import type { Response } from 'express';
import { Readable } from 'node:stream';
import type { AuthenticatedRequest } from '../../middleware/auth';
import { getNcmApiBase } from './ncm-api.service';
import {
  hasLoginCookies,
  loadCredential,
  mergeCookies,
  parseStoredCookies,
  persistCookies,
  toCookieHeader,
} from './ncm-cookie.service';

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
export async function forwardNcmRequest(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
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
    if (userId > 0 && setCookies.length > 0 && hasLoginCookies(setCookies)) {
      const existing = credential
        ? parseStoredCookies(credential.cookies)
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
}

/**
 * 云盘上传（multipart 原样流式转发到内部 NCM /cloud）
 *
 * 通用 /ncm 转发把 POST body 当 JSON 处理，无法承载 multipart 文件；此处保持
 * 原始 multipart（Content-Type 边界原样透传），把请求体流式 pipe 给内部 NCM
 * 服务的 /cloud 端点（neteasecloudmusicapi 的多步上传封装：check → nos token →
 * 上传 → publish），并注入当前用户 cookie。全局仅有 express.json 中间件，
 * multipart 请求体不会被消费，可安全以流转发。
 */
export async function forwardCloudUpload(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const base = getNcmApiBase();
  if (!base) {
    res
      .status(503)
      .json({ code: 'NCM_UNAVAILABLE', message: 'NCM 服务未启动' });
    return;
  }
  const credential = await loadCredential(req.user?.userId);
  if (!credential) {
    res
      .status(401)
      .json({ code: 'NCM_NOT_LOGGED_IN', message: '请先登录网易云账号' });
    return;
  }
  const contentType = req.headers['content-type'];
  if (!contentType || !contentType.includes('multipart/form-data')) {
    res
      .status(400)
      .json({ code: 'BAD_REQUEST', message: '需要 multipart/form-data 上传请求' });
    return;
  }
  try {
    const target = `${base}/cloud?timestamp=${Date.now()}`;
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        Cookie: toCookieHeader(credential.cookies),
        'Content-Type': contentType,
      },
      body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
      // @ts-expect-error undici 流式 body 需要 duplex 声明
      duplex: 'half',
    });

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
      console.warn(`[music] 云盘上传响应非 JSON: ${upstream.status}`);
      res
        .status(502)
        .json({ code: 'UPSTREAM_ERROR', message: 'NCM 服务返回了无法解析的响应' });
      return;
    }

    // 上传链路可能刷新登录态 cookie，同通用转发逻辑持久化（游客不持久化）
    const userId = req.user?.userId ?? 0;
    if (userId > 0 && setCookies.length > 0 && hasLoginCookies(setCookies)) {
      const existing = credential
        ? parseStoredCookies(credential.cookies)
        : [];
      await persistCookies(userId, mergeCookies(existing, setCookies), body);
    }

    res.status(upstream.status).json(body);
  } catch (err) {
    console.error('[music] 云盘上传转发失败:', err);
    res
      .status(502)
      .json({ code: 'UPSTREAM_ERROR', message: '云盘上传请求失败' });
  }
}
