/**
 * B站 番剧相关路由（需登录态，由父路由统一 authenticateToken）。
 *
 *   GET /bilibili/following-bangumi  关注的番剧列表
 *   GET /bilibili/bangumi-episodes   番剧集数列表
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { bilibiliFetch } from '../../services/bilibili/client';
import {
  getCachedUserInfo,
  setCachedUserInfo,
} from '../../services/bilibili/cache';
import {
  getUserCookie,
  normalizeBilibiliImageUrl,
  extractMidFromCookie,
  type BilibiliNavData,
} from './helpers';

const router = Router();

// 获取当前登录账号已关注的番剧列表
router.get('/bilibili/following-bangumi', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.userId;
  const cookie = await getUserCookie(userId);
  if (!cookie) {
    res.status(401).json({ success: false, message: '未登录 B站' });
    return;
  }

  const userIdStr = String(userId);
  let mid = extractMidFromCookie(cookie);

  // 如果 Cookie 中没有 DedeUserID，尝试从缓存或 nav 接口获取
  if (!mid) {
    const cached = getCachedUserInfo(userIdStr);
    if (cached?.mid) {
      mid = String(cached.mid);
    } else {
      try {
        const nav = await bilibiliFetch<BilibiliNavData>(
          'https://api.bilibili.com/x/web-interface/nav',
          { cookie },
        );
        if (nav.data.mid) {
          mid = String(nav.data.mid);
          setCachedUserInfo(userIdStr, {
            name: nav.data.uname || '',
            avatar: normalizeBilibiliImageUrl(nav.data.face || ''),
            mid: nav.data.mid,
          });
        }
      } catch (err) {
        console.error('[bilibili] following-bangumi fetch mid error:', err);
      }
    }
  }

  if (!mid) {
    res.status(400).json({ success: false, message: '无法获取 B站 用户 ID' });
    return;
  }

  try {
    const page =
      typeof req.query.page === 'string' && req.query.page.trim()
        ? Number(req.query.page.trim())
        : 1;
    const pageSize =
      typeof req.query.pageSize === 'string' && req.query.pageSize.trim()
        ? Number(req.query.pageSize.trim())
        : 50;
    const pn = Number.isFinite(page) && page > 0 ? page : 1;
    const ps = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 50;

    interface AppBangumiItem {
      title?: string;
      cover?: string;
      param?: string;
      uri?: string;
      newest_ep_index?: string;
      total_count?: string | number;
      index?: string;
    }

    // 原 web 接口 x/space/bangumi/follow/list 已返回 -400，改为可用的 app 端接口
    const bangumiRes = await bilibiliFetch<{
      count?: number;
      item?: AppBangumiItem[];
    }>(
      `https://app.bilibili.com/x/v2/space/bangumi?vmid=${mid}&pn=${pn}&ps=${ps}`,
      { cookie },
    );

    const rawList = Array.isArray(bangumiRes.data.item)
      ? bangumiRes.data.item
      : [];
    const list = rawList.map((item: any) => {
      const seasonId =
        Number(item.param) ||
        Number(item.uri?.split('/').pop()) ||
        0;
      return {
        seasonId,
        title: item.title || '',
        cover: normalizeBilibiliImageUrl(item.cover || ''),
        progress: item.newest_ep_index || item.index || '',
        total: Number(item.total_count) || 0,
      };
    });

    res.json({ success: true, list });
  } catch (err) {
    console.error('[bilibili] following-bangumi error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取关注番剧列表失败',
    });
  }
});

// 获取指定番剧的集数列表
router.get('/bilibili/bangumi-episodes', async (req: AuthenticatedRequest, res: Response) => {
  const seasonId = req.query.seasonId;
  if (typeof seasonId !== 'string' || !seasonId.trim()) {
    res.status(400).json({ success: false, message: '缺少 seasonId 参数' });
    return;
  }

  const userId = req.user?.userId;
  const cookie = (await getUserCookie(userId)) || undefined;

  try {
    interface BangumiSeasonResult {
      episodes?: any[];
      main_section?: { episodes?: any[] };
      section?: { episodes?: any[] }[];
    }

    const data = await bilibiliFetch<{
      result?: BangumiSeasonResult;
    }>(
      `https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId.trim()}`,
      { cookie },
    );

    // pgc/view/web/season 实际返回 { code, message, result }
    // 同时兼容旧代码期望的 { code, message, data: { result } }
    const result =
      (data as unknown as { result?: BangumiSeasonResult }).result ??
      data.data?.result;

    let rawEpisodes: any[] = [];
    if (result) {
      rawEpisodes =
        result.episodes || result.main_section?.episodes || [];
      if (!rawEpisodes.length && Array.isArray(result.section)) {
        rawEpisodes = result.section.flatMap((s) => s.episodes || []);
      }
    }

    const episodes = rawEpisodes.map((ep: any, idx: number) => ({
      bvid: ep.bvid || '',
      cid: ep.cid || 0,
      title:
        [ep.title_format, ep.long_title].filter(Boolean).join(' ') ||
        ep.long_title ||
        ep.title ||
        '',
      index: ep.title || ep.index || idx + 1,
    }));

    res.json({ success: true, episodes });
  } catch (err) {
    console.error('[bilibili] bangumi-episodes error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取番剧集数失败',
    });
  }
});

export default router;
