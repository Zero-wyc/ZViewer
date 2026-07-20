import { bilibiliFetch } from './client';
import { getCachedVipStatus, setCachedVipStatus } from './cache';

/**
 * Bilibili 权限识别统一模块
 * 归并会员状态查询、清晰度过滤、fnval 计算、默认清晰度选择
 */

/** 非会员默认清晰度：1080P */
export const DEFAULT_QN = 80;
/** 会员默认清晰度：4K 超清 */
export const VIP_DEFAULT_QN = 120;
/** 8K 清晰度 qn */
const QN_8K = 127;

/** VIP 专属清晰度列表（非会员不可用） */
export const VIP_ONLY_QNS = [112, 116, 120, 125, 126, 127];

/** qn 到标签/分辨率的兜底映射表 */
export const QN_QUALITY_MAP: Record<number, { label: string; resolution?: string }> = {
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

interface BilibiliNavData {
  isLogin?: boolean;
  vipStatus?: number;
  vipType?: number;
}

/**
 * 查询用户大会员状态。
 * 内部处理 !cookie 短路和缓存读写，不需要 checkVip 包装。
 */
export async function getVipStatus(cookie: string | undefined): Promise<boolean> {
  if (!cookie) return false;

  const trimmedCookie = cookie.trim();
  if (!trimmedCookie) return false;

  const cached = getCachedVipStatus(trimmedCookie);
  if (cached !== null) return cached;

  try {
    const res = await bilibiliFetch<BilibiliNavData>(
      'https://api.bilibili.com/x/web-interface/nav',
      { cookie: trimmedCookie },
    );

    if (!res.data.isLogin) {
      setCachedVipStatus(trimmedCookie, false);
      return false;
    }

    const isVip = res.data.vipStatus === 1 || (res.data.vipType ?? 0) > 0;
    setCachedVipStatus(trimmedCookie, isVip);
    return isVip;
  } catch (err) {
    console.error('[bilibili] getVipStatus error:', err);
    return false;
  }
}

/**
 * 根据会员状态过滤可用清晰度列表。
 * 非会员严格过滤 VIP_ONLY_QNS，过滤后为空时回退到 1080P。
 */
export function filterQualitiesByVip(
  list: { id: number; label: string; resolution?: string }[] | undefined,
  isVip: boolean,
): { id: number; label: string; resolution?: string }[] {
  const original = list ?? [];
  if (isVip) {
    return original;
  }
  // 非会员严格过滤 VIP 专属清晰度
  const filtered = original.filter((q) => !VIP_ONLY_QNS.includes(q.id));
  // 若过滤后为空，回退到 1080P 单条目
  if (filtered.length === 0) {
    return [{ id: 80, label: '1080P', resolution: '1920x1080' }];
  }
  return filtered;
}

/**
 * 根据 VIP 状态和请求的 qn 计算 fnval 位标志。
 * - 非会员：仅 DASH（16），不启用 4K
 * - 会员：DASH + 4K（80）
 * - 8K 请求：额外启用 8K 位（80 | 2048 = 2128）
 */
export function computeFnval(isVip: boolean, qn?: number): number {
  const dash = 16;        // DASH 格式
  const fourK = 64;       // 4K
  const eightK = 2048;    // 8K

  if (!isVip) {
    return dash;  // 非会员仅 DASH
  }

  let fnval = dash | fourK;  // 会员默认 DASH + 4K
  if (qn === QN_8K) {
    fnval |= eightK;  // 8K 请求加 8K 位
  }
  return fnval;
}

/**
 * 根据 VIP 状态返回默认清晰度。
 * 非会员 1080P（80），会员 4K（120）。
 */
export function getDefaultQn(isVip: boolean): number {
  return isVip ? VIP_DEFAULT_QN : DEFAULT_QN;
}
