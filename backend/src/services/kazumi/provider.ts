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
  toRelativeXPath,
  extractText,
  extractAttr,
  extractEpisodeNumber,
  resolveBaseUrl,
  toAbsoluteUrl,
  resolveVideoUrl,
  normalizeEpisodeUrl,
  detectMediaFormat,
} from './scraper';
import {
  apiSearch,
  apiChapters,
  usesApiSearch,
  usesApiChapters,
} from './api-rule';
import { createSearchPosterReader } from '../anime/searchMetadata';

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
      // API 模式：JSON 接口 + JSONPath（apiLevel 9 规则，searchURL 为空）
      if (usesApiSearch(rule)) {
        const items = await apiSearch(rule, keyword);
        const seen = new Set<string>();
        return items
          .filter((item) => {
            // 详情地址归一化：裸 id 对 baseURL 补全（对齐上游 normalizeEpisodeUrl）
            const src = normalizeEpisodeUrl(rule.baseURL, item.src);
            if (!src || seen.has(src)) return false;
            seen.add(src);
            item.src = src;
            return true;
          })
          .slice(0, 20)
          .map((item) => ({
            id: item.src,
            title: item.name,
            source: sourceId,
          }));
      }

      const searchUrl = rule.searchURL.replace(
        /@keyword/g,
        encodeURIComponent(keyword),
      );
      const html = await fetchHtml(searchUrl, {
        userAgent: rule.userAgent,
        referer: rule.referer || rule.baseURL,
      });
      const doc = parseHtmlDocument(html);
      const baseUrl = searchUrl;
      const readPoster = createSearchPosterReader(html, baseUrl);

      const listNodes = selectXPath(doc, rule.searchList);
      const results: KazumiSearchResult[] = [];

      for (const node of listNodes) {
        const nameNodes = selectXPath(
          node as Node,
          toRelativeXPath(rule.searchName),
        );
        const resultNodes = selectXPath(
          node as Node,
          toRelativeXPath(rule.searchResult),
        );
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
            cover: readPoster(url),
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
      // 归一化详情地址：旧规则为绝对 URL（幂等），新 API 规则可能是裸 id
      const subjectUrl = normalizeEpisodeUrl(rule.baseURL, identifier);

      // API 模式：章节 JSON 接口（nested/delimited）
      if (usesApiChapters(rule)) {
        const roads = await apiChapters(rule, subjectUrl);
        const episodes: KazumiEpisode[] = [];
        for (const road of roads) {
          for (let i = 0; i < road.urls.length; i++) {
            const title = road.titles[i];
            const url = road.urls[i];
            const episodeNumber = extractEpisodeNumber(title);
            episodes.push({
              id: `${title}-${episodeNumber}-${url}`,
              title,
              episodeNumber: episodeNumber || 1,
              playbackParams: { episodeUrl: url },
            });
          }
        }
        return episodes;
      }

      const html = await fetchHtml(subjectUrl, {
        userAgent: rule.userAgent,
        referer: rule.referer || rule.baseURL,
      });
      const doc = parseHtmlDocument(html);
      const baseUrl = resolveBaseUrl(subjectUrl);

      const roadNodes = selectXPath(doc, rule.chapterRoads);
      const episodes: EpisodeInfo[] = [];

      for (const road of roadNodes) {
        const resultNodes = selectXPath(
          road as Node,
          toRelativeXPath(rule.chapterResult),
        );
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
      const headers: Record<string, string> = {};
      headers.Referer = rule.referer || rule.baseURL;
      if (rule.userAgent) {
        headers['User-Agent'] = rule.userAgent;
      }
      // API 章节规则的 episodeUrlPath 可直接产出媒体地址（.m3u8/.mp4/.flv），
      // 无需再当播放页抓取解析
      const directFormat = detectMediaFormat(episodeUrl);
      if (directFormat !== 'unknown') {
        return { url: episodeUrl, headers, format: directFormat };
      }
      const result = await resolveVideoUrl(episodeUrl, rule);
      if (!result) {
        return null;
      }
      return {
        url: result.url,
        headers,
        format: result.format,
      };
    },
  };
}
