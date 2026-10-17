/**
 * 防盗链媒体代理端点共享实现。
 *
 * kazumi / cms / anisubs 三路由的 GET /proxy 此前为逐字相同的三份拷贝
 * （仅日志前缀不同）：校验 url 参数 → SSRF 内网拦截 → 携带客户端传入的
 * Referer/Origin/UA/Cookie 头转发上游。
 */
import type { Request, Response } from 'express';
import {
  type AuthenticatedRequest,
} from '../middleware/auth';
import { proxyHttpUpstream } from '../services/proxy';
import { isInternalServerUrl } from '../services/network-utils';

/** 生成 GET /proxy 处理器（logTag 仅影响日志前缀） */
export function createAntileechProxyHandler(logTag: string) {
  return async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const url = req.query.url;
    if (typeof url !== 'string' || !url.trim()) {
      res.status(400).json({ success: false, message: '缺少 url 参数' });
      return;
    }

    // SSRF 防护：本代理允许客户端携带任意 Cookie/Referer 头转发，
    // 不得被用于探测内网服务；数据源均为公网站点，拦截无业务影响。
    if (isInternalServerUrl(url.trim())) {
      res.status(403).json({ success: false, message: '不允许代理内网地址' });
      return;
    }

    const q = req.query as Request['query'];
    await proxyHttpUpstream(req, res, {
      url: url.trim(),
      headers: {
        referer: typeof q.referer === 'string' ? q.referer : undefined,
        origin: typeof q.origin === 'string' ? q.origin : undefined,
        userAgent: typeof q.userAgent === 'string' ? q.userAgent : undefined,
        cookie: typeof q.cookie === 'string' ? q.cookie : undefined,
      },
      cors: 'wildcard',
      // 浏览器媒体缓存 6min：慢源分片 seek 回看直接命中本地缓存，不再回源重拉
      cacheControl: 'private, max-age=360',
      logTag,
      errorMessage: '代理媒体失败',
    });
  };
}
