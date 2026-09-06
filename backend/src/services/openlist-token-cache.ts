/**
 * OpenList 用户 token 缓存
 *
 * 参考自 synctv 的 AlistUserCache（refreshcache0）。
 * synctv 为每个用户维护独立的 token 缓存，token 在有效期内复用，
 * 避免每次 /stream 请求都重新调用 /api/auth/login。
 *
 * 本实现采用 TtlCache（TTL + LRU 上限）策略：
 * - key: `${apiBaseUrl}|${username}`（匿名访问用 apiBaseUrl）
 * - TTL 12 小时（AList 默认 48h，取较短值确保过期前主动刷新）
 * - 401 时调用 invalidate() 失效缓存，下次请求重新登录
 *
 * 不持久化：进程重启后缓存丢失，首次请求会重新登录，无功能影响。
 */
import { alistLogin, toApiBaseUrl, type AlistLoginMode } from './openlist-client';
import { OpenListError } from './openlist-errors';
import { normalizeOpenListServerUrl } from './openlist-errors';
import { TtlCache } from '../utils/ttl-cache';

/** Token 缓存条目 */
interface TokenCacheEntry {
  token: string;
}

/** Token TTL（12 小时） */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 进程内 token 缓存。
 * 使用 TtlCache（LRU 上限）替代无界 Map：每个 serverUrl|username 组合一条，
 * 长期运行下挂载增删后过期条目不会被清理，LRU 上限兜底。
 */
const tokenCache = new TtlCache<TokenCacheEntry>({
  ttlMs: TOKEN_TTL_MS,
  maxSize: 200,
});

/** 生成缓存 key */
function cacheKey(apiBaseUrl: string, username: string): string {
  return `${apiBaseUrl}|${username || ''}`;
}

/**
 * 获取 AList token（带缓存）。
 *
 * 优先从缓存读取有效 token；缓存未命中或已过期时调用 login 获取新 token。
 * 匿名场景（username 为空）不登录，返回 undefined，调用方直接走匿名访问。
 *
 * @param serverUrl   AList 服务器地址（可含 /dav 后缀）
 * @param username    用户名（空表示匿名）
 * @param password    密码（明文或哈希值，根据 mode）
 * @param mode        登录方式：plain=明文，hash=哈希
 * @returns token（匿名场景返回 undefined）
 */
export async function getOpenListToken(
  serverUrl: string,
  username: string | undefined,
  password: string | undefined,
  mode: AlistLoginMode = 'plain',
): Promise<string | undefined> {
  const normalized = normalizeOpenListServerUrl(serverUrl);
  const apiBaseUrl = toApiBaseUrl(normalized);
  const user = username || '';

  // 匿名访问：不登录
  if (!user) return undefined;

  // 检查缓存
  const key = cacheKey(apiBaseUrl, user);
  const cached = tokenCache.get(key);
  if (cached) {
    return cached.token;
  }

  // 缓存未命中，登录获取新 token
  if (!password) {
    throw new OpenListError('OpenList 用户名已配置但密码为空', 'AUTH_FAILED');
  }

  const token = await alistLogin(apiBaseUrl, user, password, mode);
  tokenCache.set(key, { token });
  return token;
}

/**
 * 失效指定挂载的 token 缓存（401 时调用）。
 *
 * @param serverUrl  AList 服务器地址
 * @param username   用户名（空表示匿名，匿名无需失效）
 */
export function invalidateOpenListToken(
  serverUrl: string,
  username: string | undefined,
): void {
  const normalized = normalizeOpenListServerUrl(serverUrl);
  const apiBaseUrl = toApiBaseUrl(normalized);
  const user = username || '';
  if (!user) return;
  tokenCache.delete(cacheKey(apiBaseUrl, user));
}

/**
 * 失效所有 token 缓存（如修改密码、批量操作时调用）。
 */
export function invalidateAllOpenListTokens(): void {
  tokenCache.clear();
}
