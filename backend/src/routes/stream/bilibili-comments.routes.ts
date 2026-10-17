/**
 * B站 视频评论区路由（哔哩哔哩歌词播放页，需登录态由父路由统一校验）。
 *
 *   GET /bilibili/comments         主楼评论列表（游标分页）
 *   GET /bilibili/comment-replies  楼中楼回复（pn 分页）
 *
 * 主楼走现行 web 接口 x/v2/reply/main（需 WBI 签名 + buvid cookie；旧版
 * x/v2/reply 的 pn 分页已废——实测 pn>1 恒空、ps 大值无效）。
 * 未登录游客 B站 仅开放前 3 条主楼（is_end 提前为 true），登录态完整分页；
 * 楼中楼 x/v2/reply/reply 旧版 pn 分页匿名可用。
 */

import { Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { bilibiliFetch } from '../../services/bilibili/client';
import { getVideoInfo } from '../../services/bilibili/video';
import { getWbiKeys, signParams } from '../../services/bilibili/wbi';
import { DEFAULT_PROXY_UA } from '../../services/proxy';
import { getUserCookie, normalizeBilibiliImageUrl } from './helpers';
import { TtlCache } from '../../utils/ttl-cache';

const router = Router();

/** 评论条目（主楼 / 楼中楼通用归一化结构） */
interface BiliCommentItem {
  rpid: number;
  mid: number;
  name: string;
  avatar: string;
  content: string;
  /** 发布时间（秒级 Unix） */
  time: number;
  like: number;
  replyCount: number;
  /** 表情映射：键为 [名称] 原文，值为表情图 URL（前端经代理渲染） */
  emote: Record<string, string>;
  /** IP 属地（如「广东」，可能为空） */
  location: string;
}

/** reply/main 与 reply/reply 的原始回复结构（字段子集） */
interface BiliReplyRaw {
  rpid?: number;
  mid?: number;
  like?: number;
  rcount?: number;
  ctime?: number;
  member?: { uname?: string; avatar?: string };
  content?: {
    message?: string;
    emote?: Record<string, { url?: string }> | null;
  };
  reply_control?: { location?: string };
}

function mapBiliReplyItem(r: BiliReplyRaw): BiliCommentItem | null {
  if (!r || !r.rpid) return null;
  const emote: Record<string, string> = {};
  for (const [key, value] of Object.entries(r.content?.emote ?? {})) {
    if (value?.url) emote[key] = normalizeBilibiliImageUrl(value.url);
  }
  return {
    rpid: r.rpid,
    mid: r.mid ?? 0,
    name: r.member?.uname || '',
    avatar: normalizeBilibiliImageUrl(r.member?.avatar || ''),
    content: r.content?.message || '',
    time: r.ctime ?? 0,
    like: r.like ?? 0,
    replyCount: r.rcount ?? 0,
    emote,
    location: (r.reply_control?.location || '').replace(/^IP属地[:：]\s*/, ''),
  };
}

/** buvid3/buvid4 cookie 模块级缓存（finger/spi 一次拉取，进程内复用）。
 *  reply/main 缺 buvid 时命中 -352 风控 */
let buvidCookieCache = '';

async function getBuvidCookie(): Promise<string> {
  if (buvidCookieCache) return buvidCookieCache;
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: {
        'User-Agent': DEFAULT_PROXY_UA,
        Referer: 'https://www.bilibili.com',
      },
    });
    const json = (await res.json()) as {
      data?: { b_3?: string; b_4?: string };
    };
    if (json.data?.b_3) {
      buvidCookieCache = `buvid3=${json.data.b_3}`;
      if (json.data.b_4) buvidCookieCache += `; buvid4=${json.data.b_4}`;
    }
  } catch {
    // 静默：取不到时靠用户登录 cookie 兜底
  }
  return buvidCookieCache;
}

/** bvid → aid + 评论总数（10 分钟缓存；主楼/楼中楼分页都要 oid） */
const biliAidCache = new TtlCache<{ aid: number; reply: number }>({
  ttlMs: 10 * 60_000,
  maxSize: 128,
});

async function resolveBiliAid(
  bvid: string,
  cookie?: string,
): Promise<{ aid: number; reply: number }> {
  const cached = biliAidCache.get(bvid);
  if (cached) return cached;
  const info = await getVideoInfo(bvid, cookie);
  if (!info?.aid) throw new Error('视频不存在');
  const value = { aid: info.aid, reply: info.stat?.reply ?? 0 };
  biliAidCache.set(bvid, value);
  return value;
}

/** 组装评论请求 cookie：用户登录态 + buvid（游客风控） */
async function buildBiliCommentCookie(
  userId: string | number | undefined,
): Promise<{ cookie?: string; hasUserCookie: boolean }> {
  const userCookie = await getUserCookie(userId);
  const buvid = await getBuvidCookie();
  const cookie = [userCookie, buvid].filter(Boolean).join('; ') || undefined;
  return { cookie, hasUserCookie: !!userCookie };
}

// GET /bilibili/comments?bvid=&mode=&next=  主楼评论列表
// mode: 2=按时间（最新，游标分页）/ 3=按热度（热评，通常只取首页）
router.get('/bilibili/comments', async (req: AuthenticatedRequest, res) => {
  const bvid = typeof req.query.bvid === 'string' ? req.query.bvid.trim() : '';
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    res.status(400).json({ success: false, message: 'BV 号格式无效' });
    return;
  }
  const mode = req.query.mode === '3' ? '3' : '2';
  const nextRaw = Math.floor(Number(req.query.next));
  const next = Number.isFinite(nextRaw) && nextRaw > 0 ? nextRaw : 0;
  const userId = req.user?.userId;
  try {
    const { cookie, hasUserCookie } = await buildBiliCommentCookie(userId);
    const { aid, reply } = await resolveBiliAid(bvid, cookie);
    const { imgKey, subKey } = await getWbiKeys(cookie);
    const signed = signParams(
      {
        oid: String(aid),
        type: '1',
        mode,
        next: String(next),
        ps: '20',
        plat: '1',
        web_location: '1315875',
      },
      imgKey,
      subKey,
    );
    const body = await bilibiliFetch<{
      cursor?: { all_count?: number; next?: number; is_end?: boolean };
      replies?: BiliReplyRaw[] | null;
    }>(
      `https://api.bilibili.com/x/v2/reply/main?${new URLSearchParams(signed).toString()}`,
      { cookie },
    );
    const cursor = body.data?.cursor;
    const replies = (body.data?.replies ?? [])
      .map(mapBiliReplyItem)
      .filter((r): r is BiliCommentItem => r !== null);
    let nextCursor: number | null = null;
    if (cursor && !cursor.is_end && typeof cursor.next === 'number') {
      nextCursor = cursor.next;
    }
    res.json({
      success: true,
      total: cursor?.all_count ?? reply,
      replies,
      next: nextCursor,
      loginLimited: !hasUserCookie,
    });
  } catch (err) {
    console.error('[bilibili] comments error:', err);
    res.status(502).json({
      success: false,
      message: err instanceof Error ? err.message : '获取评论失败',
    });
  }
});

// GET /bilibili/comment-replies?bvid=&rpid=&pn=&ps=  楼中楼回复（pn 分页）
router.get(
  '/bilibili/comment-replies',
  async (req: AuthenticatedRequest, res) => {
    const bvid =
      typeof req.query.bvid === 'string' ? req.query.bvid.trim() : '';
    const rpid = Math.floor(Number(req.query.rpid));
    const pn = Math.max(Math.floor(Number(req.query.pn)) || 1, 1);
    const ps = Math.min(
      Math.max(Math.floor(Number(req.query.ps)) || 10, 1),
      20,
    );
    if (
      !/^BV[0-9A-Za-z]{10}$/.test(bvid) ||
      !Number.isFinite(rpid) ||
      rpid <= 0
    ) {
      res.status(400).json({ success: false, message: '参数无效' });
      return;
    }
    const userId = req.user?.userId;
    try {
      const { cookie } = await buildBiliCommentCookie(userId);
      const { aid } = await resolveBiliAid(bvid, cookie);
      const body = await bilibiliFetch<{
        page?: { count?: number };
        replies?: BiliReplyRaw[] | null;
      }>(
        `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${rpid}&pn=${pn}&ps=${ps}`,
        { cookie },
      );
      const replies = (body.data?.replies ?? [])
        .map(mapBiliReplyItem)
        .filter((r): r is BiliCommentItem => r !== null);
      res.json({
        success: true,
        total: body.data?.page?.count ?? 0,
        replies,
      });
    } catch (err) {
      console.error('[bilibili] comment-replies error:', err);
      res.status(502).json({
        success: false,
        message: err instanceof Error ? err.message : '获取回复失败',
      });
    }
  },
);

export default router;
