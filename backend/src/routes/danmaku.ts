import { Router, Response } from 'express';
import {
  authenticateToken,
  AuthenticatedRequest,
} from '../middleware/auth';
import {
  listDanmakuSources,
  getDanmakuProvider,
  DanmakuEpisode,
  DanmakuSearchResult,
  DanmakuProviderContext,
} from '../services/danmaku';
import { toTraditional, toSimplified } from '../services/danmaku/chinese-convert';
import { getCredential } from '../services/bilibili/credential';

const router = Router();

router.use(authenticateToken);

/**
 * 获取当前登录用户的 B站 Cookie，构造 Provider 上下文。
 * 用于 B站 搜索/WBI 签名等需登录态的接口；其他源忽略此字段。
 */
async function buildProviderContext(
  userId: string | number | undefined,
): Promise<DanmakuProviderContext> {
  if (userId === undefined || userId === null) return {};
  const credential = await getCredential(String(userId));
  if (!credential?.cookie) return {};
  return { cookie: credential.cookie };
}

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

  const originalKeyword = keyword.trim();
  // 生成简繁两种关键词，用于双语搜索
  // 巴哈姆特为繁体平台，简体关键词需转繁体才能命中
  // 弹弹play 部分场景简体更友好，繁体关键词需转简体
  const traditionalKeyword = toTraditional(originalKeyword);
  const simplifiedKeyword = toSimplified(originalKeyword);

  // 去重关键词列表（原文 + 繁体 + 简体），保持搜索顺序
  const keywords = [...new Set([originalKeyword, traditionalKeyword, simplifiedKeyword])];

  try {
    // 获取用户 B站 登录 Cookie，用于 B站 搜索/WBI 签名
    const ctx = await buildProviderContext(req.user?.userId);

    // 用所有关键词变体并行搜索，合并去重结果
    const searchResults = await Promise.allSettled(
      keywords.map((kw) => provider.search(kw, ctx))
    );

    // 收集成功的搜索结果
    const allResults: DanmakuSearchResult[] = [];
    let firstError: Error | null = null;
    for (const result of searchResults) {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      } else if (!firstError && result.reason instanceof Error) {
        firstError = result.reason;
      }
    }

    // 如果所有搜索都失败，抛出第一个错误
    if (allResults.length === 0 && firstError) {
      throw firstError;
    }

    // 按 id 去重（不同关键词变体可能搜到同一结果）
    const seen = new Set<string>();
    const deduped = allResults.filter((r) => {
      const key = r.id || r.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 模糊匹配排序：标题包含任一关键词变体的结果优先
    const lowerKeywords = keywords.map((k) => k.toLowerCase());
    const matched: DanmakuSearchResult[] = [];
    const others: DanmakuSearchResult[] = [];
    for (const r of deduped) {
      const titleLower = r.title.toLowerCase();
      const isMatched = lowerKeywords.some((k) => titleLower.includes(k));
      if (isMatched) {
        matched.push(r);
      } else {
        others.push(r);
      }
    }

    res.json({ success: true, results: [...matched, ...others] });
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
    const ctx = await buildProviderContext(req.user?.userId);
    const episodes = await provider.getEpisodes(identifier.trim(), ctx);
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
    const ctx = await buildProviderContext(req.user?.userId);
    const danmaku = await provider.getDanmaku(normalized, ctx);
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
