/**
 * 哔哩哔哩页列表 SWR 缓存与分区单页取数。
 *
 * 从 MusicBilibiliPage.tsx 原样迁出（模块级纯逻辑，无组件依赖）。
 */

import {
  searchBilibiliVideos,
  type BilibiliVideoItem,
} from '@/modules/bilibili/bilibiliApi'
import { getRegionRules } from '../utils/biliRegionFilter'
import type { RegionTagEntry } from '../utils/biliRegionFilter'

/** 列表页缓存条目：存「套用屏蔽词与封面代理之前」的原始合并结果，
 * 读出时按当前屏蔽词现算，保证修改屏蔽词立即生效 */
export interface BiliListCacheEntry {
  items: BilibiliVideoItem[]
  total: number | null
  /** 分区路径：多源中单源最大条数（pageFull 判定用；其余路径同 items.length） */
  maxSourceLen: number
  /** 写入时间（毫秒），判断新鲜度 */
  at: number
}
const BILI_LIST_CACHE_MAX = 48
/** 新鲜判定：新鲜命中直接使用不回源；过期命中先展示旧内容再后台刷新 */
export const BILI_LIST_CACHE_FRESH_MS = 5 * 60 * 1000
/** 分区预取数量上限（侧栏顺序前 N 个；逐个间隔避免挤占当前浏览请求） */
export const PREFETCH_REGION_TAG_LIMIT = 6
/** 分区预取的逐个间隔（毫秒） */
export const PREFETCH_REGION_TAG_STAGGER_MS = 1200
export const biliListCache = new Map<string, BiliListCacheEntry>()

export function biliListCacheSet(key: string, entry: BiliListCacheEntry): void {
  biliListCache.delete(key)
  biliListCache.set(key, entry)
  while (biliListCache.size > BILI_LIST_CACHE_MAX) {
    const oldest = biliListCache.keys().next().value
    if (oldest === undefined) break
    biliListCache.delete(oldest)
  }
}

/** 缓存 key 构造（分区种类/推荐榜单/顶栏搜索三类；fav 个人收藏不缓存） */
export const biliKwCacheKey = (keyword: string, pn: number) =>
  `kw:${keyword}|${pn}`
export const biliRankCacheKey = (pn: number) => `rank:3|v2|${pn}`
export const biliRtCacheKey = (tag: RegionTagEntry, pn: number) =>
  `rt:v2|${tag.name}|${JSON.stringify(tag.tags ?? null)}|${pn}`

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** 分区条目单页取数：聚合词按来源**串行**搜索/标签检索（词间 350ms +
 *  全空 800ms 后自动重试一次），bvid 去重合并。
 *
 *  原实现多词 Promise.allSettled 并行——一个分类 2-4 个词、跳页补齐最多
 *  4 轮 = 单次翻页最多 16 个 WBI 搜索请求，极易触发 B站 搜索风控（返回
 *  空结果/拒绝），表现为「翻下一页后列表空白，要点好几次刷新才出视频」。
 *  串行 + 延迟显著降低风控触发；全空自动重试掩盖偶发失败。
 *  （加载与预取共用；预取经后端缓存预热，切换分区时前端直接命中） */
export async function fetchRegionTagPage(
  tag: RegionTagEntry,
  pageNo: number
): Promise<{
  merged: BilibiliVideoItem[]
  total: number | null
  maxSourceLen: number
}> {
  const aggRules = getRegionRules(tag).filter((r) => r.role === 'aggregate')
  const jobs: { word: string; mode: 'search' | 'tag' }[] = [
    ...aggRules
      .filter((r) => r.source !== 'btag')
      .map((r) => ({ word: r.word, mode: 'search' as const })),
    ...aggRules
      .filter((r) => r.source !== 'search')
      .map((r) => ({ word: r.word, mode: 'tag' as const })),
  ]

  const runOnce = async () => {
    const results: { items: BilibiliVideoItem[]; total: number | null }[] = []
    for (let i = 0; i < jobs.length; i++) {
      // 词间间隔：连续高频 WBI 搜索是风控触发的主因
      if (i > 0) await sleep(350)
      try {
        results.push(
          await searchBilibiliVideos(jobs[i].word, pageNo, jobs[i].mode)
        )
      } catch {
        // 单词失败（风控/网络）容忍：其他词仍可撑起本页
      }
    }
    return results
  }

  let results = await runOnce()
  if (results.length === 0) {
    // 全部词失败（典型为风控）：延迟后自动重试一次
    await sleep(800)
    results = await runOnce()
  }

  const merged: BilibiliVideoItem[] = []
  const seen = new Set<string>()
  let maxSourceLen = 0
  let total: number | null = null
  for (const r of results) {
    maxSourceLen = Math.max(maxSourceLen, r.items.length)
    if (total == null) total = r.total
    for (const it of r.items) {
      if (!seen.has(it.bvid)) {
        seen.add(it.bvid)
        merged.push(it)
      }
    }
  }
  return { merged, total, maxSourceLen }
}
