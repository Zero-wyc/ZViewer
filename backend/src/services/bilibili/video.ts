import { bilibiliFetch } from './client';
import { getWbiKeys, signParams, clearWbiKeyCache } from './wbi';

export interface BilibiliVideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

export interface BilibiliVideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  duration: number;
  pages: BilibiliVideoPage[];
}

interface RawVideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

interface RawVideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  duration: number;
  pages?: RawVideoPage[];
}

function buildQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');
}

/**
 * 使用 WBI 签名调用 /x/web-interface/wbi/view 获取视频信息。
 */
async function getVideoInfoWbi(
  bvid: string,
  cookie?: string,
): Promise<BilibiliVideoInfo | null> {
  const { imgKey, subKey } = await getWbiKeys(cookie);
  const signed = signParams({ bvid }, imgKey, subKey);
  const query = buildQueryString(signed);

  const res = await bilibiliFetch<RawVideoInfo>(
    `https://api.bilibili.com/x/web-interface/wbi/view?${query}`,
    { cookie },
  );

  return normalizeVideoInfo(res.data);
}

/**
 * 使用未签名接口 /x/web-interface/view 作为降级方案。
 */
async function getVideoInfoLegacy(
  bvid: string,
  cookie?: string,
): Promise<BilibiliVideoInfo | null> {
  const res = await bilibiliFetch<RawVideoInfo>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    { cookie },
  );

  return normalizeVideoInfo(res.data);
}

function normalizeVideoInfo(data?: RawVideoInfo): BilibiliVideoInfo | null {
  if (!data) return null;
  return {
    bvid: data.bvid,
    aid: data.aid,
    cid: data.cid,
    title: data.title,
    duration: data.duration,
    pages: (data.pages || []).map((p) => ({
      cid: p.cid,
      page: p.page,
      part: p.part,
      duration: p.duration,
    })),
  };
}

/**
 * 获取 B站 视频信息。
 * 优先使用 WBI 签名接口，失败时自动降级到未签名接口。
 */
export async function getVideoInfo(
  bvid: string,
  cookie?: string,
): Promise<BilibiliVideoInfo | null> {
  try {
    return await getVideoInfoWbi(bvid, cookie);
  } catch (err) {
    console.warn('[bilibili] WBI view 失败，降级到未签名接口:', err);
    clearWbiKeyCache();
    return getVideoInfoLegacy(bvid, cookie);
  }
}
