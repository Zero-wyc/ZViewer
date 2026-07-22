/**
 * Kazumi 独立模块 — 注册表与缓存
 *
 * 从 SystemSettings.dataSourceConfig.kazumiRules 读取规则 URL 列表，
 * 获取并解析规则 JSON，构建 provider 实例。
 * 按 config-hash 缓存，避免每次请求重复获取规则。
 */

import type { KazumiSourceProvider, KazumiEpisode } from './types';
import { buildProvidersFromRules } from './ruleLoader';
import { AppDataSource } from '../../data-source';
import { SystemSettings } from '../../entities/SystemSettings';

export * from './types';

const DEFAULT_KAZUMI_RULES = [
  'https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/DM84.json',
  'https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/7sefun.json',
  'https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/enlie.json',
];

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
  kazumiRules?: string[];
}

function parseDataSourceConfig(raw: unknown): DataSourceConfig {
  if (!raw || typeof raw !== 'object') return {};
  return raw as DataSourceConfig;
}

// --- 缓存 ---

let cachedProviders: Record<string, KazumiSourceProvider> | null = null;
let cachedConfigHash: string | null = null;

function hashConfig(config: DataSourceConfig): string {
  try {
    return JSON.stringify(config);
  } catch {
    return String(Date.now());
  }
}

// --- 公共 API ---

/** 构建所有 Kazumi provider */
export async function buildProviders(
  config: DataSourceConfig,
): Promise<Record<string, KazumiSourceProvider>> {
  // 数据库中可能存了空的 kazumiRules: []，需判断非空才使用
  const urls =
    Array.isArray(config.kazumiRules) && config.kazumiRules.length > 0
      ? config.kazumiRules
      : DEFAULT_KAZUMI_RULES;

  console.log(`[kazumi] buildProviders: urls =`, urls);

  const providers = await buildProvidersFromRules(urls);

  console.log(
    `[kazumi] buildProviders: 共 ${Object.keys(providers).length} 个 provider`,
  );

  return providers;
}

/** 获取 provider 注册表（带缓存） */
export async function getProviders(): Promise<
  Record<string, KazumiSourceProvider>
> {
  const settings = await getSystemSettings();
  const config = parseDataSourceConfig(settings.dataSourceConfig);
  const configHash = hashConfig(config);

  // 仅当缓存非空且 hash 匹配时使用缓存；
  // 空对象（{}）不使用缓存，允许下次请求重试
  if (
    cachedProviders &&
    Object.keys(cachedProviders).length > 0 &&
    cachedConfigHash === configHash
  ) {
    return cachedProviders;
  }

  cachedProviders = await buildProviders(config);
  cachedConfigHash = configHash;
  return cachedProviders;
}

/** 获取单个 provider */
export async function getProvider(
  source: string,
): Promise<KazumiSourceProvider | undefined> {
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
    name: provider.name,
  }));
}

/** 清除缓存 */
export function clearCache(): void {
  cachedProviders = null;
  cachedConfigHash = null;
}

/** 规范化 episode DTO（路由层调用） */
export function normalizeEpisode(raw: unknown): KazumiEpisode {
  const episode = raw as Record<string, unknown>;
  return {
    id: String(episode?.id ?? ''),
    title: String(episode?.title ?? ''),
    episodeNumber: Number(episode?.episodeNumber) || 1,
    playbackParams:
      episode?.playbackParams && typeof episode.playbackParams === 'object'
        ? (episode.playbackParams as Record<string, unknown>)
        : {},
  };
}
