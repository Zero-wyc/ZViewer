/**
 * B站 解析相关统一缓存模块。
 * 集中管理 VIP 状态、用户信息、视频信息等缓存，避免散落在各模块。
 * 每类缓存按各自的 TTL 自动过期。
 */

interface VipCacheEntry {
  isVip: boolean;
  cachedAt: number;
}

interface UserInfoCacheEntry {
  name: string;
  avatar: string;
  mid?: number;
  vipStatus?: number;
  vipType?: number;
  cachedAt: number;
}

interface VideoInfoCacheEntry {
  data: {
    bvid: string;
    aid: number;
    cid: number;
    title: string;
    duration: number;
    pages: { cid: number; page: number; part: string; duration: number }[];
  };
  cachedAt: number;
}

const vipCache = new Map<string, VipCacheEntry>();
const userInfoCache = new Map<string, UserInfoCacheEntry>();
const videoInfoCache = new Map<string, VideoInfoCacheEntry>();

const VIP_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const VIDEO_INFO_CACHE_TTL_MS = 2 * 60 * 1000;

export function getCachedVipStatus(cookie: string): boolean | null {
  const entry = vipCache.get(cookie);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= VIP_CACHE_TTL_MS) {
    vipCache.delete(cookie);
    return null;
  }
  return entry.isVip;
}

export function setCachedVipStatus(cookie: string, isVip: boolean): void {
  vipCache.set(cookie, { isVip, cachedAt: Date.now() });
}

export function getCachedUserInfo(userId: string): UserInfoCacheEntry | null {
  const entry = userInfoCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= USER_INFO_CACHE_TTL_MS) {
    userInfoCache.delete(userId);
    return null;
  }
  return entry;
}

export function setCachedUserInfo(
  userId: string,
  info: Omit<UserInfoCacheEntry, 'cachedAt'>,
): void {
  userInfoCache.set(userId, { ...info, cachedAt: Date.now() });
}

export function getCachedVideoInfo(bvid: string): VideoInfoCacheEntry['data'] | null {
  const entry = videoInfoCache.get(bvid);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt >= VIDEO_INFO_CACHE_TTL_MS) {
    videoInfoCache.delete(bvid);
    return null;
  }
  return entry.data;
}

export function setCachedVideoInfo(
  bvid: string,
  data: VideoInfoCacheEntry['data'],
): void {
  videoInfoCache.set(bvid, { data, cachedAt: Date.now() });
}

export function invalidateUserInfo(userId: string): void {
  userInfoCache.delete(userId);
}

export function invalidateVipCache(cookie: string): void {
  vipCache.delete(cookie);
}
