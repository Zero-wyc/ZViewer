/**
 * Kazumi 独立模块 — 规则获取与 provider 构建
 *
 * 从 GitHub（经 CDN 代理）或自定义 URL 获取 Kazumi 规则 JSON，
 * 解析并构建 provider 实例。
 */

import type { KazumiRule, KazumiSourceProvider } from './types';
import { createKazumiProvider } from './provider';
import { proxyGitHubUrl } from '../../utils/githubCdn';
import { fetchText } from '../anisubs/httpClient';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const OFFICIAL_REPOSITORY_SOURCES: Record<string, string[]> = {
  'https://github.com/Predidit/Kazumi': [
    'https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/DM84.json',
    'https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/7sefun.json',
  ],
  'https://github.com/Predidit/KazumiRules': [
    'https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json',
  ],
};

interface KazumiRuleIndexEntry {
  name?: unknown;
}

function normalizeRepositoryUrl(url: string): string {
  return url.trim().replace(/\.git\/?$/, '').replace(/\/$/, '');
}

function expandOfficialRepositoryUrl(url: string): string[] | undefined {
  return OFFICIAL_REPOSITORY_SOURCES[normalizeRepositoryUrl(url)];
}

function buildIndexedRuleUrl(indexUrl: string, name: string): string {
  const encodedName = encodeURIComponent(name);
  if (/\/index\.json(?:[?#].*)?$/i.test(indexUrl)) {
    return indexUrl.replace(/index\.json(?=[?#]|$)/i, `${encodedName}.json`);
  }
  return new URL(`${encodedName}.json`, indexUrl).href;
}

async function fetchRuleDocument(url: string): Promise<unknown> {
  const proxiedUrl = proxyGitHubUrl(url);
  const result = await fetchText(proxiedUrl, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (!result.ok) {
    throw new Error(
      `获取规则失败 [${result.status}]: ${proxiedUrl}${result.error ? ` (${result.error})` : ''}`,
    );
  }
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    throw new Error('规则 JSON 解析失败');
  }
}

/** 获取 Kazumi 规则 JSON（经 PowerShell fallback 绕过 TLS 拦截） */
export async function fetchKazumiRule(url: string): Promise<KazumiRule> {
  const data = (await fetchRuleDocument(url)) as KazumiRule;
  if (!data.name || !data.baseURL || !data.searchURL) {
    throw new Error('规则格式不正确（缺少 name/baseURL/searchURL）');
  }
  return data;
}

async function expandRuleSource(url: string): Promise<string[]> {
  const repositorySources = expandOfficialRepositoryUrl(url);
  if (repositorySources) {
    const expanded = await Promise.all(repositorySources.map(expandRuleSource));
    return expanded.flat();
  }

  const data = await fetchRuleDocument(url);
  if (!Array.isArray(data)) return [url];

  const names = data
    .map((entry) => (entry as KazumiRuleIndexEntry)?.name)
    .filter(
      (name): name is string =>
        typeof name === 'string' && /^[\w.-]+$/i.test(name),
    );
  if (names.length === 0) {
    throw new Error('规则索引中没有可用的规则名称');
  }
  return names.map((name) => buildIndexedRuleUrl(url, name));
}

/** 从规则列表构建所有 provider，返回 id → provider 映射 */
export async function buildProvidersFromRules(
  ruleUrls: string[],
): Promise<Record<string, KazumiSourceProvider>> {
  const providers: Record<string, KazumiSourceProvider> = {};
  const expandedUrls: string[] = [];

  for (const sourceUrl of ruleUrls) {
    if (!sourceUrl || typeof sourceUrl !== 'string') continue;
    try {
      expandedUrls.push(...(await expandRuleSource(sourceUrl)));
    } catch (err) {
      console.error(`[kazumi] 展开规则源失败: ${sourceUrl}`, err);
    }
  }

  const uniqueUrls = [...new Set(expandedUrls)];
  for (let index = 0; index < uniqueUrls.length; index++) {
    const url = uniqueUrls[index];
    if (!url || typeof url !== 'string') continue;
    try {
      const rule = await fetchKazumiRule(url);
      // 使用 index 保证唯一性，名称仅用于显示
      const id = `kazumi_${index}`;
      providers[id] = createKazumiProvider(id, rule);
      console.log(`[kazumi] 加载规则成功: ${rule.name} → ${id}`);
    } catch (err) {
      console.error(`[kazumi] 加载规则失败: ${url}`, err);
    }
  }

  return providers;
}
