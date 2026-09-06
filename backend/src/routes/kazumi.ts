/**
 * Kazumi 独立路由
 *
 * 挂载路径：/api/stream/kazumi
 *
 * 路由列表：
 *   GET  /sources     列出可用数据源
 *   GET  /search      搜索番剧
 *   GET  /episodes    获取集数列表
 *   POST /resolve     解析播放地址
 *   GET  /proxy       媒体代理（防盗链）
 */

import { Router, Response } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  listSources,
  getProvider,
  normalizeEpisode,
} from '../services/kazumi';
import { proxyHttpUpstream } from '../services/proxy';
import { isInternalServerUrl } from '../services/network-utils';

const router = Router();

router.use(authenticateToken);

// --- 媒体代理 ---

router.get('/proxy', async (req: AuthenticatedRequest, res: Response) => {
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

  const q = req.query;
  await proxyHttpUpstream(req, res, {
    url: url.trim(),
    headers: {
      referer: typeof q.referer === 'string' ? q.referer : undefined,
      origin: typeof q.origin === 'string' ? q.origin : undefined,
      userAgent: typeof q.userAgent === 'string' ? q.userAgent : undefined,
      cookie: typeof q.cookie === 'string' ? q.cookie : undefined,
    },
    cors: 'wildcard',
    logTag: 'kazumi',
    errorMessage: '代理媒体失败',
  });
});

// --- 列出数据源 ---

router.get('/sources', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const sources = await listSources();
    console.log(`[kazumi] /sources returned ${sources.length} sources`);
    res.json({ success: true, sources });
  } catch (err) {
    console.error('[kazumi] list sources error:', err);
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
    console.error('[kazumi] search error:', err);
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
    console.error('[kazumi] episodes error:', err);
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
    console.error('[kazumi] resolve error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '解析播放地址失败',
    });
  }
});

export default router;
