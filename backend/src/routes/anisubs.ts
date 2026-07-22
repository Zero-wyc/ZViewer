/**
 * ani-subs 独立路由
 *
 * 挂载路径：/api/stream/anisubs
 *
 * 路由列表：
 *   GET  /sources     列出可用数据源
 *   GET  /search      搜索番剧
 *   GET  /episodes    获取集数列表
 *   POST /resolve     解析播放地址
 *   GET  /proxy       媒体代理（防盗链）
 */

import { Router, Response } from 'express';
import { Readable } from 'node:stream';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  listSources,
  getProvider,
  normalizeEpisode,
} from '../services/anisubs';

const router = Router();

router.use(authenticateToken);

const DEFAULT_PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- 媒体代理 ---

router.get('/proxy', async (req: AuthenticatedRequest, res: Response) => {
  const url = req.query.url;
  const referer = req.query.referer;
  const userAgent = req.query.userAgent;
  const origin = req.query.origin;
  const cookie = req.query.cookie;

  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少 url 参数' });
    return;
  }

  try {
    const range = req.headers.range;
    const upstreamHeaders: Record<string, string> = {
      'User-Agent':
        typeof userAgent === 'string' && userAgent.trim()
          ? userAgent
          : DEFAULT_PROXY_UA,
      Accept: '*/*',
    };
    if (typeof referer === 'string' && referer.trim()) {
      upstreamHeaders.Referer = referer;
    }
    if (typeof origin === 'string' && origin.trim()) {
      upstreamHeaders.Origin = origin;
    }
    if (typeof cookie === 'string' && cookie.trim()) {
      upstreamHeaders.Cookie = cookie;
    }
    if (range) {
      upstreamHeaders.Range = range;
    }

    const upstream = await fetch(url, { headers: upstreamHeaders });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Range',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Range, Accept-Ranges, Content-Length',
    );

    if (!upstream.ok) {
      res.status(upstream.status);
      res.end();
      return;
    }

    const contentType = upstream.headers.get('content-type');
    res.setHeader('Content-Type', contentType || 'application/octet-stream');

    const contentLength = upstream.headers.get('content-length');
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) {
      res.setHeader('Accept-Ranges', acceptRanges);
    }
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    if (upstream.body) {
      Readable.fromWeb(
        upstream.body as unknown as import('node:stream/web').ReadableStream,
      ).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (err) {
    console.error('[anisubs] proxy error:', err);
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: '代理媒体失败' });
    } else {
      res.end();
    }
  }
});

// --- 列出数据源 ---

router.get('/sources', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const sources = await listSources();
    console.log(`[anisubs] /sources returned ${sources.length} sources`);
    res.json({ success: true, sources });
  } catch (err) {
    console.error('[anisubs] list sources error:', err);
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : '获取数据源列表失败',
    });
  }
});

// --- 搜索 ---

router.get('/search', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.query.source;
  const keyword = req.query.keyword;

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ success: false, message: '缺少 source 参数' });
    return;
  }
  if (typeof keyword !== 'string' || !keyword.trim()) {
    res.status(400).json({ success: false, message: '缺少 keyword 参数' });
    return;
  }

  const provider = await getProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的数据源' });
    return;
  }

  try {
    const results = await provider.search(keyword.trim());
    res.json({ success: true, results });
  } catch (err) {
    console.error('[anisubs] search error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '搜索失败',
    });
  }
});

// --- 获取集数 ---

router.get('/episodes', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.query.source;
  const identifier = req.query.identifier;

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ success: false, message: '缺少 source 参数' });
    return;
  }
  if (typeof identifier !== 'string' || !identifier.trim()) {
    res.status(400).json({ success: false, message: '缺少 identifier 参数' });
    return;
  }

  const provider = await getProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的数据源' });
    return;
  }

  try {
    const episodes = await provider.getEpisodes(identifier.trim());
    res.json({ success: true, episodes });
  } catch (err) {
    console.error('[anisubs] episodes error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取集数失败',
    });
  }
});

// --- 解析播放地址 ---

router.post('/resolve', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.body.source;
  const episode = req.body.episode;

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ success: false, message: '缺少 source 参数' });
    return;
  }
  if (!episode || typeof episode !== 'object') {
    res.status(400).json({ success: false, message: '缺少 episode 参数' });
    return;
  }

  const provider = await getProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的数据源' });
    return;
  }

  const normalized = normalizeEpisode(episode);

  try {
    const result = await provider.getPlaybackUrl(normalized);
    if (!result) {
      res.status(404).json({ success: false, message: '无法解析播放地址' });
      return;
    }
    res.json({
      success: true,
      url: result.url,
      headers: result.headers,
      format: result.format,
    });
  } catch (err) {
    console.error('[anisubs] resolve error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '解析播放地址失败',
    });
  }
});

export default router;
