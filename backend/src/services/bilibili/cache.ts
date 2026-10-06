/**
 * B站 解析相关统一缓存模块。
 * 集中管理 VIP 状态、用户信息、视频信息等缓存，避免散落在各模块。
 *
 * 底层使用通用 TtlCache（TTL + LRU + 容量上限），替代原先的无界 Map：
 * - 每类缓存按各自的 TTL 自动过期；
 * - VIP 缓存键归一化为 DedeUserID（mid），Cookie 刷新/轮换后仍可命中，
 *   避免以整个 Cookie 字符串做键导致的缓存穿透。
 */

import { TtlCache } from '../../utils/ttl-cache';
import type { PgcSeasonInfo } from './pgc';

export interface BilibiliUserInfo {
  name: string;
  avatar: string;
  mid?: number;
  vipStatus?: number;
  vipType?: number;
}

export interface BilibiliVideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  duration: number;
  pages: { cid: number; page: number; part: string; duration: number }[];
}

const VIP_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const VIDEO_INFO_CACHE_TTL_MS = 2 * 60 * 1000;
/** PGC ep→season 缓存：整季分集列表短 TTL 足够（新番更新频率远低于此） */
const SEASON_BY_EP_CACHE_TTL_MS = 10 * 60 * 1000;

const vipCache = new TtlCache<boolean>({ ttlMs: VIP_CACHE_TTL_MS });
const userInfoCache = new TtlCache<BilibiliUserInfo>({
  ttlMs: USER_INFO_CACHE_TTL_MS,
});
const videoInfoCache = new TtlCache<BilibiliVideoInfo>({
  ttlMs: VIDEO_INFO_CACHE_TTL_MS,
});
const seasonByEpCache = new TtlCache<PgcSeasonInfo>({
  ttlMs: SEASON_BY_EP_CACHE_TTL_MS,
});

/**
 * VIP 缓存键归一化：优先使用 Cookie 中的 DedeUserID（同一账号多次登录稳定），
 * 提取失败时退化为完整 Cookie 字符串。
 */
function normalizeVipCacheKey(cookie: string): string {
  const match = cookie.match(/(?:^|;\s*)DedeUserID=(\d+)/);
  return match?.[1] ? `mid:${match[1]}` : cookie;
}

export function getCachedVipStatus(cookie: string): boolean | null {
  return vipCache.get(normalizeVipCacheKey(cookie));
}

export function setCachedVipStatus(cookie: string, isVip: boolean): void {
  vipCache.set(normalizeVipCacheKey(cookie), isVip);
}

export function getCachedUserInfo(userId: string): BilibiliUserInfo | null {
  return userInfoCache.get(userId);
}

export function setCachedUserInfo(userId: string, info: BilibiliUserInfo): void {
  userInfoCache.set(userId, info);
}

export function getCachedVideoInfo(bvid: string): BilibiliVideoInfo | null {
  return videoInfoCache.get(bvid);
}

export function setCachedVideoInfo(bvid: string, data: BilibiliVideoInfo): void {
  videoInfoCache.set(bvid, data);
}

export function invalidateUserInfo(userId: string): void {
  userInfoCache.delete(userId);
}

export function invalidateVipCache(cookie: string): void {
  vipCache.delete(normalizeVipCacheKey(cookie));
}

/** ep→season 缓存：ep 链接反查整季分集列表，避免每次切集/切清晰度都打 season 接口 */
export function getCachedSeasonByEpId(epId: number): PgcSeasonInfo | null {
  return seasonByEpCache.get(String(epId));
}

export function setCachedSeasonByEpId(epId: number, season: PgcSeasonInfo): void {
  seasonByEpCache.set(String(epId), season);
}
