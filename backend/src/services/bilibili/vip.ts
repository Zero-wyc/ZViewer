import { bilibiliFetch } from './client';

interface BilibiliNavData {
  isLogin?: boolean;
  vipStatus?: number;
  vipType?: number;
}

interface VipCacheEntry {
  isVip: boolean;
  cachedAt: number;
}

const vipCache = new Map<string, VipCacheEntry>();
const VIP_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 判断给定 Cookie 对应的 B站 账号是否为大会员。
 * - 无 Cookie 或未登录时返回 false。
 * - 结果按 Cookie 缓存 5 分钟，避免每次解析都请求 nav 接口。
 */
export async function isBilibiliVip(cookie: string): Promise<boolean> {
  const trimmedCookie = cookie.trim();
  if (!trimmedCookie) {
    return false;
  }

  const cached = vipCache.get(trimmedCookie);
  if (cached && Date.now() - cached.cachedAt < VIP_CACHE_TTL_MS) {
    return cached.isVip;
  }

  try {
    const res = await bilibiliFetch<BilibiliNavData>(
      'https://api.bilibili.com/x/web-interface/nav',
      { cookie: trimmedCookie },
    );

    if (!res.data.isLogin) {
      vipCache.set(trimmedCookie, { isVip: false, cachedAt: Date.now() });
      return false;
    }

    const isVip = res.data.vipStatus === 1 || (res.data.vipType ?? 0) > 0;
    vipCache.set(trimmedCookie, { isVip, cachedAt: Date.now() });
    return isVip;
  } catch (err) {
    console.error('[bilibili] isBilibiliVip error:', err);
    return false;
  }
}
