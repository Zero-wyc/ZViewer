/**
 * CMS 采集源独立路由
 *
 * 挂载路径：/api/stream/cms
 *
 * 路由列表：
 *   GET  /sources  列出可用采集站点（来自 TVBox 配置）
 *   GET  /search   站点内搜索影片
 *   GET  /detail   影片详情与剧集列表
 *   POST /resolve  解析播放直链（60s TTL 缓存 + 单飞去重）
 *   GET  /inspect  预览 TVBox 配置中的 CMS 站点（仅 admin/root）
 *   GET  /proxy    媒体代理（防盗链）
 */

import { Router, Response } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  listSources,
  getProvider,
  normalizePlaybackParams,
  searchAllProviders,
} from '../services/cms';
import { loadTvboxCmsSites } from '../services/cms/tvboxConfigLoader';
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
    // 浏览器媒体缓存 6min：慢源分片 seek 回看直接命中本地缓存，不再回源重拉
    cacheControl: 'private, max-age=360',
    logTag: 'cms',
    errorMessage: '代理媒体失败',
  });
});

// --- 列出数据源 ---

router.get('/sources', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const sources = await listSources();
    res.json({ success: true, sources });
  } catch (err) {
    console.error('[cms] list sources error:', err);
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
    console.error('[cms] search error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '搜索失败',
    });
  }
});

// --- 聚合搜索（全部站点并发，标题归一化去重） ---

const searchAllInflight = new Map<string, Promise<unknown>>();

router.get(
  '/search-all',
  async (req: AuthenticatedRequest, res: Response) => {
    const keyword = req.query.keyword;
    if (typeof keyword !== 'string' || !keyword.trim()) {
      res.status(400).json({ success: false, message: '缺少 keyword 参数' });
      return;
    }

    const trimmed = keyword.trim();
    const existing = searchAllInflight.get(trimmed);
    if (existing) {
      try {
        res.json(await existing);
      } catch (err) {
        console.error('[cms] search-all error (inflight):', err);
        res.status(502).json({
          success: false,
          message: err instanceof Error ? err.message : '聚合搜索失败',
        });
      }
      return;
    }

    const promise = searchAllProviders(trimmed)
      .then((results) => ({ success: true, results }))
      .finally(() => {
        searchAllInflight.delete(trimmed);
      });
    searchAllInflight.set(trimmed, promise);

    try {
      res.json(await promise);
    } catch (err) {
      console.error('[cms] search-all error:', err);
      res.status(502).json({
        success: false,
        message: err instanceof Error ? err.message : '聚合搜索失败',
      });
    }
  },
);

// --- 影片详情与剧集 ---

router.get('/detail', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.query.source;
  const vodId = req.query.vodId;

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ success: false, message: '缺少 source 参数' });
    return;
  }
  if (typeof vodId !== 'string' || !vodId.trim()) {
    res.status(400).json({ success: false, message: '缺少 vodId 参数' });
    return;
  }

  const provider = await getProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的数据源' });
    return;
  }

  try {
    const detail = await provider.getDetail(vodId.trim());
    res.json({ success: true, detail });
  } catch (err) {
    console.error('[cms] detail error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取影片详情失败',
    });
  }
});

// --- 解析播放地址（6min TTL 缓存 + 单飞去重） ---
// 采集站解析（详情 API + 播放页抓取）较慢，拉长窗口让多人同集共享一次解析；
// 采集直链普遍短时效但仍在几分钟以上，6min 窗口内复用一般安全

const RESOLVE_CACHE_TTL_MS = 6 * 60 * 1000;

interface ResolveCacheEntry {
  result: unknown;
  fetchedAt: number;
}

const resolveCache = new Map<string, ResolveCacheEntry>();
const resolveInflight = new Map<string, Promise<unknown>>();

function makeResolveCacheKey(
  source: string,
  vodId: string,
  playFromIndex: number,
  episodeIndex: number,
): string {
  return `${source}|${vodId}|${playFromIndex}|${episodeIndex}`;
}

router.post('/resolve', async (req: AuthenticatedRequest, res: Response) => {
  const source = req.body?.source;
  const params = req.body?.params;

  if (typeof source !== 'string' || !source.trim()) {
    res.status(400).json({ success: false, message: '缺少 source 参数' });
    return;
  }
  if (!params || typeof params !== 'object') {
    res.status(400).json({ success: false, message: '缺少 params 参数' });
    return;
  }

  const provider = await getProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的数据源' });
    return;
  }

  const normalized = normalizePlaybackParams(params);
  if (!normalized.vodId) {
    res.status(400).json({ success: false, message: '缺少 vodId 参数' });
    return;
  }

  const cacheKey = makeResolveCacheKey(
    source.trim(),
    normalized.vodId,
    normalized.playFromIndex,
    normalized.episodeIndex,
  );

  const cached = resolveCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < RESOLVE_CACHE_TTL_MS) {
    res.json(cached.result);
    return;
  }

  const existing = resolveInflight.get(cacheKey);
  if (existing) {
    try {
      res.json(await existing);
    } catch (err) {
      console.error('[cms] resolve error (inflight):', err);
      res.status(502).json({
        success: false,
        message: err instanceof Error ? err.message : '解析播放地址失败',
      });
    }
    return;
  }

  const promise = provider
    .getPlaybackUrl(normalized)
    .then((result) => {
      if (!result) {
        throw new Error('无法解析播放地址');
      }
      const payload = {
        success: true,
        url: result.url,
        headers: result.headers,
        format: result.format,
      };
      resolveCache.set(cacheKey, {
        result: payload,
        fetchedAt: Date.now(),
      });
      return payload;
    })
    .finally(() => {
      resolveInflight.delete(cacheKey);
    });

  resolveInflight.set(cacheKey, promise);

  try {
    res.json(await promise);
  } catch (err) {
    console.error('[cms] resolve error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '解析播放地址失败',
    });
  }
});

// --- 预览 TVBox 配置中的 CMS 站点（仅 admin/root） ---

router.get('/inspect', async (req: AuthenticatedRequest, res: Response) => {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'root') {
    res.status(403).json({ success: false, message: '需要管理员权限' });
    return;
  }

  const url = req.query.url;
  if (typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ success: false, message: '缺少 url 参数' });
    return;
  }
  if (!/^https?:\/\//i.test(url.trim())) {
    res
      .status(400)
      .json({ success: false, message: '配置地址必须是 http(s) URL' });
    return;
  }

  const forceRefresh = req.query.refresh === '1';

  try {
    const sites = await loadTvboxCmsSites(url.trim(), { forceRefresh });
    res.json({
      success: true,
      sites: sites.map((site) => ({
        key: site.key,
        name: site.name,
        api: site.api,
        searchable: site.searchable,
      })),
    });
  } catch (err) {
    console.error('[cms] inspect error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '拉取配置失败',
    });
  }
});

export default router;
