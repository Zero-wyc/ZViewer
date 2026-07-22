/**
 * ani-subs 订阅获取与解析
 *
 * 从 GitHub（经 CDN 代理）或自定义 URL 获取 ani-subs JSON 订阅文件，
 * 解析出媒体源列表并构建 provider 实例。
 */

import type {
  AniSubsSubscription,
  AniSubsMediaSource,
  AniSubsSearchConfig,
  AniSubsSourceProvider,
} from './types';
import { createWebSelectorProvider, createRssProvider } from './provider';
import { proxyGitHubUrl } from '../../utils/githubCdn';
// 本地 fallback 订阅（当 sub.creamycake.org 被 Cloudflare TLS 拦截时使用）
import defaultCss1 from './default-css1.json';
import defaultBt1 from './default-bt1.json';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 默认订阅 URL → 本地 fallback JSON 映射。
 * sub.creamycake.org 使用 Cloudflare 防护，Node.js 的 TLS 指纹会被拦截（ECONNRESET），
 * PowerShell/.NET 能正常访问。将订阅内容内嵌为本地副本，远程获取失败时回退使用。
 */
const LOCAL_FALLBACK_MAP: Record<string, AniSubsSubscription> = {
  'https://sub.creamycake.org/v1/css1.json':
    defaultCss1 as unknown as AniSubsSubscription,
  'https://sub.creamycake.org/v1/bt1.json':
    defaultBt1 as unknown as AniSubsSubscription,
};

/** 根据 URL 查找本地 fallback 订阅 */
function getLocalFallback(url: string): AniSubsSubscription | null {
  const cleanUrl = url.split('?')[0].split('#')[0];
  return LOCAL_FALLBACK_MAP[cleanUrl] || null;
}

/** 获取 ani-subs 订阅 JSON */
export async function fetchSubscription(
  url: string,
): Promise<AniSubsSubscription> {
  const proxiedUrl = proxyGitHubUrl(url);
  try {
    const res = await fetch(proxiedUrl, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(
        `获取 ani-subs 订阅失败 [${res.status}]: ${proxiedUrl}`,
      );
    }
    return res.json() as Promise<AniSubsSubscription>;
  } catch (err) {
    // 远程获取失败（Cloudflare TLS 拦截 / 超时 / 网络错误），尝试本地 fallback
    const fallback = getLocalFallback(url);
    if (fallback) {
      console.warn(
        `[anisubs] 远程获取订阅失败，使用本地 fallback: ${url}`,
        err instanceof Error ? err.message : err,
      );
      return fallback;
    }
    throw err;
  }
}

/** 从单个媒体源构建 provider */
function buildProviderFromMediaSource(
  source: AniSubsMediaSource,
  index: number,
): { id: string; provider: AniSubsSourceProvider } | null {
  const name = source.arguments.name;
  // 使用 index 保证唯一性，名称仅用于显示
  const id = `ani_subs_${source.factoryId}_${index}`;

  if (source.factoryId === 'rss' && source.arguments.searchConfig) {
    const searchUrl = source.arguments.searchConfig.searchUrl;
    if (searchUrl) {
      return { id, provider: createRssProvider(id, name, searchUrl) };
    }
  }

  if (
    source.factoryId === 'web-selector' &&
    source.arguments.searchConfig
  ) {
    return {
      id,
      provider: createWebSelectorProvider(
        id,
        name,
        source.arguments.searchConfig,
      ),
    };
  }

  return null;
}

/** 从订阅构建所有 provider，返回 id → provider 映射 */
export function buildProvidersFromSubscription(
  subscription: AniSubsSubscription,
): Record<string, AniSubsSourceProvider> {
  const providers: Record<string, AniSubsSourceProvider> = {};
  const sources = subscription.exportedMediaSourceDataList?.mediaSources || [];

  sources.forEach((source, index) => {
    const result = buildProviderFromMediaSource(source, index);
    if (result) {
      providers[result.id] = result.provider;
    }
  });

  return providers;
}
