/**
 * CMS 采集源模块 — 注册表与缓存
 *
 * 从 SystemSettings.dataSourceConfig.cmsSources 读取 TVBox 配置接口 URL
 * 列表（由管理员在后台配置，不内置任何默认源），逐个解析其中的
 * type 1 苹果 CMS 采集站点并构建 provider。按 config-hash 缓存，
 * 避免每次请求重复拉取配置。
 */

import type {
  CmsSourceProvider,
  CmsSite,
  CmsEpisode,
  CmsSearchResult,
} from './types';
import { createCmsProvider } from './cmsProvider';
import {
  loadTvboxCmsSites,
  clearConfigCache,
} from './tvboxConfigLoader';
import { AppDataSource } from '../../data-source';
import { SystemSettings } from '../../entities/SystemSettings';

export * from './types';

// --- SystemSettings 读取 ---

async function getSystemSettings(): Promise<SystemSettings> {
  const settingsRepo = AppDataSource.getRepository(SystemSettings);
  let settings = await settingsRepo.findOne({ where: {} });
  if (!settings) {
    settings = settingsRepo.create({
      autoDeleteInactiveRooms: true,
      autoDeleteAfterHours: 24,
      dataSourceConfig: null,
    });
    await settingsRepo.save(settings);
  }
  return settings;
}

interface DataSourceConfig {
  /** TVBox 配置接口 URL 列表（仅提取其中 type 1 CMS 采集站） */
  cmsSources?: string[];
}

function parseDataSourceConfig(raw: unknown): DataSourceConfig {
  if (!raw || typeof raw !== 'object') return {};
  return raw as DataSourceConfig;
}

function getConfigUrls(config: DataSourceConfig): string[] {
  const urls = config.cmsSources;
  if (!Array.isArray(urls)) return [];
  return urls
    .filter(
      (url): url is string => typeof url === 'string' && url.trim() !== '',
    )
    .map((url) => url.trim());
}

// --- 缓存 ---

let cachedProviders: Record<string, CmsSourceProvider> | null = null;
let cachedConfigHash: string | null = null;

function hashConfig(urls: string[]): string {
  try {
    return JSON.stringify(urls);
  } catch {
    return String(Date.now());
  }
}

/** 为站点生成注册表键（配置序号 + 站点 key，跨配置唯一） */
function makeRegistryKey(cfgIndex: number, site: CmsSite): string {
  return `cms${cfgIndex}_${site.key}`;
}

async function buildProviders(
  urls: string[],
): Promise<Record<string, CmsSourceProvider>> {
  const providers: Record<string, CmsSourceProvider> = {};

  await Promise.all(
    urls.map(async (configUrl, cfgIndex) => {
      try {
        const sites = await loadTvboxCmsSites(configUrl);
        for (const site of sites) {
          const key = makeRegistryKey(cfgIndex, site);
          // 重复 key（同配置内或哈希碰撞）时追加序号保证唯一
          const finalKey = providers[key]
            ? `${key}_${Object.keys(providers).length}`
            : key;
          providers[finalKey] = createCmsProvider({ ...site, key: finalKey });
        }
        console.log(
          `[cms] 配置加载成功: ${configUrl} → ${sites.length} 个 CMS 站点`,
        );
      } catch (err) {
        console.error(`[cms] 配置加载失败: ${configUrl}`, err);
      }
    }),
  );

  return providers;
}

// --- 公共 API ---

/** 获取 provider 注册表（带缓存；空配置返回空表，不内置任何默认源） */
export async function getProviders(): Promise<
  Record<string, CmsSourceProvider>
> {
  const settings = await getSystemSettings();
  const urls = getConfigUrls(parseDataSourceConfig(settings.dataSourceConfig));
  const configHash = hashConfig(urls);

  // 仅当缓存非空且 hash 匹配时使用缓存；
  // 空表不使用缓存，允许下次请求重试
  if (
    cachedProviders &&
    Object.keys(cachedProviders).length > 0 &&
    cachedConfigHash === configHash
  ) {
    return cachedProviders;
  }

  cachedProviders = await buildProviders(urls);
  cachedConfigHash = configHash;
  return cachedProviders;
}

/** 获取单个 provider */
export async function getProvider(
  source: string,
): Promise<CmsSourceProvider | undefined> {
  const providers = await getProviders();
  return providers[source];
}

/** 列出所有可用数据源 */
export async function listSources(): Promise<
  Array<{ id: string; name: string }>
> {
  const providers = await getProviders();
  return Object.entries(providers).map(([id, provider]) => ({
    id,
    name: provider.site.name,
  }));
}

/** 清除缓存（admin 保存 cmsSources 配置时调用） */
export function clearCache(): void {
  cachedProviders = null;
  cachedConfigHash = null;
  clearConfigCache();
}

/** 规范化 resolve 参数 DTO（路由层调用） */
export function normalizePlaybackParams(raw: unknown): CmsEpisode['playbackParams'] {
  const body = raw as Record<string, unknown>;
  return {
    vodId: String(body?.vodId ?? ''),
    playFromIndex: Number(body?.playFromIndex) || 0,
    episodeIndex: Number(body?.episodeIndex) || 0,
  };
}

// --- 聚合搜索 ---

/** 聚合搜索结果项（跨站点合并去重后） */
export interface CmsAggregateSearchResult {
  /** 复合 id：`${source}::${vodId}`（detail/resolve 仍按 source+vodId 定位） */
  id: string;
  /** 站点 provider key（真实站点，非复合 id） */
  source: string;
  /** 站点显示名 */
  siteName: string;
  /** 原始 vodId */
  vodId: string;
  title: string;
  cover?: string;
  description?: string;
  remark?: string;
}

/** 标题归一化：小写 + 去空白/标点（聚合去重键） */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 聚合搜索全部站点：并发查询（allSettled 容错，单站失败不影响整体），
 * 按归一化标题去重（同名影片保留备注更完整/首个结果）。
 */
export async function searchAllProviders(
  keyword: string,
  options: { perSourceLimit?: number } = {},
): Promise<CmsAggregateSearchResult[]> {
  const providers = Object.entries(await getProviders());
  if (providers.length === 0) return [];

  const perSourceLimit = options.perSourceLimit ?? 15;
  const settled = await Promise.allSettled(
    providers.map(async ([key, provider]) => {
      const results = await provider.search(keyword);
      return results
        .slice(0, perSourceLimit)
        .map((r) => ({ ...r, siteName: provider.site.name }));
    }),
  );

  const merged: CmsAggregateSearchResult[] = [];
  const seen = new Map<string, CmsAggregateSearchResult>();
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    for (const item of outcome.value) {
      if (!item.id || !item.title) continue;
      const key = normalizeTitle(item.title);
      const existing = seen.get(key);
      if (existing) {
        // 去重：保留有备注（更新至第x集等）的一方，否则保留先到者
        if (!existing.remark && item.remark) {
          existing.remark = item.remark;
          existing.cover = existing.cover ?? item.cover;
        }
        continue;
      }
      const entry: CmsAggregateSearchResult = {
        id: `${item.source}::${item.id}`,
        source: item.source,
        siteName: item.siteName,
        vodId: item.id,
        title: item.title,
        cover: item.cover,
        description: item.description,
        remark: item.remark,
      };
      seen.set(key, entry);
      merged.push(entry);
    }
  }
  return merged;
}
