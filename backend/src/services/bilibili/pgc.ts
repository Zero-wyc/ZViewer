/**
 * B站 番剧/影视（PGC）服务层。
 *
 * 职责：
 * - ep/ss → 整季信息（pgc/view/web/season，含分集 ep_id/cid/badge/权威时长）
 * - PGC 播放地址（pgc/player/web/playurl v1，SESSDATA Cookie 鉴权，无 WBI）
 * - PGC 业务错误归一（-403 付费/大会员专享、-404 已下架、-10403 地区限制等）
 *
 * 复用 playurl.ts 的 normalizePlayUrlData：实测 PGC 的 dash/durl 结构与 UGC
 * 一致（dash.video[].id 即 qn、durl 为 MP4 直链分段），仅响应载荷字段位置
 * 不同——PGC 在顶层 result，UGC 在 data。
 *
 * 实测结论（2026-10-06，匿名态）：
 * - 免费集 MP4(fnval=1) 完整可播（匿名 360P），platform=html5/try_look 对
 *   PGC 无效果差异，不传；
 * - 会员专享集匿名请求 MP4/DASH 均回落为试看 MP4（durl），且 API 虚报
 *   timelength 为完整时长——试看判定不能依赖 timelength（见 resolver.ts）。
 */

import { bilibiliFetch } from './client';
import { normalizePlayUrlData, type BilibiliPlayUrlResult } from './playurl';
import { getCachedSeasonByEpId, setCachedSeasonByEpId } from './cache';

export interface PgcEpisodeInfo {
  epId: number;
  cid: number;
  bvid: string;
  aid?: number;
  /** 集序号标题，如 "1"、"2" */
  title: string;
  /** 集名，如 "用俄语说真心话的艾莉同学" */
  longTitle?: string;
  /** B站 badge：''=免费集，'会员'=大会员专享，'限免' 等 */
  badge: string;
  /** 集状态：2=已上线可播，其他值（未开播/已下架等）不可选 */
  status: number;
  /** 集时长（秒，由 season 接口毫秒值换算，作为权威时长） */
  durationSec: number;
}

export interface PgcSeasonInfo {
  seasonId: number;
  title: string;
  cover?: string;
  episodes: PgcEpisodeInfo[];
}

/** PGC 接口错误（code 为归一化错误码，resolver 据此转 ResolveError）。 */
export class PgcError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'PgcError';
    this.code = code;
  }
}

interface PgcEpisodeRaw {
  id?: number;
  ep_id?: number;
  cid?: number;
  bvid?: string;
  aid?: number;
  badge?: string;
  status?: number;
  duration?: number;
  title?: string;
  long_title?: string;
}

interface PgcSeasonResult {
  season_id?: number;
  title?: string;
  cover?: string;
  episodes?: PgcEpisodeRaw[];
  main_section?: { episodes?: PgcEpisodeRaw[] };
  section?: { episodes?: PgcEpisodeRaw[] }[];
}

/** PGC playurl 响应载荷（结构与 UGC 的 RawPlayUrlData 一致） */
interface PgcPlayUrlPayload {
  durl?: Array<{ url: string; size: number; length: number }>;
  dash?: {
    video?: Array<{
      baseUrl?: string;
      base_url?: string;
      backupUrl?: string[];
      backup_url?: string[];
      id: number;
      codecs: string;
      bandwidth: number;
    }>;
    audio?: Array<{
      baseUrl?: string;
      base_url?: string;
      backupUrl?: string[];
      backup_url?: string[];
      id: number;
      codecs: string;
      bandwidth: number;
    }>;
  };
  quality?: number;
  accept_quality?: number[];
  accept_description?: Array<{ qn: number; desc: string }>;
}

interface PgcEnvelope<R> {
  code?: number;
  message?: string;
  result?: R;
  data?: { result?: R };
}

function normalizeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

function mapEpisodes(rawEpisodes: PgcEpisodeRaw[]): PgcEpisodeInfo[] {
  return rawEpisodes
    .map((item, idx) => {
      const durationMs = item.duration ?? 0;
      return {
        epId: Number(item.ep_id ?? item.id ?? 0),
        cid: Number(item.cid ?? 0),
        bvid: item.bvid || '',
        aid: item.aid,
        title: item.title || String(idx + 1),
        longTitle: item.long_title || undefined,
        badge: item.badge || '',
        status: item.status ?? 2,
        durationSec: Math.round(durationMs / 1000),
      };
    })
    .filter((ep) => ep.epId > 0 && ep.cid > 0);
}

async function fetchSeasonByQuery(
  query: string,
  cookie?: string,
): Promise<PgcSeasonInfo> {
  let json: PgcEnvelope<PgcSeasonResult>;
  try {
    json = (await bilibiliFetch<unknown>(
      `https://api.bilibili.com/pgc/view/web/season?${query}`,
      { cookie },
    )) as unknown as PgcEnvelope<PgcSeasonResult>;
  } catch (err) {
    throw mapPgcBizError(err);
  }

  const result = json.result ?? json.data?.result;
  if (!result) {
    throw new PgcError('获取番剧信息失败', 'INFO_FAILED');
  }

  let rawEpisodes: PgcEpisodeRaw[] = [];
  if (result.episodes && result.episodes.length > 0) {
    rawEpisodes = result.episodes;
  } else if (result.main_section?.episodes && result.main_section.episodes.length > 0) {
    rawEpisodes = result.main_section.episodes;
  } else if (Array.isArray(result.section)) {
    rawEpisodes = result.section.flatMap((s) => s.episodes || []);
  }

  const episodes = mapEpisodes(rawEpisodes);
  if (episodes.length === 0) {
    throw new PgcError('该番剧暂无可用分集', 'EP_NOT_FOUND');
  }

  return {
    seasonId: Number(result.season_id) || 0,
    title: result.title || '',
    cover: normalizeImageUrl(result.cover),
    episodes,
  };
}

/**
 * 按 ep_id 反查整季信息（带缓存，TTL 10 分钟）。
 * season 接口对 ep_id 返回整季上下文，含每集 ep_id/cid/badge/duration。
 */
export async function fetchSeasonByEpId(
  epId: number,
  cookie?: string,
): Promise<PgcSeasonInfo> {
  const cached = getCachedSeasonByEpId(epId);
  if (cached) {
    console.log('[bilibili-pgc] season served from cache: ep_id=%d', epId);
    return cached;
  }
  const info = await fetchSeasonByQuery(`ep_id=${epId}`, cookie);
  setCachedSeasonByEpId(epId, info);
  return info;
}

/** 按 season_id 获取整季信息（ss 链接入口）。 */
export async function fetchSeasonBySeasonId(
  seasonId: number,
  cookie?: string,
): Promise<PgcSeasonInfo> {
  return fetchSeasonByQuery(`season_id=${seasonId}`, cookie);
}

/**
 * 将 bilibiliFetch 抛出的业务错误归一为 PgcError。
 *
 * bilibiliFetch 的错误消息形如 "B站 API 业务错误 [-403] 大会员专享: url"。
 */
function mapPgcBizError(err: unknown): Error {
  const msg = String(err instanceof Error ? err.message : err);
  if (msg.includes('[-404]')) {
    return new PgcError('该番剧或集数不存在/已下架', 'EP_NOT_FOUND');
  }
  if (msg.includes('[-403]') || msg.includes('[-514]')) {
    return new PgcError(
      '该内容为付费影视或大会员专享，请使用大会员账号解析',
      'NO_PERMISSION',
    );
  }
  if (msg.includes('[-10403]') || msg.includes('地区')) {
    return new PgcError('该内容存在地区观看限制', 'REGION_LIMITED');
  }
  if (msg.includes('[-101]') || msg.includes('账号未登录')) {
    return new PgcError(
      '获取 480P 以上清晰度需要登录 B站 账号',
      'NOT_LOGGED_IN',
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/**
 * 获取 PGC 播放地址（pgc/player/web/playurl v1）。
 *
 * - 鉴权：SESSDATA Cookie（480P+ 需登录，会员专享内容需大会员）；
 * - 不带 platform=html5 / high_quality / try_look（实测对 PGC 无效果差异）；
 * - fnval 语义与 UGC 一致：16/80/4048=DASH，1=MP4 durl；
 * - 载荷直接交给 normalizePlayUrlData 复用轨道过滤/排序/清晰度构建。
 */
export async function getPgcPlayUrl(params: {
  epId: number;
  cid: number;
  cookie?: string;
  qn: number;
  fnval: number;
  codec?: string;
}): Promise<BilibiliPlayUrlResult | null> {
  const qs = new URLSearchParams({
    ep_id: String(params.epId),
    cid: String(params.cid),
    qn: String(params.qn),
    fnver: '0',
    fnval: String(params.fnval),
    fourk: '1',
  });

  let json: PgcEnvelope<PgcPlayUrlPayload>;
  try {
    json = (await bilibiliFetch<unknown>(
      `https://api.bilibili.com/pgc/player/web/playurl?${qs.toString()}`,
      { cookie: params.cookie },
    )) as unknown as PgcEnvelope<PgcPlayUrlPayload>;
  } catch (err) {
    throw mapPgcBizError(err);
  }

  const result = json.result ?? json.data?.result;
  if (!result) return null;
  return normalizePlayUrlData(result, params.qn, params.codec);
}
