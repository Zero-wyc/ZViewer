/**
 * ani-subs Provider 工厂
 *
 * 提供 web-selector 和 rss 两种 factory 的 provider 创建函数。
 * 每个 provider 实现 AniSubsSourceProvider 接口。
 */

import type {
  AniSubsSourceProvider,
  AniSubsSearchConfig,
  AniSubsSearchResult,
  AniSubsEpisode,
  AniSubsPlaybackUrl,
} from './types';
import {
  fetchHtml,
  parseSearchResults,
  parseEpisodes,
  resolveVideoUrl,
  buildBrowserHeaders,
  isCloudflareBlocked,
} from './scraper';
import { fetchText } from './httpClient';

/** 创建 web-selector 类型的 provider */
export function createWebSelectorProvider(
  sourceId: string,
  displayName: string,
  config: AniSubsSearchConfig,
): AniSubsSourceProvider {
  return {
    name: displayName,

    async search(keyword: string): Promise<AniSubsSearchResult[]> {
      const searchUrl = config.searchUrl.replace(
        /\{keyword\}/g,
        encodeURIComponent(keyword),
      );
      const html = await fetchHtml(searchUrl, config.matchVideo?.cookies);
      const subjects = parseSearchResults(html, config, searchUrl);

      // 去重并限制数量
      const seen = new Set<string>();
      return subjects
        .filter((s) => {
          if (seen.has(s.url)) return false;
          seen.add(s.url);
          return true;
        })
        .slice(0, 20)
        .map((s) => ({
          id: s.url,
          title: s.title,
          source: sourceId,
        }));
    },

    async getEpisodes(identifier: string): Promise<AniSubsEpisode[]> {
      const subjectUrl = identifier;
      const html = await fetchHtml(subjectUrl, config.matchVideo?.cookies);
      const infos = parseEpisodes(html, config, subjectUrl);

      return infos.map((info) => ({
        id: info.id,
        title: info.title,
        episodeNumber: info.episodeNumber || 1,
        playbackParams: { episodeUrl: info.url },
      }));
    },

    async getPlaybackUrl(
      episode: AniSubsEpisode,
    ): Promise<AniSubsPlaybackUrl | null> {
      const episodeUrl = episode.playbackParams.episodeUrl;
      if (typeof episodeUrl !== 'string' || !episodeUrl) {
        throw new Error('缺少剧集页面地址');
      }
      if (!config.matchVideo) {
        throw new Error('数据源未配置视频匹配规则');
      }
      const result = await resolveVideoUrl(episodeUrl, config.matchVideo);
      if (!result) {
        return null;
      }
      return {
        url: result.url,
        headers: result.headers,
        format: result.format,
      };
    },
  };
}

// --- RSS Provider（内联实现，不依赖 anime/services/rss） ---

interface RssFeedItem {
  title: string;
  link: string;
  description?: string;
  enclosureUrl?: string;
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

function stripCdata(input: string): string {
  return input.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').trim();
}

function extractTextContent(tagName: string, xml: string): string {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = xml.match(regex);
  if (!match) return '';
  return decodeXmlEntities(stripCdata(match[1]).trim());
}

function extractAttribute(
  tagName: string,
  attr: string,
  xml: string,
): string {
  const regex = new RegExp(
    `<${tagName}[^>]*\\s${attr}="([^"]*)"[^>]*>`,
    'i',
  );
  const match = xml.match(regex);
  return match ? decodeXmlEntities(match[1]) : '';
}

function parseRssItems(xml: string): RssFeedItem[] {
  const items: RssFeedItem[] = [];
  const itemRegex = /<item[\s\S]*?<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[0];
    const title = extractTextContent('title', itemXml);
    const link = extractTextContent('link', itemXml);
    const description = extractTextContent('description', itemXml);
    const enclosureUrl = extractAttribute('enclosure', 'url', itemXml);
    if (title && (link || enclosureUrl)) {
      items.push({
        title: title.replace(/<[^>]+>/g, ''),
        link: link || enclosureUrl,
        description: description.replace(/<[^>]+>/g, ' ').trim(),
        enclosureUrl,
      });
    }
  }
  return items;
}

function parseAtomItems(xml: string): RssFeedItem[] {
  const items: RssFeedItem[] = [];
  const entryRegex = /<entry[\s\S]*?<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[0];
    const title = extractTextContent('title', entryXml);
    const link = extractAttribute('link', 'href', entryXml);
    const description =
      extractTextContent('summary', entryXml) ||
      extractTextContent('content', entryXml);
    if (title && link) {
      items.push({
        title: title.replace(/<[^>]+>/g, ''),
        link,
        description: description.replace(/<[^>]+>/g, ' ').trim(),
      });
    }
  }
  return items;
}

async function fetchFeedItems(url: string): Promise<RssFeedItem[]> {
  const result = await fetchText(url, { headers: buildBrowserHeaders(url) });
  if (isCloudflareBlocked(result)) {
    throw new Error(
      `该数据源被 Cloudflare 防护拦截 [${result.status}]，服务器无法直接访问`,
    );
  }
  if (!result.ok) {
    throw new Error(
      `RSS 订阅请求失败 [${result.status}]: ${url}${result.error ? ` (${result.error})` : ''}`,
    );
  }
  const xml = result.body;
  if (!xml || !xml.trim()) {
    throw new Error('RSS 订阅返回为空');
  }
  if (xml.includes('<feed')) {
    return parseAtomItems(xml);
  }
  return parseRssItems(xml);
}

/** 创建 RSS 类型的 provider */
export function createRssProvider(
  sourceId: string,
  displayName: string,
  feedUrl: string,
): AniSubsSourceProvider {
  return {
    name: displayName,

    async search(keyword: string): Promise<AniSubsSearchResult[]> {
      // 支持 {keyword} 占位符的 RSS 搜索 URL（如 nyaa.land）
      const url = feedUrl.includes('{keyword}')
        ? feedUrl.replace(/\{keyword\}/g, encodeURIComponent(keyword))
        : feedUrl;
      const items = await fetchFeedItems(url);
      const lower = keyword.toLowerCase();
      return items
        .filter(
          (item) =>
            item.title.toLowerCase().includes(lower) ||
            (item.description || '').toLowerCase().includes(lower),
        )
        .slice(0, 20)
        .map((item) => ({
          id: item.link,
          title: item.title,
          description: item.description,
          source: sourceId,
        }));
    },

    async getEpisodes(identifier: string): Promise<AniSubsEpisode[]> {
      const items = await fetchFeedItems(feedUrl);
      const target = items.find((item) => item.link === identifier);
      if (!target) {
        throw new Error('未找到对应 RSS 条目');
      }
      return [
        {
          id: target.link,
          title: target.title,
          episodeNumber: 1,
          playbackParams: {
            url: target.enclosureUrl || target.link,
          },
        },
      ];
    },

    async getPlaybackUrl(
      episode: AniSubsEpisode,
    ): Promise<AniSubsPlaybackUrl | null> {
      const url = episode.playbackParams.url;
      if (typeof url !== 'string' || !url) {
        throw new Error('缺少 RSS 条目播放地址');
      }
      return { url };
    },
  };
}
