/**
 * CMS 采集源前端模块 — 选择器
 *
 * 复用通用 AnimeSourceBrowser（站点下拉 → 搜索 → 结果卡片 → 选集），
 * 将 CMS 详情的多个播放组展平为剧集列表：
 * - 单播放组：直接用组内集名
 * - 多播放组：剧集名前缀 `[组名]` 区分，各组成员均可独立添加
 *
 * 剧集 id 编码 `${vodId}|${playFromIndex}|${episodeIndex}`，
 * 播放参数保存在 playbackParams（vodId/playFromIndex/episodeIndex），
 * 添加影片时写入 sourceMeta，播放时实时重解析。
 *
 * anisubs 的 Source/SearchResult/Episode 类型与 CMS 数据结构兼容
 * （{id,name} / {id,title,cover...} / {id,title,episodeNumber,playbackParams}），
 * 这里直接复用其类型做适配层返回值。
 */

import {
  AnimeSourceBrowser,
  type AnimeSourceBrowserProps,
} from '@/modules/room/components/AnimeSourceBrowser'
import type {
  AniSubsEpisode,
  AniSubsSearchResult,
  AniSubsSource,
} from '@/modules/anisubs'
import { getCmsSources, searchCms, getCmsDetail } from './api'

export type { AnimeSourceBrowserProps }

export function CmsSelector(props: AnimeSourceBrowserProps) {
  return (
    <AnimeSourceBrowser
      {...props}
      kind="cms"
      title="TVBox 采集源"
      searchPlaceholder="输入影片名称搜索"
      emptyText="输入关键词开始搜索影片"
      getSources={getCmsSourcesCompat}
      search={searchCmsCompat}
      getEpisodes={getCmsEpisodesCompat}
    />
  )
}

async function getCmsSourcesCompat(): Promise<AniSubsSource[]> {
  const sources = await getCmsSources()
  return sources.map((s) => ({ id: s.id, name: s.name }))
}

async function searchCmsCompat(
  source: string,
  keyword: string
): Promise<AniSubsSearchResult[]> {
  const results = await searchCms(source, keyword)
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    cover: r.cover,
    description: r.description,
    source: r.source,
  }))
}

/** 展平 CMS 详情播放组为兼容剧集列表 */
async function getCmsEpisodesCompat(
  source: string,
  vodId: string
): Promise<AniSubsEpisode[]> {
  const detail = await getCmsDetail(source, vodId)
  const multiGroup = detail.playGroups.length > 1
  return detail.playGroups.flatMap((group) =>
    group.episodes.map((ep): AniSubsEpisode => ({
      id: `${detail.id}|${ep.playbackParams.playFromIndex}|${ep.playbackParams.episodeIndex}`,
      title: multiGroup ? `[${group.name}] ${ep.title}` : ep.title,
      episodeNumber: ep.index + 1,
      playbackParams: ep.playbackParams as unknown as Record<string, unknown>,
    }))
  )
}
