/**
 * ani-subs 番剧源 — 选择器
 *
 * 复用通用 AnimeSourceBrowser（站点下拉 → 搜索 → 结果卡片 → 选集）。
 *
 * 下拉首项是「全部站点（聚合搜索）」：后端并发抓取所有订阅源、按归一化标题
 * 去重后返回一份列表，每条结果自带真实站点 key（`source`）与站点名。
 * AnimeSourceBrowser 的选集路由读的正是 `show.source`，所以聚合模式不需要
 * 复合 id，也不需要在这里反解。
 *
 * 为什么默认选中聚合：订阅动辄十几个源，用户事先并不知道哪家有目标番剧，
 * 逐个试是最糟的体验。单站点选项仍在，慢或要指定线路时随手切。
 */

import {
  AnimeSourceBrowser,
  type AnimeSourceBrowserProps,
} from '@/modules/anime-browser'
import type { AniSubsSearchResult, AniSubsSource } from './types'
import {
  getAniSubsEpisodes,
  getAniSubsSources,
  searchAllAniSubs,
  searchAniSubs,
} from './api'
import { t } from '@/i18n'

/** 聚合搜索虚拟站点 id（站点下拉首项） */
const AGGREGATE_SOURCE_ID = '__all__'

export function AniSubsSelector(props: AnimeSourceBrowserProps) {
  return (
    <AnimeSourceBrowser
      {...props}
      kind="anisubs"
      title={t('ani-subs 番剧源')}
      getSources={getSourcesWithAggregate}
      search={searchAniSubsCompat}
      getEpisodes={getAniSubsEpisodes}
    />
  )
}

/** 下拉数据源：首项是聚合搜索。模块级函数，保证引用稳定（宿主拿它做 effect 依赖）。 */
async function getSourcesWithAggregate(): Promise<AniSubsSource[]> {
  const sources = await getAniSubsSources()
  return [
    { id: AGGREGATE_SOURCE_ID, name: t('全部站点（聚合搜索）') },
    ...sources,
  ]
}

async function searchAniSubsCompat(
  source: string,
  keyword: string
): Promise<AniSubsSearchResult[]> {
  if (source === AGGREGATE_SOURCE_ID) return searchAllAniSubs(keyword)
  return searchAniSubs(source, keyword)
}
