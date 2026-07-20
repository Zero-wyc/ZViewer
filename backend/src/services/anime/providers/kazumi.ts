import {
  AnimeSourceProvider,
  AnimeSearchResult,
  AnimeEpisode,
  AnimePlaybackUrl,
  AnimeMediaFormat,
} from '../types';
import { DOMParser } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { proxyGitHubUrl } from '../../../utils/githubCdn';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface KazumiRule {
  api?: string;
  type?: string;
  name: string;
  version?: string;
  muliSources?: boolean;
  useWebview?: boolean;
  useNativePlayer?: boolean;
  usePost?: boolean;
  useLegacyParser?: boolean;
  adBlocker?: boolean;
  userAgent?: string;
  referer?: string;
  baseURL: string;
  searchURL: string;
  searchList: string;
  searchName: string;
  searchResult: string;
  chapterRoads: string;
  chapterResult: string;
}

interface EpisodeInfo {
  id: string;
  title: string;
  episodeNumber: number;
  url: string;
}

function toAbsoluteUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function resolveBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

function fetchHtml(
  url: string,
  options: { userAgent?: string; referer?: string } = {},
): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  };
  if (options.referer) {
    headers.Referer = options.referer;
  }
  return fetch(url, { headers }).then(async (res) => {
    if (!res.ok) {
      throw new Error(`请求失败 [${res.status}]: ${url}`);
    }
    return res.text();
  });
}

function parseHtmlDocument(html: string): unknown {
  // xmldom 对 HTML 容错性一般，先用简单处理闭合标签
  const tidy = html
    .replace(/<br\s*\/?>/gi, '<br />')
    .replace(/<hr\s*\/?>/gi, '<hr />')
    .replace(/<meta([^>]*)>/gi, '<meta$1 />')
    .replace(/<img([^>]*)>/gi, '<img$1 />')
    .replace(/<input([^>]*)>/gi, '<input$1 />')
    .replace(/<area([^>]*)>/gi, '<area$1 />')
    .replace(/<base([^>]*)>/gi, '<base$1 />')
    .replace(/<col([^>]*)>/gi, '<col$1 />')
    .replace(/<embed([^>]*)>/gi, '<embed$1 />')
    .replace(/<link([^>]*)>/gi, '<link$1 />')
    .replace(/<param([^>]*)>/gi, '<param$1 />')
    .replace(/<source([^>]*)>/gi, '<source$1 />')
    .replace(/<track([^>]*)>/gi, '<track$1 />')
    .replace(/<wbr([^>]*)>/gi, '<wbr$1 />')
    .replace(/&nbsp;/g, '&#160;');
  return new DOMParser().parseFromString(tidy, 'text/html');
}

function selectXPath(
  doc: unknown,
  expression: string,
): xpath.SelectedValue[] {
  if (!expression) return [];
  try {
    return xpath.select(expression, doc as Node) as xpath.SelectedValue[];
  } catch (err) {
    console.error('[kazumi] xpath select error:', expression, err);
    return [];
  }
}

function extractText(node: xpath.SelectedValue): string {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (node && typeof (node as Node).textContent === 'string') {
    return ((node as Node).textContent || '').trim();
  }
  return '';
}

function extractAttr(
  node: xpath.SelectedValue,
  attr: string,
): string | undefined {
  if (!node) return undefined;
  if (typeof node === 'object' && 'getAttribute' in (node as Node)) {
    return ((node as Element).getAttribute(attr) || undefined) as
      | string
      | undefined;
  }
  return undefined;
}

function extractEpisodeNumber(name: string): number {
  const m = name.match(/第\s*(\d+(?:\.\d+)?)\s*[话集]|(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const n = Number(m[1] || m[2]);
  return Number.isNaN(n) ? 0 : n;
}

function detectMediaFormat(url: string): AnimeMediaFormat {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.flv')) return 'flv';
  if (lower.endsWith('.mp4')) return 'mp4';
  if (lower.includes('.m3u8')) return 'hls';
  if (lower.includes('.flv')) return 'flv';
  if (lower.includes('.mp4')) return 'mp4';
  return 'unknown';
}

async function resolveVideoUrl(
  episodeUrl: string,
  rule: KazumiRule,
): Promise<{ url: string; headers?: Record<string, string>; format?: AnimeMediaFormat } | null> {
  const html = await fetchHtml(episodeUrl, {
    userAgent: rule.userAgent,
    referer: rule.referer || rule.baseURL,
  });

  const absolute = (url: string) => toAbsoluteUrl(url, resolveBaseUrl(episodeUrl));

  // 1. 优先匹配常见视频地址
  const videoPatterns = [
    /(https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*)/gi,
    /(https?:\/\/[^"'\s]+?\.mp4[^"'\s]*)/gi,
    /(https?:\/\/[^"'\s]+?\.flv[^"'\s]*)/gi,
    /["'](https?:\/\/[^"'\s]+?\/[^"'\s]*?(?:\.m3u8|\.mp4|\.flv)[^"'\s]*)["']/gi,
  ];
  for (const pattern of videoPatterns) {
    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      const url = absolute(match[1] || match[0]);
      if (url && (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.flv'))) {
        return { url, format: detectMediaFormat(url) };
      }
    }
  }

  // 2. 匹配 DPlayer / 常见播放器配置中的 url 字段
  const configPatterns = [
    /["']url["']\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi,
    /video\s*:\s*\{[^}]*url\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
    /player\([^{]*\{[^}]*url\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
  ];
  for (const pattern of configPatterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      const url = absolute(match[1]);
      return { url, format: detectMediaFormat(url) };
    }
  }

  // 3. 匹配 iframe src，部分站点通过 iframe 嵌套播放器
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch?.[1]) {
    const iframeUrl = absolute(iframeMatch[1]);
    try {
      const iframeHtml = await fetchHtml(iframeUrl, {
        userAgent: rule.userAgent,
        referer: episodeUrl,
      });
      for (const pattern of videoPatterns) {
        const matches = [...iframeHtml.matchAll(pattern)];
        for (const match of matches) {
          const url = absolute(match[1] || match[0]);
          if (url && (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.flv'))) {
            return { url, format: detectMediaFormat(url) };
          }
        }
      }
    } catch {
      // ignore iframe fetch errors
    }
  }

  return null;
}

export function createKazumiProvider(
  sourceId: string,
  rule: KazumiRule,
): AnimeSourceProvider {
  return {
    name: rule.name,

    async search(keyword: string): Promise<AnimeSearchResult[]> {
      const searchUrl = rule.searchURL.replace(/@keyword/g, encodeURIComponent(keyword));
      const html = await fetchHtml(searchUrl, {
        userAgent: rule.userAgent,
        referer: rule.referer || rule.baseURL,
      });
      const doc = parseHtmlDocument(html);
      const baseUrl = resolveBaseUrl(searchUrl);

      const listNodes = selectXPath(doc, rule.searchList);
      const results: AnimeSearchResult[] = [];

      for (const node of listNodes) {
        const nameNodes = selectXPath(node as Node, rule.searchName);
        const resultNodes = selectXPath(node as Node, rule.searchResult);
        const title = extractText(nameNodes[0]);
        const linkNode = resultNodes[0];
        const url = linkNode
          ? toAbsoluteUrl(extractAttr(linkNode, 'href') || extractText(linkNode), baseUrl)
          : '';
        if (title && url) {
          results.push({
            id: url,
            title,
            source: sourceId,
            extra: { subjectUrl: url },
          });
        }
      }

      const seen = new Set<string>();
      return results
        .filter((r) => {
          if (seen.has(r.id)) return false;
          seen.add(r.id);
          return true;
        })
        .slice(0, 20);
    },

    async getEpisodes(identifier: string): Promise<AnimeEpisode[]> {
      const subjectUrl = identifier;
      const html = await fetchHtml(subjectUrl, {
        userAgent: rule.userAgent,
        referer: rule.referer || rule.baseURL,
      });
      const doc = parseHtmlDocument(html);
      const baseUrl = resolveBaseUrl(subjectUrl);

      const roadNodes = selectXPath(doc, rule.chapterRoads);
      const episodes: EpisodeInfo[] = [];

      for (const road of roadNodes) {
        const resultNodes = selectXPath(road as Node, rule.chapterResult);
        for (const node of resultNodes) {
          const title = extractText(node);
          const url = toAbsoluteUrl(
            extractAttr(node, 'href') || extractText(node),
            baseUrl,
          );
          if (!title || !url) continue;
          const episodeNumber = extractEpisodeNumber(title);
          episodes.push({
            id: `${title}-${episodeNumber}-${url}`,
            title,
            episodeNumber,
            url,
          });
        }
      }

      return episodes.map((info) => ({
        id: info.id,
        title: info.title,
        episodeNumber: info.episodeNumber || 1,
        playbackParams: { episodeUrl: info.url },
      }));
    },

    async getPlaybackUrl(episode: AnimeEpisode): Promise<AnimePlaybackUrl | null> {
      const episodeUrl = episode.playbackParams.episodeUrl;
      if (typeof episodeUrl !== 'string' || !episodeUrl) {
        throw new Error('缺少剧集页面地址');
      }
      const result = await resolveVideoUrl(episodeUrl, rule);
      if (!result) {
        return null;
      }
      const headers: Record<string, string> = {};
      if (rule.referer) {
        headers.Referer = rule.referer;
      } else {
        headers.Referer = rule.baseURL;
      }
      if (rule.userAgent) {
        headers['User-Agent'] = rule.userAgent;
      }
      return {
        url: result.url,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        format: result.format,
      };
    },
  };
}

export async function fetchKazumiRule(url: string): Promise<KazumiRule> {
  const proxiedUrl = proxyGitHubUrl(url);
  const res = await fetch(proxiedUrl, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`获取规则失败 [${res.status}]: ${proxiedUrl}`);
  }
  const data = (await res.json()) as KazumiRule;
  if (!data.name || !data.baseURL || !data.searchURL) {
    throw new Error('规则格式不正确');
  }
  return data;
}
