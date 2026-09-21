import type { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import type { UserRole } from '../entities/User';
import { CONFIG_DIR } from '../services/paths';

export interface JwtPayload {
  userId: number;
  role: UserRole;
  username?: string;
  /** JWT 标准声明：签发时间（秒级 Unix 时间戳），由 jsonwebtoken.sign 自动写入 */
  iat?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

/**
 * JWT 密钥解析（V2 改进版）：
 *
 * 1. 环境变量优先——手动在 .env / 环境中设置的值始终生效；
 * 2. 未设置时自动生成 64 位十六进制随机密钥（crypto.randomBytes），
 *    并持久化到 <CONFIG_DIR>/jwt-secrets.json，跨重启保持稳定
 *    （否则每次重启密钥变化会导致所有已签发 token 全部失效）；
 * 3. 持久化文件写入失败（只读文件系统等）时退回进程内临时密钥，
 *    此时重启后所有用户需重新登录，但服务仍可正常启动。
 *
 * 自动生成的密钥保存在 config/ 目录（已被 gitignore），不会进入版本库。
 */
const JWT_SECRETS_FILE = path.join(CONFIG_DIR, 'jwt-secrets.json');

function loadOrCreateSecret(
  envKey: string,
  fileKey: string,
): string {
  // 1. 手动设置的环境变量优先
  const envVal = process.env[envKey];
  if (typeof envVal === 'string' && envVal.trim()) {
    return envVal.trim();
  }

  const generate = () => crypto.randomBytes(32).toString('hex');

  // 2. 从持久化文件加载（上次自动生成的）
  try {
    if (fs.existsSync(JWT_SECRETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(JWT_SECRETS_FILE, 'utf8')) as Record<
        string,
        unknown
      >;
      const stored = parsed[fileKey];
      if (typeof stored === 'string' && stored.length >= 32) {
        return stored;
      }
    }
  } catch {
    /* 文件读取/解析失败则走重新生成 */
  }

  // 3. 自动生成并持久化到 config/jwt-secrets.json
  const generated = generate();
  try {
    fs.mkdirSync(path.dirname(JWT_SECRETS_FILE), { recursive: true });
    let obj: Record<string, unknown> = {};
    try {
      if (fs.existsSync(JWT_SECRETS_FILE)) {
        obj = JSON.parse(fs.readFileSync(JWT_SECRETS_FILE, 'utf8')) as Record<
          string,
          unknown
        >;
      }
    } catch {
      /* 已有文件损坏时覆盖重建 */
    }
    obj[fileKey] = generated;
    fs.writeFileSync(JWT_SECRETS_FILE, JSON.stringify(obj, null, 2));
    console.log(
      `[auth] ${envKey} 未设置：已自动生成随机密钥并保存到 ${JWT_SECRETS_FILE}。` +
        `如需自定义请在 .env 中设置 ${envKey}。`
    );
  } catch (err) {
    console.warn(
      `[auth] ${envKey} 未设置且无法持久化自动生成的密钥（本次启动使用进程内临时密钥，重启后所有用户需重新登录）:`,
      err instanceof Error ? err.message : err
    );
  }
  return generated;
}

const JWT_ACCESS_SECRET = loadOrCreateSecret('JWT_ACCESS_SECRET', 'access');
const JWT_REFRESH_SECRET = loadOrCreateSecret('JWT_REFRESH_SECRET', 'refresh');
const JWT_ACCESS_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '1h';
const JWT_REFRESH_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '30d';

/** access_token cookie 有效期（毫秒）。比 JWT 短 5 秒避免边界过期。 */
const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 1000; // 1 小时
/** refresh_token cookie 有效期（毫秒）。 */
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 天

/** guest token 有效期：access 1h / refresh 7d（正式用户的 30d refresh 过长，
 *  且 /auth/guest 无需凭证即可调用，短有效期降低被批量滥用后的影响面）。 */
const GUEST_ACCESS_EXPIRES_IN: jwt.SignOptions['expiresIn'] = '1h';
const GUEST_REFRESH_EXPIRES_IN: jwt.SignOptions['expiresIn'] = '7d';

const IS_PROD = process.env.NODE_ENV === 'production';

export function generateTokens(userId: number, role: UserRole, username?: string) {
  const payload: JwtPayload = { userId, role, username };
  const isGuest = userId === 0 && role === 'guest';
  const accessToken = jwt.sign(payload, JWT_ACCESS_SECRET, {
    expiresIn: isGuest ? GUEST_ACCESS_EXPIRES_IN : JWT_ACCESS_EXPIRES_IN,
  });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: isGuest ? GUEST_REFRESH_EXPIRES_IN : JWT_REFRESH_EXPIRES_IN,
  });
  return { accessToken, refreshToken };
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_ACCESS_SECRET) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_REFRESH_SECRET) as JwtPayload;
}

// ==================== Token 失效检查（V4/V5） ====================

/**
 * tokenInvalidBefore 的内存缓存（60s TTL）。
 * 避免每个认证请求都查一次 User 表；改密/管理操作调用 invalidateUserTokens
 * 更新缓存，未命中的 key 在 TTL 过期后从 DB 回源。
 */
const invalidBeforeCache = new Map<number, { value: number | null; expireAt: number }>();
const INVALID_CACHE_TTL_MS = 60 * 1000;

/** 获取用户的 token 失效时间戳（毫秒），null 表示未设置或查询失败（fail-open 由调用方处理）。 */
export function getTokenInvalidBefore(userId: number): number | null {
  const cached = invalidBeforeCache.get(userId);
  if (cached && cached.expireAt > Date.now()) {
    return cached.value;
  }
  // 缓存未命中：同步返回 null（不阻塞请求），异步回源填充。
  // 首次 miss 的容忍窗口 ≤ TTL；改密路径会主动写入缓存保证立即生效。
  void (async () => {
    try {
      const { AppDataSource } = require('../data-source');
      const user = await AppDataSource.getRepository('User').findOneBy({ id: userId });
      invalidBeforeCache.set(userId, {
        value: user?.tokenInvalidBefore ? new Date(user.tokenInvalidBefore).getTime() : null,
        expireAt: Date.now() + INVALID_CACHE_TTL_MS,
      });
    } catch {
      /* 查询失败不影响当前请求 */
    }
  })();
  return cached ? cached.value : null;
}

/**
 * 使指定用户的所有已签发 token 立即失效（V4/V5）。
 *
 * 写入 DB + 同步刷新内存缓存。修改密码、管理员禁用/删除用户等操作后调用。
 */
export async function invalidateUserTokens(userId: number): Promise<void> {
  const now = new Date();
  try {
    const { AppDataSource } = require('../data-source');
    await AppDataSource.getRepository('User').update(
      { id: userId },
      { tokenInvalidBefore: now },
    );
    invalidBeforeCache.set(userId, {
      value: now.getTime(),
      expireAt: Date.now() + INVALID_CACHE_TTL_MS,
    });
  } catch (err) {
    console.error('[auth] invalidateUserTokens error:', err);
  }
}

/**
 * 判断当前请求是否为 HTTPS（含反向代理终止 TLS 的场景）。
 * 用于动态决定 cookie 的 secure 属性：
 * - HTTPS 请求 → secure: true（浏览器才允许设置 Secure cookie）
 * - HTTP 请求 → secure: false（否则浏览器会直接丢弃 Secure cookie，导致登录态丢失）
 *
 * 依赖 app.set('trust proxy', true) 才能正确读取 X-Forwarded-Proto 头。
 */
function isRequestSecure(req: Request): boolean {
  // req.secure 在直连场景下反映真实 TLS；反向代理后需信任 X-Forwarded-Proto
  if (req.secure) return true;
  const xfp = req.headers['x-forwarded-proto'];
  if (typeof xfp === 'string' && xfp.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  // 内网穿透 / 简易隧道兜底：部分穿透服务（如 ug link）不做 HTTPS 卸载头转发，
  // 后端收到的请求是 http 且无 X-Forwarded-Proto——按 http 处理会导致
  // cookie 永远写不进（登录响应 200 但无 Set-Cookie → 全站 401 死循环，
  // 连 guest 降级也拿不到 cookie）。浏览器对 POST fetch 必发 Origin 头，
  // 其 scheme 即浏览器视角的真实协议：Origin 声明 https 说明 TLS 终止在
  // 代理侧，须按 https 写 cookie（Secure cookie 在 https 页面正常生效）。
  // 安全性：伪造 Origin: https 的后果仅是对 http 连接下发 Secure cookie，
  // 浏览器在 http 页面会直接丢弃 Secure cookie，无安全恶化。
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.toLowerCase().startsWith('https://')) {
    return true;
  }
  return false;
}

/**
 * 判断当前请求是否为跨站请求（schemeful same-site 判定）。
 *
 * 浏览器 SameSite 同站判定规则（MDN：SameSite cookies）：
 * - 同站 = 相同 scheme（http/https）+ 相同 registrable domain（域名或 IP），**端口不影响同站**
 * - 例：http://example.com:3000 与 http://example.com:3333 是【同站】
 *   （同 scheme、同域名，仅端口不同，SameSite=Lax 的 cookie 可正常携带）
 *   https://example.com 与 http://example.com 则是【跨站】（scheme 不同）
 *
 * 为什么必须忽略端口：
 * 统一端口后前后端共用同一端口（默认 3333），但浏览器 SameSite 判定本身也忽略端口，
 * 因此即使历史部署中前后端使用不同端口（如前端 4173、后端 3333）也是同站。
 * 若按"端口不同即跨站"判定，会错误地把同站请求标记为跨站：
 * - HTTPS 下会错误设置 SameSite=None（同站不需要，且部分代理/浏览器对 None 敏感）
 * - HTTP 下虽因浏览器同站判定忽略端口而侥幸可用，但逻辑错误
 *
 * 兼容反向代理：
 * - 反代时请求 Host 可能被改写为内网地址（localhost:3333），
 *   优先读取 X-Forwarded-Host（反代常用 proxy_set_header X-Forwarded-Host $host）
 *   或直接比较 X-Forwarded-Proto 与 Origin 的 scheme。
 */
function isCrossSiteRequest(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== 'string') return false;

  // 请求方视角的 scheme（优先 X-Forwarded-Proto，其次 req.secure /
  // 直连协议；穿透场景 X-Forwarded-Proto 缺失时兜底 Origin 自身的
  // scheme——此时判定退化为纯 hostname 比较，与浏览器同站视角一致）
  const xfp = req.headers['x-forwarded-proto'];
  const originScheme = origin.toLowerCase().startsWith('https://')
    ? 'https'
    : origin.toLowerCase().startsWith('http://')
      ? 'http'
      : '';
  const reqScheme =
    (typeof xfp === 'string' ? xfp.split(',')[0].trim() : '') ||
    (req.secure ? 'https' : '') ||
    originScheme ||
    'http';

  // 请求方视角的 host（优先 X-Forwarded-Host，其次 Host 头）
  const xfh = req.headers['x-forwarded-host'];
  const rawHost = typeof xfh === 'string' ? xfh : req.headers.host;
  if (!rawHost) return false;

  try {
    const originUrl = new URL(origin);
    // 用构造 URL 的方式解析 host（兼容 IPv6 [::1]:3333）
    const hostUrl = new URL(`${reqScheme}://${rawHost}`);
    return (
      originUrl.hostname !== hostUrl.hostname ||
      originUrl.protocol !== hostUrl.protocol
    );
  } catch {
    return false;
  }
}

/**
 * 根据请求上下文计算 cookie 的 sameSite 和 secure 属性。
 *
 * - 同站 + HTTP → sameSite: 'lax', secure: false（最常见：Nginx 反代 / 同域名不同端口）
 * - 同站 + HTTPS → sameSite: 'lax', secure: true
 * - 跨站 + HTTPS → sameSite: 'none', secure: true（跨站 fetch 携带 cookie 必需）
 * - 跨站 + HTTP  → sameSite: 'lax', secure: false（浏览器安全限制：SameSite=None 必须配 Secure，
 *   而 HTTP 无法设置 Secure cookie，因此跨站 HTTP 场景无法保留登录态。
 *   这是浏览器硬限制，需通过同站反代或升级 HTTPS 解决，代码已注释说明）
 */
function getCookieSameSiteOptions(req: Request): {
  sameSite: 'none' | 'lax';
  secure: boolean;
} {
  const secure = isRequestSecure(req);
  const crossSite = isCrossSiteRequest(req);
  if (crossSite && secure) {
    return { sameSite: 'none', secure: true };
  }
  return { sameSite: 'lax', secure };
}

/**
 * 将 access_token / refresh_token 写入 httpOnly cookie（分离式架构）。
 *
 * - HTTPS 请求：写入 httpOnly cookie（同站 Lax / 跨站 None+Secure），浏览器自动携带。
 * - HTTP 请求：不写 cookie。浏览器拒绝跨站 http cookie（SameSite=None 必须配 Secure，
 *   而 HTTP 无法设置），为避免半失效 cookie 残留，HTTP 场景统一走 Bearer token——
 *   调用方需将 token 放入响应体（登录/刷新接口已返回 tokens）。
 */
export function setAuthCookies(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  if (!isRequestSecure(req)) return;
  const { sameSite, secure } = getCookieSameSiteOptions(req);
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: REFRESH_COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * 仅更新 access_token cookie（refresh 不轮换）。
 * 与 setAuthCookies 相同：HTTP 请求不写 cookie，token 由响应体返回走 Bearer。
 */
export function setAccessTokenCookie(
  req: Request,
  res: Response,
  accessToken: string,
): void {
  if (!isRequestSecure(req)) return;
  const { sameSite, secure } = getCookieSameSiteOptions(req);
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * 清除 auth cookie（登出）。需传入 req 以匹配 sameSite 设置，
 * 否则跨站 cookie 无法被正确清除。HTTP 场景无 cookie 时调用无害。
 */
export function clearAuthCookies(req: Request, res: Response): void {
  const { sameSite, secure } = getCookieSameSiteOptions(req);
  res.clearCookie('access_token', { path: '/', sameSite, secure });
  res.clearCookie('refresh_token', { path: '/', sameSite, secure });
}

/** 从 cookie、Authorization Header 或查询参数读取 access token。 */
export function extractAccessToken(req: Request): string | undefined {
  // 从查询参数读取（用于 hls.js 等无法设置 header 的场景）
  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  // 优先从 cookie 读取（前端 fetch credentials: 'include' 自动携带）
  const cookieToken = req.cookies?.access_token;
  if (typeof cookieToken === 'string' && cookieToken) return cookieToken;
  // 兼容旧 Authorization: Bearer <token> 头
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.split(' ')[1];
  if (headerToken) return headerToken;
  return undefined;
}

export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const token = extractAccessToken(req);

  if (!token) {
    res.status(401).json({ success: false, message: '未提供认证令牌' });
    return;
  }

  try {
    const payload = verifyAccessToken(token);

    // Token 失效检查（V4/V5）：改密/管理操作会使此前签发的 token 全部失效。
    // guest（userId=0）无 User 行，跳过。使用 60s TTL 缓存避免每请求查库。
    if (payload.userId !== 0) {
      const invalidBefore = getTokenInvalidBefore(payload.userId);
      if (invalidBefore !== null) {
        const iat = payload.iat;
        if (typeof iat === 'number' && iat * 1000 < invalidBefore) {
          res
            .status(401)
            .json({ success: false, message: '令牌已失效，请重新登录' });
          return;
        }
      }
    }

    req.user = payload;
    next();
  } catch (err) {
    res.status(403).json({ success: false, message: '认证令牌无效或已过期' });
  }
}

/** 仅允许 root 超级管理员访问的路由中间件。 */
export function requireRoot(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (req.user?.role !== 'root') {
    res.status(403).json({ success: false, message: '无权限：仅超级管理员可操作' });
    return;
  }
  next();
}
