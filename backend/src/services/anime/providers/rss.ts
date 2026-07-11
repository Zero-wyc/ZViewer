import {
  AnimeSourceProvider,
  AnimeSearchResult,
  AnimeEpisode,
  AnimePlaybackUrl,
} from '../types';

interface RssConfig {
  url: string;
  name?: string;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface FeedItem {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
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

function extractAttribute(tagName: string, attr: string, xml: string): string {
  const regex = new RegExp(
    `<${tagName}[^>]*\\s${attr}="([^"]*)"[^>]*>`,
    'i',
  );
  const match = xml.match(regex);
  return match ? decodeXmlEntities(match[1]) : '';
}

function parseRssItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRegex = /<item[\s\S]*?<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[0];
    const title = extractTextContent('title', itemXml);
    const link = extractTextContent('link', itemXml);
    const description =
      extractTextContent('description', itemXml) ||
      extractTextContent('summary', itemXml) ||
      extractTextContent('content', itemXml);
    const pubDate =
      extractTextContent('pubDate', itemXml) ||
      extractTextContent('published', itemXml) ||
      extractTextContent('updated', itemXml);
    const enclosureUrl = extractAttribute('enclosure', 'url', itemXml);

    if (title && (link || enclosureUrl)) {
      items.push({
        title: title.replace(/<[^>]+>/g, ''),
        link: link || enclosureUrl,
        description: description.replace(/<[^>]+>/g, ' ').trim(),
        pubDate,
        enclosureUrl,
      });
    }
  }
  return items;
}

function parseAtomItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const entryRegex = /<entry[\s\S]*?<\/entry>/gi;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[0];
    const title = extractTextContent('title', entryXml);
    const link = extractAttribute('link', 'href', entryXml);
    const description =
      extractTextContent('summary', entryXml) ||
      extractTextContent('content', entryXml);
    const pubDate =
      extractTextContent('published', entryXml) ||
      extractTextContent('updated', entryXml);

    if (title && link) {
      items.push({
        title: title.replace(/<[^>]+>/g, ''),
        link,
        description: description.replace(/<[^>]+>/g, ' ').trim(),
        pubDate,
      });
    }
  }
  return items;
}

async function fetchFeedItems(url: string): Promise<FeedItem[]> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) {
    throw new Error(`RSS 订阅请求失败 [${res.status}]: ${url}`);
  }

  const xml = await res.text();
  if (!xml || !xml.trim()) {
    throw new Error('RSS 订阅返回为空');
  }

  if (xml.includes('<feed')) {
    return parseAtomItems(xml);
  }
  return parseRssItems(xml);
}

export function createRssAnimeProvider(
  sourceId: string,
  displayName: string,
  config: RssConfig,
): AnimeSourceProvider {
  return {
    name: config.name || displayName || `RSS: ${sourceId}`,

    async search(keyword: string): Promise<AnimeSearchResult[]> {
      const items = await fetchFeedItems(config.url);
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
          extra: { feedUrl: item.link },
        }));
    },

    async getEpisodes(identifier: string): Promise<AnimeEpisode[]> {
      const items = await fetchFeedItems(config.url);
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
            title: target.title,
          },
        },
      ];
    },

    async getPlaybackUrl(episode: AnimeEpisode): Promise<AnimePlaybackUrl | null> {
      const url = episode.playbackParams.url;
      if (typeof url !== 'string' || !url) {
        throw new Error('缺少 RSS 条目播放地址');
      }
      return { url };
    },
  };
}
