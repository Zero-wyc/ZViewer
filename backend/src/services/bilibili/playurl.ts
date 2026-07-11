import { bilibiliFetch } from './client';
import { getWbiKeys, signParams, clearWbiKeyCache } from './wbi';

export interface DashMediaTrack {
  baseUrl: string;
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
  baseUrl: string;
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
}

export class NoPermissionError extends Error {
  constructor(message = '无权限播放，可能需要大会员') {
    super(message);
    this.name = 'NoPermissionError';
  }
}

const DEFAULT_QN = 127;
const DEFAULT_FNVAL = 4048;
const DEFAULT_FOURK = 1;

/** B站 清晰度 qn -> 标签/分辨率兜底映射。 */
const QN_QUALITY_MAP: Record<number, { label: string; resolution?: string }> = {
  127: { label: '8K 超高清', resolution: '7680x4320' },
  126: { label: '杜比视界', resolution: '3840x2160' },
  125: { label: 'HDR 真彩', resolution: '3840x2160' },
  120: { label: '4K 超清', resolution: '3840x2160' },
  116: { label: '1080P60', resolution: '1920x1080' },
  112: { label: '1080P+', resolution: '1920x1080' },
  80: { label: '1080P', resolution: '1920x1080' },
  74: { label: '720P60', resolution: '1280x720' },
  64: { label: '720P', resolution: '1280x720' },
  32: { label: '480P', resolution: '854x480' },
  16: { label: '360P', resolution: '640x360' },
};

/** 大会员专属清晰度 qn 列表。 */
export const VIP_ONLY_QNS = [112, 116, 120, 125, 126, 127];

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

function normalizeDashMedia(track: RawDashMedia): DashMediaTrack {
  return {
    baseUrl: track.baseUrl,
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
    const video = sortByBandwidthDesc(data.dash.video.map(normalizeDashMedia));
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
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams(
    {
      bvid,
      cid: String(cid),
      qn: String(options?.qn ?? DEFAULT_QN),
      fnver: '0',
      fnval: String(options?.fnval ?? DEFAULT_FNVAL),
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

  return normalizePlayUrlData(res.data, options?.qn ?? DEFAULT_QN);
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
  const params = new URLSearchParams({
    bvid,
    cid: String(cid),
    qn: String(options?.qn ?? DEFAULT_QN),
    fnver: '0',
    fnval: String(options?.fnval ?? DEFAULT_FNVAL),
    fourk: String(DEFAULT_FOURK),
  });

  const res = await bilibiliFetch<RawPlayUrlData>(
    `https://api.bilibili.com/x/player/playurl?${params.toString()}`,
    { cookie },
  );

  return normalizePlayUrlData(res.data, options?.qn ?? DEFAULT_QN);
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
