import { Router, Response } from 'express';
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
    res.json({ success: true, url: result.url, headers: result.headers });
  } catch (err) {
    console.error('[animeSources] resolve error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '解析播放地址失败',
    });
  }
});

export default router;
