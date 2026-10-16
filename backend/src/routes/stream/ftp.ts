/**
 * FTP 直连接解析与代理（需登录态，由父路由统一 authenticateToken）。
 *
 *   GET /resolve-ftp  按 query 中的连接参数解析文件，签发短期播放票据并返回
 *                     /proxy-ftp?ticket=... 播放地址
 *   GET /proxy-ftp    FTP 流式代理（凭 ticket 取连接参数）
 *
 * 与 /api/ftp/*（按 mountId 查库）不同，此链路面向未保存挂载的临时连接。
 *
 * 安全设计（v2）：
 * - 连接凭证不再进入返回的播放 URL（旧实现 user/password 明文出现在
 *   video.src 的 query 中，会泄漏到浏览器历史/代理访问日志）——resolve-ftp
 *   将连接参数存入服务端短期票据，proxy-ftp 仅凭 ticket 取参；
 * - ticket 与签发者 userId 绑定（他人盗取 ticket 无法使用）；
 * - 30min 滑动续期：播放期间每次使用自动续期，闲置 30min 后回收；
 * - proxy-ftp 仅接受 ticket（旧 query 参数形态已移除，唯一前端消费方
 *   使用 resolve-ftp 返回的 URL，无需兼容）。
 */

import crypto from 'node:crypto';
import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { statFTPFile, createFTPReadStream } from '../../services/ftp';
import { pipeRangeStream } from '../../services/proxy';
import { TtlCache } from '../../utils/ttl-cache';

const router = Router();

interface FtpQueryParams {
  serverUrl: string;
  path: string;
  username?: string;
  password?: string;
  port?: number;
}

/** FTP 播放票据载荷：连接参数 + 签发者（消费时校验归属） */
interface FtpTicketPayload {
  params: FtpQueryParams;
  userId: number;
}

/** 票据 TTL（滑动续期）：播放期间每次 Range 请求使用即续期 */
const FTP_TICKET_TTL_MS = 30 * 60 * 1000;
const ftpTickets = new TtlCache<FtpTicketPayload>({
  ttlMs: FTP_TICKET_TTL_MS,
  maxSize: 500,
});

function readFtpParams(
  req: AuthenticatedRequest,
  res: Response,
): FtpQueryParams | null {
  const { serverUrl, path, username, password, port } = req.query;
  if (
    typeof serverUrl !== 'string' ||
    !serverUrl.trim() ||
    typeof path !== 'string' ||
    !path.trim()
  ) {
    res.status(400).json({ success: false, message: '缺少服务器地址或路径' });
    return null;
  }
  return {
    serverUrl: serverUrl.trim(),
    path: path.trim(),
    username: typeof username === 'string' ? username : undefined,
    password: typeof password === 'string' ? password : undefined,
    port:
      typeof port === 'string' && port.trim() ? Number(port.trim()) : undefined,
  };
}

// FTP 解析
router.get('/resolve-ftp', async (req: AuthenticatedRequest, res: Response) => {
  const params = readFtpParams(req, res);
  if (!params) return;

  try {
    const info = await statFTPFile(params);

    // 签发短期播放票据：凭证留存服务端，不进入返回的播放 URL
    const ticket = crypto.randomUUID();
    ftpTickets.set(ticket, { params, userId: req.user!.userId });

    // 使用相对路径，由前端根据当前页面 origin 自动解析，避免反向代理后协议错误（http vs https）
    res.json({
      success: true,
      title: info.name,
      videoUrl: `/api/stream/proxy-ftp?ticket=${ticket}`,
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

// FTP 流式代理（全量输出，不支持 Range；保持与历史行为一致）
router.get('/proxy-ftp', async (req: AuthenticatedRequest, res: Response) => {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const payload = ticket ? ftpTickets.get(ticket) : null;
  if (!payload) {
    res.status(403).json({
      success: false,
      message: 'FTP 播放票据无效或已过期，请重新解析',
    });
    return;
  }
  // 票据与签发者绑定：拿到他人 ticket 也无法使用
  if (payload.userId !== req.user!.userId) {
    res.status(403).json({ success: false, message: 'FTP 播放票据归属校验失败' });
    return;
  }
  // 滑动续期：活跃播放持续续期，闲置 30min 后回收
  ftpTickets.set(ticket, payload);
  const params = payload.params;

  try {
    const stream = createFTPReadStream(params);
    pipeRangeStream(res, {
      stream,
      contentType: 'video/mp4',
      ranged: false,
      // 历史行为：未手动设置 CORS，交由全局 cors 中间件
      cors: 'global',
      logTag: 'stream',
      errorMessage: 'FTP 代理失败',
    });
  } catch (err) {
    console.error('[stream] proxy-ftp error:', err);
    res.status(502).json({ success: false, message: 'FTP 代理失败' });
  }
});

export default router;
