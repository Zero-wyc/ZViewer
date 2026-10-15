/**
 * CMS 采集源模块 — 注册表与缓存
 *
 * 从 SystemSettings.dataSourceConfig.cmsSources 读取 TVBox 配置接口 URL
 * 列表（由管理员在后台配置，不内置任何默认源），逐个解析其中的
 * type 1 苹果 CMS 采集站点并构建 provider。按 config-hash 缓存，
 * 避免每次请求重复拉取配置。
 */

import type { CmsSourceProvider, CmsSite, CmsEpisode } from './types';
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
