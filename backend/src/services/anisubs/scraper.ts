/**
 * ani-subs HTML 抓取工具
 *
 * 处理 URL 规范化、HTML 获取、cheerio 选择器解析、集数提取、视频地址匹配等。
 * 所有函数纯工具化，不依赖外部状态。
 */

import { load } from 'cheerio';
import type { AniSubsSearchConfig, AniSubsMediaFormat } from './types';
import { fetchText, type FetchTextResult } from './httpClient';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 构建完整的浏览器级请求头，尽量通过 Cloudflare 的 managed challenge。
 * 部分 Cloudflare 配置仅检查请求头是否像浏览器，添加这些头可提高成功率。
 */
export function buildBrowserHeaders(
  url: string,
  extra?: Record<string, string>,
): Record<string, string> {
  let origin = '';
  let referer = '';
  try {
    const parsed = new URL(url);
    origin = `${parsed.protocol}//${parsed.host}`;
    referer = `${origin}/`;
  } catch {
    // ignore
  }
  return {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,application/rss+xml,application/atom+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Ch-Ua':
      '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    ...(origin ? { Origin: origin } : {}),
    ...(referer ? { Referer: referer } : {}),
    ...extra,
  };
}

/**
 * 检测响应是否被 Cloudflare 拦截（JS Challenge / Managed Challenge）。
 * 兼容 Response 和 FetchTextResult 两种输入。
 */
export function isCloudflareBlocked(
  res: Response | FetchTextResult,
): boolean {
  const status = res.status;
  if (status !== 403 && status !== 503) return false;
  const server =
    'headers' in res
      ? (res as FetchTextResult).headers['server'] || ''
      : (res as Response).headers.get('server') || '';
  if (server.toLowerCase().includes('cloudflare')) return true;
  const cfRay =
    'headers' in res
      ? (res as FetchTextResult).headers['cf-ray'] || ''
      : (res as Response).headers.get('cf-ray') || '';
  if (cfRay) return true;
  return false;
}

type CheerioRoot = ReturnType<typeof load>;
type CheerioInput = Parameters<CheerioRoot>[0];

function asCheerioInput(el: unknown): CheerioInput {
  return el as CheerioInput;
}

/** 将相对 URL 转为绝对 URL */
export function toAbsoluteUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

/** 从 URL 提取 origin（protocol + host） */
export function resolveBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/** 获取 HTML 页面内容 */
export async function fetchHtml(
  url: string,
  cookies?: string,
): Promise<string> {
  const headers = buildBrowserHeaders(
    url,
    cookies ? { Cookie: cookies } : undefined,
  );

  const result = await fetchText(url, { headers });

  if (isCloudflareBlocked(result)) {
    throw new Error(
      `该数据源被 Cloudflare 防护拦截 [${result.status}]，服务器无法直接访问`,
    );
  }
  if (!result.ok) {
    throw new Error(
      `请求失败 [${result.status}]: ${url}${result.error ? ` (${result.error})` : ''}`,
    );
  }
  return result.body;
}

/** 从名称中提取集数 */
export function extractEpisodeNumber(name: string, pattern?: string): number {
  if (!pattern) {
    const m = name.match(/第\s*(\d+(?:\.\d+)?)\s*[话集]/);
    return m ? Number(m[1]) : 0;
  }
  try {
    const re = new RegExp(pattern, 'i');
    const m = name.match(re);
    if (m?.groups?.ep) {
      const n = Number(m.groups.ep);
      return Number.isNaN(n) ? 0 : n;
    }
  } catch {
    // ignore invalid regex
  }
  const fallback = name.match(/(\d+(?:\.\d+)?)/);
  return fallback ? Number(fallback[1]) : 0;
}

/** 匹配频道名称（支持简单正则与 (?!) 负向断言） */
export function matchChannelName(name: string, pattern?: string): boolean {
  if (!pattern) return true;
  try {
    if (pattern.startsWith('(?!')) {
      const end = pattern.indexOf(')');
      const inner = pattern.slice(3, end);
      const rest = pattern.slice(end + 1);
      if (new RegExp(inner, 'i').test(name)) return false;
      if (!rest) return true;
      return new RegExp(rest, 'i').test(name);
    }
    return new RegExp(pattern, 'i').test(name);
  } catch {
    return true;
  }
}

/** 从 URL 推断媒体容器格式 */
export function detectMediaFormat(url: string): AniSubsMediaFormat {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.flv')) return 'flv';
  if (lower.endsWith('.mp4')) return 'mp4';
  if (lower.includes('.m3u8')) return 'hls';
  if (lower.includes('.flv')) return 'flv';
  if (lower.includes('.mp4')) return 'mp4';
  return 'unknown';
}

// --- 内部数据结构 ---

interface SubjectLink {
  title: string;
  url: string;
}

interface EpisodeInfo {
  id: string;
  title: string;
  episodeNumber: number;
  url: string;
}

// --- 主体选择器 ---

function selectSubjectLinksA(
  $: CheerioRoot,
  selector: string,
  baseUrl: string,
): SubjectLink[] {
  const results: SubjectLink[] = [];
  $(selector).each((_idx: number, el: unknown) => {
    const $el = $(asCheerioInput(el));
    const title = $el.text().trim();
    let url = $el.attr('href') || '';
    if (!url && $el.is('img')) {
      const parent = $el.closest('a');
      url = parent.attr('href') || '';
    }
    if (title && url) {
      results.push({ title, url: toAbsoluteUrl(url, baseUrl) });
    }
  });
  return results;
}

function selectSubjectLinksIndexed(
  $: CheerioRoot,
  namesSelector: string,
  linksSelector: string,
  baseUrl: string,
): SubjectLink[] {
  const names: string[] = [];
  $(namesSelector).each((_idx: number, el: unknown) => {
    names.push($(asCheerioInput(el)).text().trim());
  });
  const links: string[] = [];
  $(linksSelector).each((_idx: number, el: unknown) => {
    links.push($(asCheerioInput(el)).attr('href') || '');
  });
  return names
    .map((title, idx) =>
      title && links[idx]
        ? { title, url: toAbsoluteUrl(links[idx], baseUrl) }
        : null,
    )
    .filter(Boolean) as SubjectLink[];
}

/** 解析搜索结果页 HTML，返回主体链接列表 */
export function parseSearchResults(
  html: string,
  config: AniSubsSearchConfig,
  searchUrl: string,
): SubjectLink[] {
  const $ = load(html);
  const baseUrl = resolveBaseUrl(searchUrl);
  const formatId = config.subjectFormatId || 'a';

  if (formatId === 'a' && config.selectorSubjectFormatA) {
    return selectSubjectLinksA(
      $,
      config.selectorSubjectFormatA.selectLists,
      baseUrl,
    );
  }

  if (formatId === 'indexed' && config.selectorSubjectFormatIndexed) {
    return selectSubjectLinksIndexed(
      $,
      config.selectorSubjectFormatIndexed.selectNames,
      config.selectorSubjectFormatIndexed.selectLinks,
      baseUrl,
    );
  }

  return [];
}

// --- 集数选择器 ---

function extractEpisodesIndexGrouped(
  $: CheerioRoot,
  channelConfig: NonNullable<
    AniSubsSearchConfig['selectorChannelFormatFlattened']
  >,
  baseUrl: string,
): EpisodeInfo[] {
  const episodes: EpisodeInfo[] = [];
  const channelNames: string[] = [];

  $(channelConfig.selectChannelNames).each((_idx: number, el: unknown) => {
    channelNames.push($(asCheerioInput(el)).text().trim());
  });

  const episodeLists = $(channelConfig.selectEpisodeLists);
  episodeLists.each((listIdx: number, listEl: unknown) => {
    const channelName = channelNames[listIdx] || '';
    if (!matchChannelName(channelName, channelConfig.matchChannelName)) {
      return;
    }

    $(asCheerioInput(listEl))
      .find(channelConfig.selectEpisodesFromList)
      .each((_idx: number, epEl: unknown) => {
        const $ep = $(asCheerioInput(epEl));
        const title = $ep.text().trim();
        let url = $ep.attr('href') || '';
        if (!url && channelConfig.selectEpisodeLinksFromList) {
          url =
            $ep.find(channelConfig.selectEpisodeLinksFromList).attr('href') ||
            '';
        }
        if (!title || !url) return;

        const episodeNumber = extractEpisodeNumber(
          title,
          channelConfig.matchEpisodeSortFromName,
        );
        episodes.push({
          id: `${channelName}-${title}-${episodeNumber}`,
          title: channelName ? `[${channelName}] ${title}` : title,
          episodeNumber,
          url: toAbsoluteUrl(url, baseUrl),
        });
      });
  });

  return episodes;
}

function extractEpisodesNoChannel(
  $: CheerioRoot,
  config: NonNullable<AniSubsSearchConfig['selectorChannelFormatNoChannel']>,
  baseUrl: string,
): EpisodeInfo[] {
  const episodes: EpisodeInfo[] = [];
  $(config.selectEpisodes).each((_idx: number, el: unknown) => {
    const $ep = $(asCheerioInput(el));
    const title = $ep.text().trim();
    let url = $ep.attr('href') || '';
    if (!url && config.selectEpisodeLinks) {
      url = $ep.find(config.selectEpisodeLinks).attr('href') || '';
    }
    if (!title || !url) return;
    const episodeNumber = extractEpisodeNumber(
      title,
      config.matchEpisodeSortFromName,
    );
    episodes.push({
      id: `${title}-${episodeNumber}`,
      title,
      episodeNumber,
      url: toAbsoluteUrl(url, baseUrl),
    });
  });
  return episodes;
}

/** 解析主体详情页 HTML，返回集数列表 */
export function parseEpisodes(
  html: string,
  config: AniSubsSearchConfig,
  subjectUrl: string,
): EpisodeInfo[] {
  const $ = load(html);
  const baseUrl = resolveBaseUrl(subjectUrl);
  const channelFormatId = config.channelFormatId || 'no-channel';

  if (
    channelFormatId === 'index-grouped' &&
    config.selectorChannelFormatFlattened
  ) {
    return extractEpisodesIndexGrouped(
      $,
      config.selectorChannelFormatFlattened,
      baseUrl,
    );
  }

  if (
    channelFormatId === 'no-channel' &&
    config.selectorChannelFormatNoChannel
  ) {
    return extractEpisodesNoChannel(
      $,
      config.selectorChannelFormatNoChannel,
      baseUrl,
    );
  }

  return [];
}

// --- 视频地址匹配 ---

interface VideoMatchResult {
  url: string;
  headers?: Record<string, string>;
  format?: AniSubsMediaFormat;
}

function findVideoUrl(
  html: string,
  config: NonNullable<AniSubsSearchConfig['matchVideo']>,
  pageUrl: string,
): VideoMatchResult | null {
  const regex = new RegExp(config.matchVideoUrl, 'gi');
  const match = regex.exec(html);
  if (!match) return null;

  let url = match.groups?.v || match[0];
  if (!url) return null;

  if (url.startsWith('url=')) {
    url = url.slice(4);
  }
  url = toAbsoluteUrl(decodeURIComponent(url), pageUrl);

  const headers: Record<string, string> = {};
  if (config.addHeadersToVideo?.referer) {
    headers.Referer = config.addHeadersToVideo.referer;
  } else {
    headers.Referer = pageUrl;
  }
  if (config.addHeadersToVideo?.userAgent) {
    headers['User-Agent'] = config.addHeadersToVideo.userAgent;
  }
  if (config.addHeadersToVideo?.origin) {
    headers.Origin = config.addHeadersToVideo.origin;
  }
  return { url, headers, format: detectMediaFormat(url) };
}

/** 解析剧集页面 HTML，提取视频播放地址 */
export async function resolveVideoUrl(
  episodeUrl: string,
  config: NonNullable<AniSubsSearchConfig['matchVideo']>,
): Promise<VideoMatchResult | null> {
  const html = await fetchHtml(episodeUrl, config.cookies);
  let result = findVideoUrl(html, config, episodeUrl);
  if (result) return result;

  if (config.enableNestedUrl && config.matchNestedUrl) {
    try {
      const nestedRe = new RegExp(config.matchNestedUrl, 'gi');
      const nestedMatch = nestedRe.exec(html);
      if (nestedMatch?.[0]) {
        const nestedUrl = toAbsoluteUrl(nestedMatch[0], episodeUrl);
        const nestedHtml = await fetchHtml(nestedUrl, config.cookies);
        result = findVideoUrl(nestedHtml, config, nestedUrl);
        if (result) return result;
      }
    } catch {
      // ignore
    }
  }
  return null;
}
