import { bilibiliFetch } from './client';
import { getWbiKeys, signParams, clearWbiKeyCache } from './wbi';
import {
  computeFnval,
  QN_QUALITY_MAP,
  DEFAULT_QN,
} from './permission';

export interface DashMediaTrack {
  baseUrl: string;
  /** B站 返回的备用播放地址列表。 */
  backupUrl?: string[];
  bandwidth: number;
  codecs: string;
  id: number;
}

export interface DurlSegment {
  url: string;
  size: number;
  length: number;
}

export interface BilibiliPlayUrlResult {
  /** 返回格式：dash 或 mp4。 */
  format: 'dash' | 'mp4';
  /** DASH 视频轨道，按带宽降序排列。 */
  video?: DashMediaTrack[];
  /** DASH 音频轨道，按带宽降序排列。 */
  audio?: DashMediaTrack[];
  /** MP4 直链分片。 */
  durl?: DurlSegment[];
  /** 最佳视频轨道。 */
  bestVideo?: DashMediaTrack;
  /** 最佳音频轨道。 */
  bestAudio?: DashMediaTrack;
  /** 当前请求的清晰度。 */
  currentQn?: number;
  /** 视频可用清晰度列表。 */
  acceptQuality?: { id: number; label: string; resolution?: string }[];
}

interface RawDashMedia {
  baseUrl?: string;
  base_url?: string;
  /** B站 通常会返回备用播放地址，可能指向不同 CDN。 */
  backupUrl?: string[];
  backup_url?: string[];
  id: number;
  codecs: string;
  bandwidth: number;
}

interface RawAcceptDescription {
  qn: number;
  desc: string;
}

interface RawPlayUrlData {
  durl?: Array<{ url: string; size: number; length: number }>;
  dash?: {
    video?: RawDashMedia[];
    audio?: RawDashMedia[];
  };
  accept_quality?: number[];
  accept_description?: RawAcceptDescription[];
}

export interface GetPlayUrlOptions {
  qn?: number;
  fnval?: number;
  /** 优先返回 URL 中包含该字符串的 CDN 轨道。 */
  preferCdn?: string;
  /** 是否为大会员，用于动态计算 fnval。 */
  isVip?: boolean;
}

export class NoPermissionError extends Error {
  constructor(message = '无权限播放，可能需要大会员') {
    super(message);
    this.name = 'NoPermissionError';
  }
}

const DEFAULT_FOURK = 1;

function buildQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');
}

function sortByBandwidthDesc<T extends { bandwidth: number }>(tracks?: T[]): T[] {
  if (!tracks) return [];
  return [...tracks].sort((a, b) => b.bandwidth - a.bandwidth);
}

/**
 * 对 DASH 轨道按 preferred CDN 排序：URL 包含 preferCdn 的轨道排在前面。
 * 没有任何匹配时保持原有排序。
 */
function sortTracksByPreferredCdn<T extends { baseUrl: string }>(
  tracks: T[] | undefined,
  preferCdn: string,
): T[] {
  if (!tracks || tracks.length === 0) return [];
  const lower = preferCdn.toLowerCase();
  const preferred: T[] = [];
  const others: T[] = [];
  for (const track of tracks) {
    if (track.baseUrl.toLowerCase().includes(lower)) {
      preferred.push(track);
    } else {
      others.push(track);
    }
  }
  return preferred.length > 0 ? [...preferred, ...others] : tracks;
}

/**
 * 判断 codec 是否为兼容性最好的 H.264 (avc)。
 */
function isAvcCodec(codecs?: string): boolean {
  return typeof codecs === 'string' && /^avc\d/i.test(codecs.trim());
}

/**
 * 对 DASH 轨道排序：优先保留 H.264 轨道并按带宽降序，
 * 若没有 H.264 轨道则回退到原始排序。
 */
function sortDashTracks<T extends { bandwidth: number; codecs: string }>(
  tracks?: T[],
): T[] {
  const sorted = sortByBandwidthDesc(tracks);
  const avcTracks = sorted.filter((t) => isAvcCodec(t.codecs));
  return avcTracks.length > 0 ? avcTracks : sorted;
}

/**
 * 部分网络环境无法连接 B站 mcdn P2P CDN 的 8082 端口，
 * 去掉该端口让请求走默认 443 端口，提升连通率。
 */
function rewriteMcdnPort(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('.mcdn.bilivideo.cn') && parsed.port === '8082') {
      parsed.port = '';
      return parsed.toString();
    }
  } catch {
    // 非法 URL 直接返回原值
  }
  return url;
}

function normalizeDashMedia(track: RawDashMedia): DashMediaTrack {
  const baseUrl = track.baseUrl ?? track.base_url ?? '';
  const backupUrls = track.backupUrl ?? track.backup_url;
  return {
    baseUrl: rewriteMcdnPort(baseUrl),
    backupUrl: backupUrls?.map(rewriteMcdnPort),
    bandwidth: track.bandwidth,
    codecs: track.codecs,
    id: track.id,
  };
}

function buildAcceptQuality(
  acceptQuality: number[] | undefined,
  acceptDescription: RawAcceptDescription[] | undefined,
  currentQn: number,
): { id: number; label: string; resolution?: string }[] {
  const descMap = new Map<number, string>();
  if (acceptDescription) {
    for (const d of acceptDescription) {
      descMap.set(d.qn, d.desc);
    }
  }

  const qns = acceptQuality?.length
    ? acceptQuality
    : acceptDescription?.length
      ? acceptDescription.map((d) => d.qn)
      : [currentQn];

  return qns.map((qn) => {
    const fallback = QN_QUALITY_MAP[qn];
    const label = descMap.get(qn) ?? fallback?.label ?? String(qn);
    return {
      id: qn,
      label,
      resolution: fallback?.resolution,
    };
  });
}

function normalizePlayUrlData(
  data?: RawPlayUrlData,
  currentQn?: number,
): BilibiliPlayUrlResult | null {
  if (!data) return null;

  const qn = currentQn ?? DEFAULT_QN;
  const acceptQuality = buildAcceptQuality(
    data.accept_quality,
    data.accept_description,
    qn,
  );

  if (data.dash?.video?.length) {
    const video = sortDashTracks(data.dash.video.map(normalizeDashMedia));
    const audio = sortByBandwidthDesc(data.dash.audio?.map(normalizeDashMedia));
    return {
      format: 'dash',
      video,
      audio,
      bestVideo: video[0],
      bestAudio: audio[0],
      currentQn: qn,
      acceptQuality,
    };
  }

  if (data.durl?.length) {
    return {
      format: 'mp4',
      durl: data.durl.map((d) => ({
        url: d.url,
        size: d.size,
        length: d.length,
      })),
      currentQn: qn,
      acceptQuality,
    };
  }

  throw new NoPermissionError();
}

/**
 * 使用 WBI 签名调用 /x/player/wbi/playurl 获取播放地址。
 */
async function getPlayUrlWbi(
  bvid: string,
  cid: number,
  cookie?: string,
  options?: GetPlayUrlOptions,
): Promise<BilibiliPlayUrlResult | null> {
  const isVip = options?.isVip ?? false;
  const effectiveQn = options?.qn ?? DEFAULT_QN;
  const effectiveFnval = options?.fnval ?? computeFnval(isVip, effectiveQn);
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams(
    {
      bvid,
      cid: String(cid),
      qn: String(effectiveQn),
      fnver: '0',
      fnval: String(effectiveFnval),
      fourk: String(DEFAULT_FOURK),
    },
    imgKey,
    subKey,
  );
  const query = buildQueryString(signed);

  const res = await bilibiliFetch<RawPlayUrlData>(
    `https://api.bilibili.com/x/player/wbi/playurl?${query}`,
    { cookie },
  );

  const result = normalizePlayUrlData(res.data, effectiveQn);
  if (result && options?.preferCdn) {
    result.video = sortTracksByPreferredCdn(result.video, options.preferCdn);
    result.audio = sortTracksByPreferredCdn(result.audio, options.preferCdn);
    result.bestVideo = result.video?.[0];
    result.bestAudio = result.audio?.[0];
  }
  return result;
}

/**
 * 使用未签名接口 /x/player/playurl 作为降级方案。
 */
async function getPlayUrlLegacy(
  bvid: string,
  cid: number,
  cookie?: string,
  options?: GetPlayUrlOptions,
): Promise<BilibiliPlayUrlResult | null> {
  const isVip = options?.isVip ?? false;
  const effectiveQn = options?.qn ?? DEFAULT_QN;
  const effectiveFnval = options?.fnval ?? computeFnval(isVip, effectiveQn);
  const params = new URLSearchParams({
    bvid,
    cid: String(cid),
    qn: String(effectiveQn),
    fnver: '0',
    fnval: String(effectiveFnval),
    fourk: String(DEFAULT_FOURK),
  });

  const res = await bilibiliFetch<RawPlayUrlData>(
    `https://api.bilibili.com/x/player/playurl?${params.toString()}`,
    { cookie },
  );

  const result = normalizePlayUrlData(res.data, effectiveQn);
  if (result && options?.preferCdn) {
    result.video = sortTracksByPreferredCdn(result.video, options.preferCdn);
    result.audio = sortTracksByPreferredCdn(result.audio, options.preferCdn);
    result.bestVideo = result.video?.[0];
    result.bestAudio = result.audio?.[0];
  }
  return result;
}

function isPermissionError(err: unknown): boolean {
  if (err instanceof NoPermissionError) return true;
  const message = String(err instanceof Error ? err.message : err);
  const permissionKeywords = ['大会员', '付费', '无权限', '购买', '权限', '登录'];
  if (permissionKeywords.some((k) => message.includes(k))) return true;
  if (message.includes('-10403')) return true;
  return false;
}

/**
 * 获取 B站 视频播放地址。
 * 优先使用 WBI 签名接口，失败时自动降级到未签名接口。
 */
export async function getPlayUrl(
  bvid: string,
  cid: number,
  cookie?: string,
  options?: GetPlayUrlOptions,
): Promise<BilibiliPlayUrlResult | null> {
  try {
    return await getPlayUrlWbi(bvid, cid, cookie, options);
  } catch (err) {
    if (isPermissionError(err)) {
      throw new NoPermissionError();
    }
    console.warn('[bilibili] WBI playurl 失败，降级到未签名接口:', err);
    clearWbiKeyCache();
    try {
      return await getPlayUrlLegacy(bvid, cid, cookie, options);
    } catch (err2) {
      if (isPermissionError(err2)) {
        throw new NoPermissionError();
      }
      throw err2;
    }
  }
}
