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

export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

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
