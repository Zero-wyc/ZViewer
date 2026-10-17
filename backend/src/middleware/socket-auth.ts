import type { Socket } from 'socket.io';
import { verifyAccessToken } from './auth';

/**
 * Socket.IO 连接鉴权中间件（从根 index.ts 抽出）。
 *
 * 两类连接语义：
 * - CLI 代理（agent === 'zcontrol-cli'）：无需浏览器 access_token，全局注册，
 *   后续 CliHandler 会校验 proxyUrl 并按 user 归属过滤；
 * - 浏览器：优先读 httpOnly cookie 的 access_token，兼容旧 auth.token / query.token。
 */
export function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): void {
  // CLI 代理（ZViewer CLI）使用独立连接语义：无需浏览器用户的 access_token，
  // 全局注册（不绑定房间，一个 CLI 对所有房间可用）。此处按 agent 标识放行，
  // 后续 CliHandler 会校验 proxyUrl 并按 user 归属过滤。
  if (socket.handshake.auth.agent === 'zcontrol-cli') {
    socket.data.isCliAgent = true;
    return next();
  }

  // 优先从 handshake.headers.cookie 读取 access_token（httpOnly cookie）
  // 兼容旧 auth.token / query.token 字段以支持过渡期客户端
  const cookieHeader = socket.handshake.headers.cookie;
  let token: string | undefined;

  if (cookieHeader) {
    // 简单解析 cookie 字符串，避免引入额外依赖
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=');
        return [k, decodeURIComponent(v.join('='))];
      }),
    );
    token = cookies.access_token;
  }

  // 退化路径：客户端在 auth.token 显式带 token（旧版前端兼容）
  if (!token) {
    const rawToken = socket.handshake.auth.token || socket.handshake.query.token;
    token = typeof rawToken === 'string' ? rawToken : undefined;
  }

  if (!token) {
    return next(new Error('未提供认证令牌'));
  }

  try {
    const payload = verifyAccessToken(token);
    socket.data.userId = payload.userId;
    socket.data.role = payload.role;
    socket.data.username = payload.username;
    next();
  } catch {
    next(new Error('认证令牌无效或已过期'));
  }
}
