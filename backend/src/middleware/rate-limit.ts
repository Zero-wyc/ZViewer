/**
 * 认证相关端点的速率限制中间件。
 *
 * 使用 express-rate-limit 对登录/注册/改密等敏感端点做防暴力破解限流：
 * - authLimiter：登录/注册/guest token（IP 维度，窗口 15min 最多 20 次）
 * - loginFailLimiter：登录失败专用（IP+用户名维度，连续 5 次失败锁定 15min）
 * - passwordLimiter：修改密码（用户维度，1min 最多 3 次）
 *
 * keyGenerator 默认取 req.ip；生产部署在反向代理后时依赖 app.set('trust proxy')。
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';

/** 登录/注册等认证入口的通用限制：15 分钟窗口内每个 IP 最多 20 次请求。 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: '请求过于频繁，请稍后再试' },
});

/** 登录失败专用限制器：同一 IP+用户名 连续失败 5 次后锁定 15 分钟。
 *  只统计失败响应（statusCode >= 400），成功登录不计数。 */
export function createLoginFailLimiter() {
  const failures = new Map<
    string,
    { count: number; firstAt: number; lockedUntil: number }
  >();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_FAILURES = 5;

  return {
    /** 登录失败时调用：记录一次失败，达到阈值则锁定 */
    recordFailure(key: string): void {
      const now = Date.now();
      const entry = failures.get(key);
      if (!entry || now - entry.firstAt > WINDOW_MS) {
        failures.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
        return;
      }
      entry.count += 1;
      if (entry.count >= MAX_FAILURES) {
        entry.lockedUntil = now + WINDOW_MS;
      }
    },

    /** 检查该 key 是否处于锁定期。返回 null 表示放行，返回数字表示剩余秒数 */
    check(key: string): number | null {
      const entry = failures.get(key);
      if (!entry) return null;
      const now = Date.now();
      // 清理过期条目
      if (now - entry.firstAt > WINDOW_MS && entry.lockedUntil < now) {
        failures.delete(key);
        return null;
      }
      if (entry.lockedUntil > now) {
        return Math.ceil((entry.lockedUntil - now) / 1000);
      }
      return null;
    },

    /** 登录成功时清除该 key 的失败记录 */
    clear(key: string): void {
      failures.delete(key);
    },
  };
}

/**
 * 登录失败锁定开关。
 *
 * 默认关闭（应用户要求移除账号临时锁定）。部署在公网且需要防暴力破解时，
 * 设置环境变量 ENABLE_LOGIN_LOCK=true 重新启用：
 *   - loginPreCheck 恢复锁定期 429 拦截
 *   - recordLoginFailure 恢复失败计数
 */
const LOGIN_LOCK_ENABLED = process.env.ENABLE_LOGIN_LOCK === 'true';

/** 全局单例（模块级 Map 保证跨请求共享状态） */
const loginFailStore = createLoginFailLimiter();

/** 提取限流 key：IP + 小写用户名 */
function failKey(req: Request): string {
  const username =
    typeof req.body?.username === 'string'
      ? req.body.username.trim().toLowerCase()
      : '';
  return `${req.ip ?? 'unknown'}:${username}`;
}

/**
 * 登录端点专用中间件：请求前检查是否处于锁定期。
 * 锁定期间直接返回 429，不进入密码校验逻辑。
 */
export function loginPreCheck(
  req: Request,
  res: Response,
  next: import('express').NextFunction,
): void {
  if (!LOGIN_LOCK_ENABLED) {
    next();
    return;
  }
  const remaining = loginFailStore.check(failKey(req));
  if (remaining !== null) {
    res.status(429).json({
      success: false,
      message: `登录失败次数过多，账号已临时锁定，请 ${remaining} 秒后再试`,
    });
    return;
  }
  next();
}

/** 登录失败后调用（由路由处理器在返回 401 前触发）；锁定关闭时不计数 */
export function recordLoginFailure(req: Request): void {
  if (!LOGIN_LOCK_ENABLED) return;
  loginFailStore.recordFailure(failKey(req));
}

/** 登录成功后调用（清除失败计数） */
export function clearLoginFailures(req: Request): void {
  loginFailStore.clear(failKey(req));
}

/** 修改密码端点限制：每用户 1 分钟最多 3 次。 */
export const passwordLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // 未认证（无 userId）时回退到 IP 维度；IPv6 必须经 ipKeyGenerator
  // 规范化，否则 express-rate-limit 校验会抛 ERR_ERL_KEY_GEN_IPV6 导致启动失败
  keyGenerator: (req) => {
    const userId = (req as { user?: { userId?: number } }).user?.userId;
    return userId !== undefined
      ? `pw:${userId}`
      : `pw:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  message: { success: false, message: '操作过于频繁，请稍后再试' },
});
