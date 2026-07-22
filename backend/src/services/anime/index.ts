import { AnimeSourceProvider } from './types';
import { bilibiliBangumiAnimeProvider } from './providers/bilibiliBangumi';
import { createRssAnimeProvider } from './providers/rss';
import { createThirdPartyAnimeProvider } from './providers/thirdParty';
import { AppDataSource } from '../../data-source';
import { SystemSettings } from '../../entities/SystemSettings';

export * from './types';

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

interface RssSourceEntry {
  id: string;
  name?: string;
  url: string;
}

interface ThirdPartySourceEntry {
  id: string;
  name?: string;
  baseUrl?: string;
  endpoints?: {
    searchUrl?: string;
    episodesUrl?: string;
    resolveUrl?: string;
    headers?: Record<string, string>;
    authToken?: string;
  };
}

export interface DataSourceConfig {
  rssSources?: RssSourceEntry[];
  thirdPartySources?: ThirdPartySourceEntry[];
  aniSubsSubscriptions?: string[];
}

let cachedProviders: Record<string, AnimeSourceProvider> | null = null;
let cachedConfigHash: string | null = null;

function hashConfig(config: DataSourceConfig): string {
  try {
    return JSON.stringify(config);
  } catch {
    return String(Date.now());
  }
}

function parseDataSourceConfig(raw: unknown): DataSourceConfig {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return raw as DataSourceConfig;
}

export async function buildAnimeProviders(
  config: DataSourceConfig,
): Promise<Record<string, AnimeSourceProvider>> {
  const providers: Record<string, AnimeSourceProvider> = {
    bilibili_bangumi: bilibiliBangumiAnimeProvider,
  };

  if (Array.isArray(config.rssSources)) {
    for (const source of config.rssSources) {
      if (source && source.id && source.url) {
        providers[`rss_${source.id}`] = createRssAnimeProvider(
          `rss_${source.id}`,
          source.name || `RSS: ${source.id}`,
          { url: source.url },
        );
      }
    }
  }

  if (Array.isArray(config.thirdPartySources)) {
    for (const source of config.thirdPartySources) {
      if (source && source.id) {
        providers[`third_party_${source.id}`] = createThirdPartyAnimeProvider(
          `third_party_${source.id}`,
          source.name || `第三方: ${source.id}`,
          {
            baseUrl: source.baseUrl,
            endpoints: source.endpoints,
          },
        );
      }
    }
  }

  return providers;
}

export async function getAnimeProviders(): Promise<Record<string, AnimeSourceProvider>> {
  const settings = await getSystemSettings();
  const config = parseDataSourceConfig(settings.dataSourceConfig);
  const configHash = hashConfig(config);

  if (cachedProviders && cachedConfigHash === configHash) {
    return cachedProviders;
  }

  cachedProviders = await buildAnimeProviders(config);
  cachedConfigHash = configHash;
  return cachedProviders;
}

export async function getAnimeProvider(source: string): Promise<AnimeSourceProvider | undefined> {
  const providers = await getAnimeProviders();
  return providers[source];
}

export async function listAnimeSources(): Promise<Array<{ id: string; name: string }>> {
  const providers = await getAnimeProviders();
  return Object.entries(providers).map(([id, provider]) => ({
    id,
    name: provider.name,
  }));
}

export function clearAnimeProvidersCache(): void {
  cachedProviders = null;
  cachedConfigHash = null;
}
