/**
 * CMS 采集源前端模块 — 选择器
 *
 * 复用通用 AnimeSourceBrowser（站点下拉 → 搜索 → 结果卡片 → 选集），
 * 将 CMS 详情的多个播放组展平为剧集列表：
 * - 单播放组：直接用组内集名
 * - 多播放组：剧集名前缀 `[组名]` 区分，各组成员均可独立添加
 *
 * 站点下拉首项为「全部站点」聚合搜索（/cms/search-all 并发全部站点、
 * 标题归一化去重）：搜索结果 id 为复合 id `${source}::${vodId}`，
 * 详情/选集经复合 id 反解真实站点（AnimeSourceBrowser 按 show.source
 * 路由 browse 与选集的 sourceId）。
 *
 * 单站点模式下剧集 id 编码 `${vodId}|${playFromIndex}|${episodeIndex}`，
 * 播放参数保存在 playbackParams，添加影片时写入 sourceMeta，
 * 播放时实时重解析。
 *
 * anisubs 的 Source/SearchResult/Episode 类型与 CMS 数据结构兼容
 * （{id,name} / {id,title,cover...} / {id,title,episodeNumber,playbackParams}），
 * 这里直接复用其类型做适配层返回值。
 */

import {
  AnimeSourceBrowser,
  type AnimeSourceBrowserProps,
} from '@/modules/anime-browser'
import type {
  AniSubsEpisode,
  AniSubsSearchResult,
  AniSubsSource,
} from '@/modules/anisubs'
import { getCmsSources, searchCms, searchAllCms, getCmsDetail } from './api'
import { t } from '@/i18n'

export type { AnimeSourceBrowserProps }

/** 聚合搜索虚拟站点 id（站点下拉首项：并发全部站点，标题去重） */
const AGGREGATE_SOURCE_ID = '__all__'

export function CmsSelector(props: AnimeSourceBrowserProps) {
  return (
    <AnimeSourceBrowser
      {...props}
      kind="cms"
      title={t('TVBox 采集源')}
      searchPlaceholder={t('输入影片名称搜索')}
      emptyText={t('输入关键词开始搜索影片')}
      getSources={getCmsSourcesCompat}
      search={searchCmsCompat}
      getEpisodes={getCmsEpisodesCompat}
      noSourcesHint={t(
        '未找到可用采集源，请管理员在后台「TVBox 采集源」添加配置接口'
      )}
    />
  )
}

async function getCmsSourcesCompat(): Promise<AniSubsSource[]> {
  const sources = await getCmsSources()
  // 首项为聚合搜索虚拟站点；真实站点紧随其后
  return [
    { id: AGGREGATE_SOURCE_ID, name: t('全部站点（聚合搜索）') },
    ...sources.map((s) => ({ id: s.id, name: s.name })),
  ]
}

async function searchCmsCompat(
  source: string,
  keyword: string
): Promise<AniSubsSearchResult[]> {
  if (source === AGGREGATE_SOURCE_ID) {
    const results = await searchAllCms(keyword)
    return results.map((r) => ({
      // 复合 id 供详情路由反解真实站点（browse 经 show.source 路由）
      id: r.id,
      title: r.title,
      cover: r.cover,
      description: r.description,
      source: r.source,
    }))
  }
  const results = await searchCms(source, keyword)
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    cover: r.cover,
    description: r.description,
    source: r.source,
  }))
}

/**
 * 展平 CMS 详情播放组为兼容剧集列表。
 * path 可能是聚合搜索的复合 id `${source}::${vodId}`，需反解真实站点。
 */
async function getCmsEpisodesCompat(
  source: string,
  path: string
): Promise<AniSubsEpisode[]> {
  const sep = path.indexOf('::')
  const realSource = sep > -1 ? path.slice(0, sep) : source
  const vodId = sep > -1 ? path.slice(sep + 2) : path
  const detail = await getCmsDetail(realSource, vodId)
  const multiGroup = detail.playGroups.length > 1
  return detail.playGroups.flatMap((group) =>
    group.episodes.map((ep): AniSubsEpisode => ({
      id: `${path}|${ep.playbackParams.playFromIndex}|${ep.playbackParams.episodeIndex}`,
      title: multiGroup ? `[${group.name}] ${ep.title}` : ep.title,
      episodeNumber: ep.index + 1,
      playbackParams: ep.playbackParams as unknown as Record<string, unknown>,
    }))
  )
}
