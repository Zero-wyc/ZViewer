/**
 * 媒体代理路由。
 *
 *   imageProxyRouter：GET /proxy-image  B站 图片代理（免认证，须在 authenticateToken 之前挂载）
 *   默认导出：        GET /proxy        B站 CDN 媒体代理（需登录态）
 *
 * 两个端点均基于统一 proxyHttpUpstream 实现，仅声明上游请求头与 CORS 策略差异。
 */

import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { proxyHttpUpstream } from '../../services/proxy';

const BILIBILI_REFERER = 'https://www.bilibili.com';

/**
 * B站媒体 CDN 域名白名单（host 精确或子域后缀匹配），
 * 与 services/bilibili/cdn.ts 的 HTTPS_CAPABLE_BILIBILI_DOMAINS 及前端
 * url-proxy.ts 保持一致。旧实现是子串正则，任何含 mcdn/akamaized 等子串
 * 的第三方域名都会被误加 B站 Referer。
 */
const BILIBILI_MEDIA_HOST_SUFFIXES = [
  'bilibili.com',
  'bilivideo.com',
  'hdslb.com',
  'biliimg.com',
  'bstatic.com',
  'mountaintoys.cn',
  'pili-video.com',
  'boss-pgc.com',
];

/** akamaized 为共享 CDN，仅精确白名单 B站 海外边缘节点 */
const BILIBILI_MEDIA_HOST_EXACT = ['upos-hz-mirrorakam.akamaized.net'];

function isBilibiliMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    BILIBILI_MEDIA_HOST_SUFFIXES.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    ) || BILIBILI_MEDIA_HOST_EXACT.includes(host)
  );
}

const allowedImageDomains = [
  'bilibili.com',
  'hdslb.com',
  'bilivideo.com',
  'biliimg.com',
];

function readUrlParam(req: Request, res: Response): string | null {
  const url = req.query.url;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少 url 参数' });
    return null;
  }
  return url.trim();
}

// 公共图片代理：B站 CDN 图片需要 referer，且 img 标签无法携带认证头，
// 因此提供免认证的 B站 图片代理，仅允许 bilibili 域名的图片地址。
export const imageProxyRouter = Router().get(
  '/proxy-image',
  async (req: Request, res: Response) => {
    const trimmedUrl = readUrlParam(req, res);
    if (!trimmedUrl) return;

    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      res.status(400).json({ success: false, message: '非法的 URL' });
      return;
    }

    const isAllowed = allowedImageDomains.some(
      (domain) =>
        parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
    );
    if (!isAllowed) {
      res.status(403).json({ success: false, message: '仅允许 B站 域名图片' });
      return;
    }

    await proxyHttpUpstream(req, res, {
      url: trimmedUrl,
      headers: { referer: BILIBILI_REFERER },
      // img 标签不携带凭证，CORS 交由全局中间件反射 Origin
      cors: 'global',
      defaultContentType: 'image/jpeg',
      cacheControl: 'public, max-age=3600',
      logTag: 'stream',
      errorMessage: '代理图片失败',
    });
  },
);

// 媒体代理：绕过浏览器对 B站 CDN 的 Referer/UA 限制。
// 前端 fetch 携带凭证（credentials: 'include'），CORS 必须由全局中间件
// 反射 Origin + credentials，不能手动设置 ACAO:*（否则浏览器拒绝响应）。
//
// 对于非 B站 URL（如第三方 m3u8 直链），不添加 B站 Referer/Origin，
// 避免因错误的 Referer 导致源服务器拒绝请求。
const router = Router().get(
  '/proxy',
  async (req: AuthenticatedRequest, res: Response) => {
    const trimmedUrl = readUrlParam(req, res);
    if (!trimmedUrl) return;

    // 根据 URL 域名判断是否为 B站 CDN，非 B站 URL 不添加 B站 headers
    let isBilibiliUrl = false;
    try {
      const parsed = new URL(trimmedUrl);
      isBilibiliUrl = isBilibiliMediaHost(parsed.hostname);
    } catch {
      // URL 解析失败时不添加 B站 headers
    }

    // 根据 URL 后缀推断 Content-Type（m3u8 / ts 分片等）
    const lowerUrl = trimmedUrl.toLowerCase();
    let defaultContentType = 'video/mp4';
    if (lowerUrl.includes('.m3u8')) {
      defaultContentType = 'application/vnd.apple.mpegurl';
    } else if (lowerUrl.includes('.ts')) {
      // HLS ts 分片，通常无需显式 Content-Type，MPEG-TS 流
      defaultContentType = 'video/mp2t';
    }

    await proxyHttpUpstream(req, res, {
      url: trimmedUrl,
      headers: isBilibiliUrl
        ? { referer: BILIBILI_REFERER, origin: BILIBILI_REFERER }
        : {},
      cors: 'global',
      defaultContentType,
      logTag: 'stream',
      errorMessage: '代理媒体失败',
    });
  },
);

export default router;
