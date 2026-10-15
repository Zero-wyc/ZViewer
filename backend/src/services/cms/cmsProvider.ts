/**
 * CMS 采集源模块 — Provider 工厂
 *
 * 基于苹果 CMS V10 JSON 采集接口（api.php/provide/vod）创建 provider 实例：
 *   搜索   ?ac=videolist&wd=关键词
 *   详情   ?ac=videolist&ids=影片ID   （含 vod_play_url 剧集列表）
 *   列表   ?ac=list&pg=页码           （分类 + 简要列表）
 *
 * vod_play_url 结构：'组1集1$链接#集2$链接$$$组2集1$链接'，
 * 组名对应 vod_play_from 的 $$$ 分组。播放地址每次实时从源站读取，
 * 不落库不缓存（采集站直链常漂移），与 anime 源的时效语义一致。
 */

import type {
  CmsSite,
  CmsSourceProvider,
  CmsSearchResult,
  CmsVodDetail,
  CmsEpisode,
  CmsPlayGroup,
  CmsPlaybackUrl,
  CmsPlaybackParams,
  CmsMediaFormat,
} from './types';
import { fetchText } from '../anisubs/httpClient';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 15000;

/** CMS 原始响应（字段宽松） */
interface CmsApiVodItem {
  vod_id?: unknown;
  vod_name?: unknown;
  vod_pic?: unknown;
  vod_remarks?: unknown;
  vod_content?: unknown;
  vod_year?: unknown;
  vod_area?: unknown;
  type_name?: unknown;
  vod_play_from?: unknown;
  vod_play_url?: unknown;
}

interface CmsApiResponse {
  code?: unknown;
  list?: unknown;
}

/** 构造 CMS 请求 URL（兼容 api 已带 query / 尾斜杠的形态） */
function buildApiUrl(api: string, params: Record<string, string>): string {
  const url = new URL(api);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

/** 嗅探媒体格式 */
export function detectCmsMediaFormat(url: string): CmsMediaFormat {
  const lower = url.toLowerCase();
  if (/\.m3u8(?=[?#]|$)/.test(lower)) return 'hls';
  if (/\.flv(?=[?#]|$)/.test(lower)) return 'flv';
  if (/\.mp4(?=[?#]|$)/.test(lower) || /\.mkv(?=[?#]|$)/.test(lower)) {
    return 'mp4';
  }
  return 'unknown';
}

/** 请求 CMS JSON API（ac=videolist 失败时回退 ac=detail） */
async function requestVodList(
  site: CmsSite,
  params: Record<string, string>,
): Promise<CmsApiVodItem[]> {
  const requestOnce = async (ac: string): Promise<CmsApiVodItem[]> => {
    const url = buildApiUrl(site.api, { ...params, ac });
    const result = await fetchText(url, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT, Accept: 'application/json' },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!result.ok) return [];
    try {
      const parsed = JSON.parse(result.body) as CmsApiResponse;
      return Array.isArray(parsed?.list) ? (parsed.list as CmsApiVodItem[]) : [];
    } catch {
      return [];
    }
  };

  // 苹果 CMS 标准 ac=videolist；部分老站只认 ac=detail，双保险
  let list = await requestOnce('videolist');
  if (list.length === 0) {
    list = await requestOnce('detail');
  }
  return list;
}

function asString(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

/**
 * 解析 vod_play_url / vod_play_from 为播放组。
 * 返回值与 $$$ 原始分组下标一一对应（parseVodDetail 与 resolve 取原始 URL
 * 共用此函数，保证 playFromIndex 定位一致）。
 */
function parsePlayGroups(
  rawUrl: string,
  rawFrom: string,
  vodId: string,
): CmsPlayGroup[] {
  const groupNames = rawFrom.split('$$$').map((s) => s.trim());
  const groupUrls = rawUrl.split('$$$');

  const groups: CmsPlayGroup[] = [];
  for (let g = 0; g < groupUrls.length; g++) {
    const rawEpisodes = groupUrls[g]
      .split('#')
      .map((s) => s.trim())
      .filter(Boolean);
    if (rawEpisodes.length === 0) continue;

    const episodes: CmsEpisode[] = [];
    for (const raw of rawEpisodes) {
      // '第01集$https://...'；取第一个 '$' 分隔标题与地址
      const sepIdx = raw.indexOf('$');
      const title = sepIdx >= 0 ? raw.slice(0, sepIdx).trim() : raw;
      const url = sepIdx >= 0 ? raw.slice(sepIdx + 1).trim() : '';
      if (!url) continue;
      episodes.push({
        index: episodes.length,
        title: title || `第${episodes.length + 1}集`,
        playbackParams: { vodId, playFromIndex: g, episodeIndex: episodes.length },
      });
    }
    if (episodes.length === 0) continue;

    groups.push({
      name: groupNames[g]?.trim() || `播放源${g + 1}`,
      episodes,
    });
  }
  return groups;
}

/** 从 CMS API 条目解析影片详情 */
function parseVodDetail(item: CmsApiVodItem, site: CmsSite): CmsVodDetail {
  const vodId = asString(item.vod_id);
  return {
    id: vodId,
    title: asString(item.vod_name),
    cover: asString(item.vod_pic) || undefined,
    description: asString(item.vod_content) || undefined,
    year: asString(item.vod_year) || undefined,
    area: asString(item.vod_area) || undefined,
    typeName: asString(item.type_name) || undefined,
    remark: asString(item.vod_remarks) || undefined,
    playGroups: parsePlayGroups(
      asString(item.vod_play_url),
      asString(item.vod_play_from),
      vodId,
    ),
    source: site.key,
  };
}

/** 从 CMS API 创建 provider 实例 */
export function createCmsProvider(site: CmsSite): CmsSourceProvider {
  const siteOrigin = (() => {
    try {
      return new URL(site.api).origin + '/';
    } catch {
      return '';
    }
  })();

  return {
    site,

    async search(keyword: string): Promise<CmsSearchResult[]> {
      const list = await requestVodList(site, { wd: keyword });
      return list
        .map((item) => {
          const id = asString(item.vod_id);
          return {
            id,
            title: asString(item.vod_name),
            cover: asString(item.vod_pic) || undefined,
            description: asString(item.vod_content) || undefined,
            remark: asString(item.vod_remarks) || undefined,
            source: site.key,
          } satisfies CmsSearchResult;
        })
        .filter((r) => r.id && r.title)
        .slice(0, 30);
    },

    async getDetail(vodId: string): Promise<CmsVodDetail> {
      const list = await requestVodList(site, { ids: vodId });
      const item = list[0];
      if (!item) {
        throw new Error('影片不存在或源站接口无响应');
      }
      const detail = parseVodDetail(item, site);
      if (detail.playGroups.length === 0) {
        throw new Error('影片没有可播放的剧集');
      }
      return detail;
    },

    async getPlaybackUrl(
      params: CmsPlaybackParams,
    ): Promise<CmsPlaybackUrl | null> {
      const list = await requestVodList(site, { ids: params.vodId });
      const item = list[0];
      if (!item) return null;

      // 直接从原始 vod_play_url 串按组/集序号取地址（与 parsePlayGroups 的
      // $$$/# 分组语义一致，不经过中间对象，保证 URL 实时新鲜）
      const rawGroups = asString(item.vod_play_url)
        .split('$$$')
        .map((g) =>
          g
            .split('#')
            .map((s) => s.trim())
            .filter((s) => s.includes('$') && s.slice(s.indexOf('$') + 1).trim()),
        );
      const groupIndex =
        params.playFromIndex >= 0 && params.playFromIndex < rawGroups.length
          ? params.playFromIndex
          : rawGroups.findIndex((g) => g.length > 0);
      if (groupIndex < 0) return null;

      const raw = rawGroups[groupIndex][params.episodeIndex];
      if (!raw) return null;

      const url = raw.slice(raw.indexOf('$') + 1).trim();
      if (!url || !/^https?:\/\//i.test(url)) return null;

      const headers: Record<string, string> = { 'User-Agent': DEFAULT_USER_AGENT };
      if (siteOrigin) {
        headers.Referer = siteOrigin;
      }

      return {
        url,
        headers,
        format: detectCmsMediaFormat(url),
      };
    },
  };
}
