/**
 * CMS 采集源模块 — TVBox 配置加载器
 *
 * 拉取 TVBox/OK影视 接口 JSON（如 https://xxx/jsm.json），解析 sites
 * 中 type === 1 的苹果 CMS 采集站点。处理两类特殊形态：
 *   - 跳转配置：顶层只有 urls: [{url, name}]，需递归拉取真实配置（限深 2 层）
 *   - 经 CDN 代理拉取 GitHub 原始地址（proxyGitHubUrl）
 *
 * 按配置 URL 做 10 分钟 TTL 缓存 + 单飞去重（TVBox 配置每日漂移，
 * 不需要更频繁；配置变更通过 admin 保存时 clearCache 触发重载）。
 */

import type { CmsSite, TvboxSiteEntry } from './types';
import { fetchText } from '../anisubs/httpClient';
import { proxyGitHubUrl } from '../../utils/githubCdn';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CONFIG_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_REDIRECT_DEPTH = 2;

/** 判断 api 是否为苹果 CMS JSON 采集接口形态 */
export function isCmsApi(api: string): boolean {
  if (!/^https?:\/\//i.test(api)) return false;
  // 常见形态：.../api.php/provide/vod、.../provide/vod/at/json、.../api.php/provide/vod/from/dbm3u8/
  return /provide[./]vod|api\.php/i.test(api);
}

/** 从 TVBox sites 条目提取 CMS 站点；非 type 1 / 非 CMS api 返回 null */
export function extractCmsSite(entry: TvboxSiteEntry): CmsSite | null {
  if (entry.type !== 1) return null;
  const api = typeof entry.api === 'string' ? entry.api.trim() : '';
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const key = typeof entry.key === 'string' ? entry.key.trim() : '';
  if (!api || !isCmsApi(api) || !name || !key) return null;
  return {
    key,
    name,
    api,
    searchable: entry.searchable !== 0,
  };
}

/** TVBox 跳转配置形态 */
interface TvboxRedirectEntry {
  url?: unknown;
  name?: unknown;
}

interface TvboxConfig {
  sites?: unknown;
  urls?: unknown;
}

/** 拉取并解析单个 TVBox 配置 URL，返回其中的 CMS 站点列表 */
async function loadConfigSites(
  configUrl: string,
  depth: number,
): Promise<CmsSite[]> {
  if (depth > MAX_REDIRECT_DEPTH) return [];

  const result = await fetchText(proxyGitHubUrl(configUrl), {
    headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
    timeoutMs: CONFIG_TIMEOUT_MS,
  });
  if (!result.ok) {
    throw new Error(
      `拉取配置失败 [${result.status}]: ${configUrl}${result.error ? ` (${result.error})` : ''}`,
    );
  }

  let config: TvboxConfig;
  try {
    config = JSON.parse(result.body) as TvboxConfig;
  } catch {
    throw new Error(`配置 JSON 解析失败: ${configUrl}`);
  }

  // 跳转配置：顶层 urls 指向真实配置，递归拉取
  if (Array.isArray(config.urls) && !Array.isArray(config.sites)) {
    const nested = config.urls
      .map((entry) =>
        entry && typeof entry === 'object'
          ? (entry as TvboxRedirectEntry).url
          : undefined,
      )
      .filter(
        (url): url is string => typeof url === 'string' && url.trim() !== '',
      );
    if (nested.length === 0) {
      throw new Error(`配置为空跳转（urls 无有效地址）: ${configUrl}`);
    }
    // 相对地址按当前配置 URL 解析
    const resolved = nested.map((url) => {
      try {
        return new URL(url, configUrl).href;
      } catch {
        return url;
      }
    });
    const results = await Promise.allSettled(
      resolved.map((url) => loadConfigSites(url, depth + 1)),
    );
    const sites = results.flatMap((r) =>
      r.status === 'fulfilled' ? r.value : [],
    );
    if (sites.length === 0) {
      const firstError = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      throw new Error(
        firstError
          ? `跳转配置全部失效: ${String(firstError.reason)}`
          : `跳转配置中没有 CMS 采集源: ${configUrl}`,
      );
    }
    return sites;
  }

  if (!Array.isArray(config.sites)) {
    throw new Error(`配置中没有 sites 字段: ${configUrl}`);
  }

  const sites: CmsSite[] = [];
  for (const entry of config.sites as TvboxSiteEntry[]) {
    if (!entry || typeof entry !== 'object') continue;
    const site = extractCmsSite(entry);
    if (site) sites.push(site);
  }
  return sites;
}

// --- 缓存（TTL + 单飞） ---

interface CacheEntry {
  sites: CmsSite[];
  fetchedAt: number;
}

const configCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CmsSite[]>>();

/**
 * 获取配置中的 CMS 站点（带 TTL 缓存与单飞去重）。
 * 失败时若有过期缓存则回退使用旧数据（TVBox 配置源可用性波动大）。
 */
export async function loadTvboxCmsSites(
  configUrl: string,
  options: { forceRefresh?: boolean } = {},
): Promise<CmsSite[]> {
  const url = configUrl.trim();
  if (!url) throw new Error('配置地址为空');

  const cached = configCache.get(url);
  if (
    !options.forceRefresh &&
    cached &&
    Date.now() - cached.fetchedAt < CACHE_TTL_MS
  ) {
    return cached.sites;
  }

  const existing = inflight.get(url);
  if (existing) return existing;

  const promise = loadConfigSites(url, 0)
    .then((sites) => {
      configCache.set(url, { sites, fetchedAt: Date.now() });
      return sites;
    })
    .catch((err) => {
      // 失败回退：有过期缓存时先用旧数据，避免整站不可用
      if (cached && cached.sites.length > 0) {
        console.warn(`[cms] 配置拉取失败，使用过期缓存: ${url}`, err);
        return cached.sites;
      }
      throw err;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, promise);
  return promise;
}

/** 清空配置缓存（admin 保存 cmsSources 时调用） */
export function clearConfigCache(): void {
  configCache.clear();
  inflight.clear();
}
