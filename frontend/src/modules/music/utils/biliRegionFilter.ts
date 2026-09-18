/**
 * B站 列表过滤装饰（纯函数，无运行时依赖，供 MusicBilibiliPage 与单测共用）。
 *
 * 从 MusicBilibiliPage 迁出的部分：屏蔽词类型与匹配、分区条目装饰
 * （require 限定 + 分区屏蔽词 + 全局屏蔽词）。
 * 注意：本文件会被 node:test 直接以 TS 运行（类型剥离），只能有
 * type-only 的外部依赖，不得引入运行时 import。
 */
import type { BilibiliVideoItem } from '@/modules/bilibili/bilibiliApi'

/** 屏蔽词作用范围：标题 / 标签 / 两者（每个词可单独设置） */
export type BlockWordScope = 'title' | 'tag' | 'both'

export interface BlockWord {
  word: string
  scope: BlockWordScope
}

/** 分类标签词的来源方式：搜索（关键词搜索）/ 标签（B站 tag 检索）/
 *  全部（搜索 + 标签两源都取）——点击方式徽标循环切换 */
export type RegionTagSource = 'search' | 'btag' | 'both'

/** 分类标签词的属性：聚合（结果并入列表，多词结果合并显示）/
 *  限定（视频标签必须包含该词才显示）——点击属性徽标切换 */
export type RegionTagRole = 'aggregate' | 'require'

export interface RegionTagRule {
  word: string
  /** 来源方式（仅聚合属性生效；限定词按视频 tag 匹配，无来源之分） */
  source: RegionTagSource
  role: RegionTagRole
}

export interface RegionTagEntry {
  name: string
  /** 分类标签词规则（首个默认为分类名的搜索 tag） */
  tags?: RegionTagRule[]
  /** 分区限定屏蔽词（仅该分区列表生效；左栏分类条目右上角设置，
   *  词级作用范围与全局屏蔽词同语义：标题/标签/全部） */
  blockWords?: BlockWord[]
}

/** 分区条目的规则列表（未自定义规则时默认把分类名作为单个「搜索」聚合词） */
export function getRegionRules(tag: RegionTagEntry): RegionTagRule[] {
  return (
    tag.tags ?? [
      {
        word: tag.name,
        source: 'search' as RegionTagSource,
        role: 'aggregate' as RegionTagRole,
      },
    ]
  )
}

/** 按屏蔽词列表过滤视频：各词按自身作用范围匹配标题/标签（不区分大小写），
 * 命中即剔除。全局屏蔽词与分区屏蔽词共用同一段匹配逻辑 */
export function filterByBlockWords(
  list: BilibiliVideoItem[],
  words: BlockWord[]
): BilibiliVideoItem[] {
  if (words.length === 0) return list
  return list.filter((it) => {
    const title = it.title.toLowerCase()
    const tag = (it.tag ?? '').toLowerCase()
    return !words.some(({ word, scope }) => {
      const w = word.toLowerCase()
      if (scope === 'title') return title.includes(w)
      if (scope === 'tag') return tag.includes(w)
      return title.includes(w) || tag.includes(w)
    })
  })
}

/** 缓存条目 → 展示条目：require 限定 + 分区屏蔽词 + 全局屏蔽词
 * （封面代理由调用方追加） */
export function decorateRegionItems(
  merged: BilibiliVideoItem[],
  tag: RegionTagEntry,
  blockWords: BlockWord[]
): BilibiliVideoItem[] {
  const requireWords = getRegionRules(tag)
    .filter((r) => r.role === 'require')
    .map((r) => r.word.toLowerCase())
  let filtered = merged
  if (requireWords.length > 0) {
    filtered = filtered.filter((it) => {
      const tags = (it.tag ?? '').toLowerCase()
      return requireWords.every((w) => tags.includes(w))
    })
  }
  filtered = filterByBlockWords(filtered, tag.blockWords ?? [])
  return filterByBlockWords(filtered, blockWords)
}
