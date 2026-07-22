/**
 * Kazumi 独立模块 — Provider 工厂
 *
 * 基于 Kazumi XPath 规则创建 provider 实例。
 */

import type {
  KazumiRule,
  KazumiSourceProvider,
  KazumiSearchResult,
  KazumiEpisode,
  KazumiPlaybackUrl,
} from './types';
import {
  fetchHtml,
  parseHtmlDocument,
  selectXPath,
  extractText,
  extractAttr,
  extractEpisodeNumber,
  resolveBaseUrl,
  toAbsoluteUrl,
  resolveVideoUrl,
} from './scraper';

interface EpisodeInfo {
  id: string;
  title: string;
  episodeNumber: number;
  url: string;
}

/** 从 Kazumi 规则创建 provider 实例 */
export function createKazumiProvider(
  sourceId: string,
  rule: KazumiRule,
): KazumiSourceProvider {
  return {
    name: rule.name,

    async search(keyword: string): Promise<KazumiSearchResult[]> {
      const searchUrl = rule.searchURL.replace(
        /@keyword/g,
        encodeURIComponent(keyword),
      );
      const html = await fetchHtml(searchUrl, {
        userAgent: rule.userAgent,
        referer: rule.referer || rule.baseURL,
      });
      const doc = parseHtmlDocument(html);
      const baseUrl = resolveBaseUrl(searchUrl);

      const listNodes = selectXPath(doc, rule.searchList);
      const results: KazumiSearchResult[] = [];

      for (const node of listNodes) {
        const nameNodes = selectXPath(node as Node, rule.searchName);
        const resultNodes = selectXPath(node as Node, rule.searchResult);
        const title = extractText(nameNodes[0]);
        const linkNode = resultNodes[0];
        const url = linkNode
          ? toAbsoluteUrl(
              extractAttr(linkNode, 'href') || extractText(linkNode),
              baseUrl,
            )
          : '';
        if (title && url) {
          results.push({
            id: url,
            title,
            source: sourceId,
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

    async getEpisodes(identifier: string): Promise<KazumiEpisode[]> {
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

    async getPlaybackUrl(
      episode: KazumiEpisode,
    ): Promise<KazumiPlaybackUrl | null> {
      const episodeUrl = episode.playbackParams.episodeUrl;
      if (typeof episodeUrl !== 'string' || !episodeUrl) {
        throw new Error('缺少剧集页面地址');
      }
      const result = await resolveVideoUrl(episodeUrl, rule);
      if (!result) {
        return null;
      }
      const headers: Record<string, string> = {};
      headers.Referer = rule.referer || rule.baseURL;
      if (rule.userAgent) {
        headers['User-Agent'] = rule.userAgent;
      }
      return {
        url: result.url,
        headers,
        format: result.format,
      };
    },
  };
}
