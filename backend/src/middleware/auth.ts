import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

import type { UserRole } from '../entities/User';

export interface JwtPayload {
  userId: number;
  role: UserRole;
  username?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

const JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-in-production';
const JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-production';
const JWT_ACCESS_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '1h';
const JWT_REFRESH_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '30d';

/** access_token cookie 有效期（毫秒）。比 JWT 短 5 秒避免边界过期。 */
const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 1000; // 1 小时
/** refresh_token cookie 有效期（毫秒）。 */
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 天

const IS_PROD = process.env.NODE_ENV === 'production';

export function generateTokens(userId: number, role: UserRole, username?: string) {
  const payload: JwtPayload = { userId, role, username };
  const accessToken = jwt.sign(payload, JWT_ACCESS_SECRET, {
    expiresIn: JWT_ACCESS_EXPIRES_IN,
  });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
  });
  return { accessToken, refreshToken };
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_ACCESS_SECRET) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_REFRESH_SECRET) as JwtPayload;
}

/** 将 access_token / refresh_token 写入 httpOnly cookie。 */
export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: REFRESH_COOKIE_MAX_AGE,
    path: '/',
  });
}

/** 仅更新 access_token cookie（refresh 不轮换）。 */
export function setAccessTokenCookie(res: Response, accessToken: string): void {
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: ACCESS_COOKIE_MAX_AGE,
    path: '/',
  });
}

/** 清除 auth cookie（登出）。 */
export function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/' });
}

/** 从 cookie 或 Authorization Header 读取 access token。 */
export function extractAccessToken(req: Request): string | undefined {
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
    req.user = payload;
    next();
  } catch (err) {
    res.status(403).json({ success: false, message: '认证令牌无效或已过期' });
  }
}
