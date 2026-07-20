import { Router, Response } from 'express';
import { Readable } from 'node:stream';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  listAnimeSources,
  getAnimeProvider,
  AnimeEpisode,
} from '../services/anime';

const router = Router();

router.use(authenticateToken);

const DEFAULT_PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 通用媒体代理：转发带防盗链的视频流。
 * 查询参数：
 *   url       必填，目标视频地址
 *   referer   可选，自定义 Referer
 *   userAgent 可选，自定义 User-Agent
 *   origin    可选，自定义 Origin
 *   cookie    可选，自定义 Cookie
 */
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
    console.error('[animeSources] proxy error:', err);
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: '代理媒体失败' });
    } else {
      res.end();
    }
  }
});

// 列出可用番剧数据源
router.get('/sources', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const sources = await listAnimeSources();
    res.json({ success: true, sources });
  } catch (err) {
    console.error('[animeSources] list sources error:', err);
    res.status(500).json({ success: false, message: '获取番剧数据源列表失败' });
  }
});

// 搜索番剧
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

  const provider = await getAnimeProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的番剧数据源' });
    return;
  }

  try {
    const results = await provider.search(keyword.trim());
    res.json({ success: true, results });
  } catch (err) {
    console.error('[animeSources] search error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '搜索番剧数据源失败',
    });
  }
});

// 获取集数列表
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

  const provider = await getAnimeProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的番剧数据源' });
    return;
  }

  try {
    const episodes = await provider.getEpisodes(identifier.trim());
    res.json({ success: true, episodes });
  } catch (err) {
    console.error('[animeSources] episodes error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取集数列表失败',
    });
  }
});

// 解析播放地址
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

  const provider = await getAnimeProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的番剧数据源' });
    return;
  }

  const normalized: AnimeEpisode = {
    id: String(episode.id ?? ''),
    title: String(episode.title ?? ''),
    episodeNumber: Number(episode.episodeNumber) || 1,
    playbackParams:
      episode.playbackParams && typeof episode.playbackParams === 'object'
        ? (episode.playbackParams as Record<string, unknown>)
        : {},
  };

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
      audioUrl: result.audioUrl,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      duration: result.duration,
    });
  } catch (err) {
    console.error('[animeSources] resolve error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '解析播放地址失败',
    });
  }
});

export default router;
