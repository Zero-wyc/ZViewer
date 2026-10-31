/**
 * 哔哩哔哩页的本地持久化与数据迁移。
 *
 * 从 MusicBilibiliPage.tsx 原样迁出（纯函数 + localStorage 读写，无组件依赖）：
 * - 分区种类（region tags）及其旧结构迁移
 * - 自定义栏目（custom tabs）
 * - 屏蔽词（block words）
 */

import type { BiliCustomKind } from '@/modules/bilibili/bilibiliApi'
import type {
  BlockWord,
  BlockWordScope,
  RegionTagEntry,
  RegionTagRole,
  RegionTagRule,
  RegionTagSource,
} from '../utils/biliRegionFilter'
import { t as translate } from '@/i18n'

/** 音乐分区默认种类名（创建时分类名默认作为一个「搜索」tag；搜索词不再自动补「音乐」，用户在名称里自行写全） */
export const DEFAULT_REGION_TAGS = [
  '中术',
  '华语音乐',
  '粤语音乐',
  '日语音乐',
  '欧美音乐',
  '纯音乐',
  '电音音乐',
  'DJ音乐',
  '翻唱音乐',
]

/** 旧默认分类名 → 新默认名（取消自动补「音乐」后缀后的一次性迁移映射；纯音乐已含「音乐」无需迁移） */
const LEGACY_DEFAULT_RENAME: Record<string, string> = {
  华语: '华语音乐',
  粤语: '粤语音乐',
  日语: '日语音乐',
  欧美: '欧美音乐',
  电音: '电音音乐',
  DJ: 'DJ音乐',
  翻唱: '翻唱音乐',
}

/** 分类标签词的来源方式 / 属性等类型见 utils/biliRegionFilter（纯函数单测共用） */
export const REGION_TAG_SOURCES: RegionTagSource[] = ['search', 'btag', 'both']
export const REGION_SOURCE_LABEL: Record<RegionTagSource, string> = {
  search: '搜索',
  btag: '标签',
  both: '全部',
}

export const REGION_TAG_ROLES: RegionTagRole[] = ['aggregate', 'require']
export const REGION_ROLE_LABEL: Record<RegionTagRole, string> = {
  aggregate: '聚合',
  require: '限定',
}

/** 种类持久化 key（存储即实际列表，删除内置项持久生效） */
const REGION_TAGS_STORAGE_KEY = 'zviewer-bili-region-tags'

/** 左栏当前选中种类的持久化 key（存种类名；刷新后按名恢复选中态） */
export const SELECTED_REGION_TAG_STORAGE_KEY =
  'zviewer-bili-selected-region-tag'

/** 旧数据的兼容字段：迁移前分区屏蔽词（string[] / 旧 kind=block 规则）→
 *  blockWords（统一补 scope）/ 旧 5-kind 规则 → 两维规则。
 *  blockWords 用 Omit 重声明（否则与 RegionTagEntry 的 BlockWord[] 交叉收窄，
 *  无法兼容旧 string[] 结构） */
type RegionTagEntryLegacy = Omit<RegionTagEntry, 'blockWords'> & {
  source?: string
  /** 更早版本的分区屏蔽词（带 scope 结构，直接沿用） */
  legacyBlockWords?: BlockWord[]
  /** 旧版分区屏蔽词：上一版为 string[]（迁移补 scope=both），更早为 BlockWord[] */
  blockWords?: BlockWord[] | string[]
}

/** 从旧规则数组提取 kind=block 的词（迁移为分类级屏蔽词） */
function extractLegacyBlockWords(rules: unknown): string[] {
  const words: string[] = []
  if (!Array.isArray(rules)) return words
  for (const r of rules) {
    if (
      r != null &&
      typeof r === 'object' &&
      (r as { kind?: string }).kind === 'block' &&
      typeof (r as { word?: unknown }).word === 'string' &&
      (r as { word: string }).word.trim() !== ''
    ) {
      const w = (r as { word: string }).word.trim()
      if (!words.includes(w)) words.push(w)
    }
  }
  return words
}

/** 归一化标签词规则（一词一条：来源方式 + 属性两维；兼容旧 5-kind 结构）。
 *  旧 kind 映射：search/aggregate → 聚合+搜索；btag → 聚合+标签；
 *  require → 限定（来源无意义）；block 由 extractLegacyBlockWords 提取，不进规则 */
function normalizeTagRules(
  rules: unknown,
  fallbackWord: string
): RegionTagRule[] {
  const byWord = new Map<string, RegionTagRule>()
  const push = (word: string, source: RegionTagSource, role: RegionTagRole) => {
    const w = word.trim()
    if (!w) return
    const exist = byWord.get(w)
    if (!exist) {
      byWord.set(w, { word: w, source, role })
      return
    }
    // 同词多条旧规则：限定属性优先（过滤语义强于来源），来源保留首个
    if (role === 'require' || exist.role === 'require') {
      byWord.set(w, { word: w, source: exist.source, role: 'require' })
    }
  }
  if (Array.isArray(rules)) {
    for (const r of rules) {
      if (r == null || typeof r !== 'object') continue
      const rr = r as Partial<RegionTagRule> & { kind?: unknown }
      if (typeof rr.word !== 'string') continue
      if (
        typeof rr.source === 'string' &&
        typeof rr.role === 'string' &&
        REGION_TAG_SOURCES.includes(rr.source as RegionTagSource) &&
        REGION_TAG_ROLES.includes(rr.role as RegionTagRole)
      ) {
        push(rr.word, rr.source as RegionTagSource, rr.role as RegionTagRole)
      } else if (typeof rr.kind === 'string') {
        if (rr.kind === 'search' || rr.kind === 'aggregate') {
          push(rr.word, 'search', 'aggregate')
        } else if (rr.kind === 'btag') {
          push(rr.word, 'btag', 'aggregate')
        } else if (rr.kind === 'require') {
          push(rr.word, 'search', 'require')
        }
      }
    }
  }
  if (byWord.size === 0) push(fallbackWord, 'search', 'aggregate')
  return [...byWord.values()]
}

/** 读取种类列表：存储即实际列表（含删除内置项后的结果，删除持久生效）。
 * 兼容迁移：旧 string[] / {name, source} / {name, blockWords} → tags 规则；
 * 旧默认分类名（无「音乐」后缀）→ 新默认名（保留已有规则），并补入首项「中术」 */
export function loadRegionTags(): RegionTagEntry[] {
  const defaults: RegionTagEntry[] = DEFAULT_REGION_TAGS.map((name) => ({
    name,
    tags: [{ word: name, source: 'search', role: 'aggregate' }],
  }))
  try {
    const raw = localStorage.getItem(REGION_TAGS_STORAGE_KEY)
    if (raw == null) return defaults
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return defaults
    const entries = list
      .map((it): RegionTagEntry | null => {
        if (typeof it === 'string' && it.trim() !== '') {
          return {
            name: it.trim(),
            tags: [{ word: it.trim(), source: 'search', role: 'aggregate' }],
          }
        }
        if (
          it == null ||
          typeof it !== 'object' ||
          typeof (it as RegionTagEntryLegacy).name !== 'string' ||
          (it as RegionTagEntryLegacy).name.trim() === ''
        ) {
          return null
        }
        const legacy = it as RegionTagEntryLegacy
        const name = legacy.name.trim()
        // 分区屏蔽词：BlockWord[]（新）直接沿用；string[]（上一版）迁移补
        // scope=both；旧 kind=block 规则提取的词同样迁移
        const blockWords: BlockWord[] = []
        const pushBlock = (word: string, scope: BlockWordScope = 'both') => {
          const w = word.trim()
          if (w && !blockWords.some((b) => b.word === w)) {
            blockWords.push({ word: w, scope })
          }
        }
        if (Array.isArray(legacy.blockWords)) {
          for (const b of legacy.blockWords) {
            if (typeof b === 'string') pushBlock(b)
            else if (b && typeof b.word === 'string') pushBlock(b.word, b.scope)
          }
        }
        // 新结构：直接用 tags（旧 kind=block 词并入分区屏蔽词）
        if (Array.isArray(legacy.tags)) {
          for (const w of extractLegacyBlockWords(legacy.tags)) pushBlock(w)
          return {
            name,
            tags: normalizeTagRules(legacy.tags, name),
            ...(blockWords.length > 0 ? { blockWords } : {}),
          }
        }
        // 旧结构迁移：search → 搜索；tag → 标签；mixed → 单条「全部」（搜索+标签两源都取）
        const legacySource = legacy.source
        const tags: RegionTagRule[] = [
          {
            word: name,
            source:
              legacySource === 'mixed'
                ? 'both'
                : legacySource === 'tag'
                  ? 'btag'
                  : 'search',
            role: 'aggregate',
          },
        ]
        return {
          name,
          tags: normalizeTagRules(tags, name),
          ...(blockWords.length > 0 ? { blockWords } : {}),
        }
      })
      .filter((t): t is RegionTagEntry => t != null)
    // 迁移：旧默认分类名补「音乐」（保留已有规则，同名搜索词同步更新）；
    // 新默认首项「中术」缺失时补到最前
    const names = new Set(entries.map((e) => e.name))
    const migrated = entries.map((e) => {
      const newName = LEGACY_DEFAULT_RENAME[e.name]
      if (!newName || names.has(newName)) return e
      return {
        ...e,
        name: newName,
        tags: e.tags?.map((r) =>
          r.source === 'search' && r.word === e.name
            ? { ...r, word: newName }
            : r
        ),
      }
    })
    if (!migrated.some((e) => e.name === '中术')) {
      migrated.unshift({
        name: translate('中术'),
        tags: [
          { word: translate('中术'), source: 'search', role: 'aggregate' },
        ],
      })
    }
    return migrated
  } catch {
    return defaults
  }
}

export function saveRegionTags(tags: RegionTagEntry[]) {
  try {
    localStorage.setItem(REGION_TAGS_STORAGE_KEY, JSON.stringify(tags))
  } catch {
    // ignore（隐私模式等存储不可用场景）
  }
}

/** 自定义栏目（顶栏 tab）：通过 B站 链接添加的视频合集 / 系列 / 收藏夹，
 *  localStorage 持久化；kind 由后端 link-meta 解析确定 */
export interface CustomBiliTab {
  /** 稳定 id：`${kind}:${listId}`（同一列表去重） */
  id: string
  name: string
  kind: BiliCustomKind
  /** UP 主 mid（合集/系列取数需要；收藏夹为 null） */
  mid: number | null
  /** 列表 id：合集/系列为 sid，收藏夹为 fid */
  listId: number
}

const CUSTOM_TABS_STORAGE_KEY = 'zviewer-bili-custom-tabs'
const BILI_CUSTOM_KINDS: readonly BiliCustomKind[] = [
  'season',
  'series',
  'favlist',
]

export function loadCustomTabs(): CustomBiliTab[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TABS_STORAGE_KEY)
    if (raw == null) return []
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return []
    return list
      .map((it): CustomBiliTab | null => {
        if (it == null || typeof it !== 'object') return null
        const t = it as Partial<CustomBiliTab>
        if (
          typeof t.id !== 'string' ||
          t.id === '' ||
          typeof t.name !== 'string' ||
          t.name.trim() === '' ||
          !BILI_CUSTOM_KINDS.includes(t.kind as BiliCustomKind) ||
          typeof t.listId !== 'number' ||
          !Number.isFinite(t.listId) ||
          t.listId <= 0
        ) {
          return null
        }
        return {
          id: t.id,
          name: t.name.trim(),
          kind: t.kind as BiliCustomKind,
          mid:
            typeof t.mid === 'number' && Number.isFinite(t.mid) && t.mid > 0
              ? t.mid
              : null,
          listId: t.listId,
        }
      })
      .filter((t): t is CustomBiliTab => t != null)
  } catch {
    return []
  }
}

export function saveCustomTabs(tabs: CustomBiliTab[]) {
  try {
    localStorage.setItem(CUSTOM_TABS_STORAGE_KEY, JSON.stringify(tabs))
  } catch {
    // ignore（隐私模式等存储不可用场景）
  }
}

/** 屏蔽词作用范围 / BlockWord 类型见 utils/biliRegionFilter（纯函数单测共用） */
export const BLOCK_WORD_SCOPES: BlockWordScope[] = ['both', 'title', 'tag']
export const SCOPE_LABEL: Record<BlockWordScope, string> = {
  title: '标题',
  tag: '标签',
  both: '全部',
}

/** 屏蔽词持久化：命中屏蔽词的搜索结果不显示。
 * 兼容旧版 string[] 存储（自动迁移为 scope=both） */
const BLOCK_WORDS_STORAGE_KEY = 'zviewer-bili-block-words'

export function loadBlockWords(): BlockWord[] {
  try {
    const raw = localStorage.getItem(BLOCK_WORDS_STORAGE_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    if (!Array.isArray(list)) return []
    return list
      .map((item): BlockWord | null => {
        if (typeof item === 'string' && item.trim() !== '') {
          return { word: item.trim(), scope: 'both' }
        }
        if (
          item != null &&
          typeof item === 'object' &&
          typeof (item as BlockWord).word === 'string' &&
          (item as BlockWord).word.trim() !== '' &&
          BLOCK_WORD_SCOPES.includes((item as BlockWord).scope)
        ) {
          return item as BlockWord
        }
        return null
      })
      .filter((w): w is BlockWord => w != null)
  } catch {
    return []
  }
}

export function saveBlockWords(words: BlockWord[]) {
  try {
    localStorage.setItem(BLOCK_WORDS_STORAGE_KEY, JSON.stringify(words))
  } catch {
    // ignore
  }
}
