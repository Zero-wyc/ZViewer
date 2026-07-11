import { Router, Response } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  listDanmakuSources,
  getDanmakuProvider,
  DanmakuEpisode,
} from '../services/danmaku';

const router = Router();

router.use(authenticateToken);

// 列出可用弹幕源
router.get('/sources', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const sources = listDanmakuSources();
    res.json({ success: true, sources });
  } catch (err) {
    console.error('[danmaku] list sources error:', err);
    res.status(500).json({ success: false, message: '获取弹幕源列表失败' });
  }
});

// 搜索番剧/视频
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

  const provider = getDanmakuProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的弹幕源' });
    return;
  }

  try {
    const results = await provider.search(keyword.trim());
    res.json({ success: true, results });
  } catch (err) {
    console.error('[danmaku] search error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '搜索弹幕源失败',
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

  const provider = getDanmakuProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的弹幕源' });
    return;
  }

  try {
    const episodes = await provider.getEpisodes(identifier.trim());
    res.json({ success: true, episodes });
  } catch (err) {
    console.error('[danmaku] episodes error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取集数列表失败',
    });
  }
});

// 获取弹幕
router.post('/fetch', async (req: AuthenticatedRequest, res: Response) => {
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

  const provider = getDanmakuProvider(source.trim());
  if (!provider) {
    res.status(400).json({ success: false, message: '未知的弹幕源' });
    return;
  }

  const normalized: DanmakuEpisode = {
    id: String(episode.id ?? ''),
    title: String(episode.title ?? ''),
    episodeNumber: Number(episode.episodeNumber) || 1,
    playbackParams:
      episode.playbackParams && typeof episode.playbackParams === 'object'
        ? (episode.playbackParams as Record<string, unknown>)
        : {},
  };

  try {
    const danmaku = await provider.getDanmaku(normalized);
    res.json({
      success: true,
      danmaku: danmaku.map((item) => ({
        id: item.id,
        content: item.content,
        time: item.time,
        mode: item.mode,
        color: item.color,
        size: item.size,
      })),
    });
  } catch (err) {
    console.error('[danmaku] fetch error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取弹幕失败',
    });
  }
});

export default router;
