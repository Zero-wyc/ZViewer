/**
 * 哔哩哔哩页（一起听顶部导航新入口）。
 *
 * 子页（顶栏 tab，支持通过链接添加自定义栏目）：
 * - 音乐分区：B站 音乐分区（rid=3）榜单视频（ranking/v2，网格卡片）
 * - 我的收藏：当前登录 B站 账号默认收藏夹的视频（未登录/失效时提示登录，
 *   登录复用 MusicAppShell 的 B站 扫码链路——提示文案引导至完整播放器
 *   「添加视频」弹窗完成登录）
 * - 自定义栏目：粘贴 B站 链接添加的视频合集 / 系列 / 收藏夹
 *   （localStorage 持久化，后端 link-meta 解析 + 合集/收藏夹取数路由）
 *
 * 点击视频 → 解析音频（默认 720P 直链 / 设置开启 CLI 后高画质音轨）→
 * 作为本地插播「歌曲」播放（不入房间队列、不同步，见 useListenTogether
 * .playBiliSong）；歌词视图自动改用 B站 AI 字幕，播放页背景使用该视频。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Socket } from 'socket.io-client'
import {
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Dices,
  GripVertical,
  ListMusic,
  ListPlus,
  Loader2,
  MessageCircle,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Tv,
  X,
} from 'lucide-react'
import {
  getBilibiliRegionNew,
  getBilibiliFavVideos,
  getBilibiliFavFolders,
  getBilibiliVideoView,
  searchBilibiliVideos,
  fetchBiliCollectionVideos,
  fetchBiliFavListVideos,
  fetchBiliLinkMeta,
  type BilibiliVideoItem,
  type BilibiliFavFolder,
  type BiliCustomKind,
} from '@/modules/bilibili/bilibiliApi'
import { message } from '@/components/ui/message'
import {
  buildBilibiliImageProxyUrl,
  isBilibiliImageUrl,
} from '@/modules/room/watch-together/resolveSource'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { useQueueAdd } from '../hooks/useQueueAdd'
import { useMusicStore, musicItemKey } from '../store'
import type { MusicQueueItem } from '../types'
import {
  decorateRegionItems,
  filterByBlockWords,
  getRegionRules,
} from '../utils/biliRegionFilter'
import type {
  BlockWord,
  BlockWordScope,
  RegionTagEntry,
  RegionTagRole,
  RegionTagRule,
  RegionTagSource,
} from '../utils/biliRegionFilter'
import { cn } from '@/lib/utils'
import { NcmSearchModal } from '../components/NcmSearchModal'

/** 子页标识（custom = 用户通过链接添加的自定义栏目） */
type BiliTab = 'region' | 'fav' | 'custom'

/** 秒 → mm:ss */
function formatSec(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '--:--'
  const m = Math.floor(total / 60)
  const s = Math.floor(total % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** B站 风格计数：≥1e8 → x.x亿；≥1e4 → x.x万；否则原数 */
function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(n)
}

/** 秒级时间戳 → B站 风格相对日期（x分钟前 / x小时前 / x天前 / M-D） */
function formatDate(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const ms = sec * 1000
  const diff = Date.now() - ms
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < hour) return `${Math.max(1, Math.floor(diff / min))}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`
  const d = new Date(ms)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/** 音乐分区首项（走分区排行榜，非搜索） */
const REGION_TAG_HEADER = '推荐榜单'

/** 搜索可达页数：B站搜索单排序仅 50 页（numResults 封顶 1000），后端
 *  按排序分片扩展（综合/最多点击/最新发布/最多弹幕/最多收藏 各 50 页）；
 *  顶栏搜索与分区种类搜索的总页数下限均提升到该值，与后端
 *  SEARCH_MAX_PAGES 保持一致 */
const SEARCH_MAX_PAGES = 250

// ===== B站 取数页参数（集中在常量区，避免散落的字面量漂移） =====
/** 搜索/合集/收藏夹类接口每页条数（B站 page_size 固定 20） */
const PAGE_SIZE_SEARCH = 20
/** 分区排行榜/最新流/收藏夹视频接口每页条数（B站 固定 24） */
const PAGE_SIZE_REGION = 24
/** B站 音乐分区 rid（getBilibiliRegionNew 的分类 id） */
const BILI_MUSIC_REGION_ID = 3
/** 分区空页跳页补齐的最大取页次数（1 次正常页 + 最多 3 次向后补齐） */
const REGION_HOP_MAX_PAGES = 4
/** 音乐分区默认种类名（创建时分类名默认作为一个「搜索」tag；搜索词不再自动补「音乐」，用户在名称里自行写全） */
const DEFAULT_REGION_TAGS = [
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
const REGION_TAG_SOURCES: RegionTagSource[] = ['search', 'btag', 'both']
const REGION_SOURCE_LABEL: Record<RegionTagSource, string> = {
  search: '搜索',
  btag: '标签',
  both: '全部',
}

const REGION_TAG_ROLES: RegionTagRole[] = ['aggregate', 'require']
const REGION_ROLE_LABEL: Record<RegionTagRole, string> = {
  aggregate: '聚合',
  require: '限定',
}

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

/** 种类持久化 key（存储即实际列表，删除内置项持久生效） */
const REGION_TAGS_STORAGE_KEY = 'zviewer-bili-region-tags'

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
function loadRegionTags(): RegionTagEntry[] {
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
        name: '中术',
        tags: [{ word: '中术', source: 'search', role: 'aggregate' }],
      })
    }
    return migrated
  } catch {
    return defaults
  }
}

function saveRegionTags(tags: RegionTagEntry[]) {
  try {
    localStorage.setItem(REGION_TAGS_STORAGE_KEY, JSON.stringify(tags))
  } catch {
    // ignore（隐私模式等存储不可用场景）
  }
}

/** 自定义栏目（顶栏 tab）：通过 B站 链接添加的视频合集 / 系列 / 收藏夹，
 *  localStorage 持久化；kind 由后端 link-meta 解析确定 */
interface CustomBiliTab {
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

function loadCustomTabs(): CustomBiliTab[] {
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

function saveCustomTabs(tabs: CustomBiliTab[]) {
  try {
    localStorage.setItem(CUSTOM_TABS_STORAGE_KEY, JSON.stringify(tabs))
  } catch {
    // ignore（隐私模式等存储不可用场景）
  }
}

/** 屏蔽词作用范围 / BlockWord 类型见 utils/biliRegionFilter（纯函数单测共用） */
const BLOCK_WORD_SCOPES: BlockWordScope[] = ['both', 'title', 'tag']
const SCOPE_LABEL: Record<BlockWordScope, string> = {
  title: '标题',
  tag: '标签',
  both: '全部',
}

/** 屏蔽词持久化：命中屏蔽词的搜索结果不显示。
 * 兼容旧版 string[] 存储（自动迁移为 scope=both） */
const BLOCK_WORDS_STORAGE_KEY = 'zviewer-bili-block-words'

function loadBlockWords(): BlockWord[] {
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

function saveBlockWords(words: BlockWord[]) {
  try {
    localStorage.setItem(BLOCK_WORDS_STORAGE_KEY, JSON.stringify(words))
  } catch {
    // ignore
  }
}

// ===== 列表页 SWR 缓存：分区/榜单/搜索切换时命中即渲染（秒开） =====

/** 列表页缓存条目：存「套用屏蔽词与封面代理之前」的原始合并结果，
 * 读出时按当前屏蔽词现算，保证修改屏蔽词立即生效 */
interface BiliListCacheEntry {
  items: BilibiliVideoItem[]
  total: number | null
  /** 分区路径：多源中单源最大条数（pageFull 判定用；其余路径同 items.length） */
  maxSourceLen: number
  /** 写入时间（毫秒），判断新鲜度 */
  at: number
}
const BILI_LIST_CACHE_MAX = 48
/** 新鲜判定：新鲜命中直接使用不回源；过期命中先展示旧内容再后台刷新 */
const BILI_LIST_CACHE_FRESH_MS = 5 * 60 * 1000
/** 分区预取数量上限（侧栏顺序前 N 个；逐个间隔避免挤占当前浏览请求） */
const PREFETCH_REGION_TAG_LIMIT = 6
/** 分区预取的逐个间隔（毫秒） */
const PREFETCH_REGION_TAG_STAGGER_MS = 1200
const biliListCache = new Map<string, BiliListCacheEntry>()

function biliListCacheSet(key: string, entry: BiliListCacheEntry): void {
  biliListCache.delete(key)
  biliListCache.set(key, entry)
  while (biliListCache.size > BILI_LIST_CACHE_MAX) {
    const oldest = biliListCache.keys().next().value
    if (oldest === undefined) break
    biliListCache.delete(oldest)
  }
}

/** 缓存 key 构造（分区种类/推荐榜单/顶栏搜索三类；fav 个人收藏不缓存） */
const biliKwCacheKey = (keyword: string, pn: number) => `kw:${keyword}|${pn}`
const biliRankCacheKey = (pn: number) => `rank:3|v2|${pn}`
const biliRtCacheKey = (tag: RegionTagEntry, pn: number) =>
  `rt:v2|${tag.name}|${JSON.stringify(tag.tags ?? null)}|${pn}`

/** 分区条目单页取数：聚合词按来源并行搜索/标签检索，bvid 去重合并
 * （加载与预取共用；预取经后端缓存预热，切换分区时前端直接命中） */
async function fetchRegionTagPage(
  tag: RegionTagEntry,
  pageNo: number
): Promise<{
  merged: BilibiliVideoItem[]
  total: number | null
  maxSourceLen: number
}> {
  const aggRules = getRegionRules(tag).filter((r) => r.role === 'aggregate')
  const searchWords = aggRules
    .filter((r) => r.source !== 'btag')
    .map((r) => r.word)
  const btagWords = aggRules
    .filter((r) => r.source !== 'search')
    .map((r) => r.word)
  const results = await Promise.allSettled([
    ...searchWords.map((w) => searchBilibiliVideos(w, pageNo, 'search')),
    ...btagWords.map((w) => searchBilibiliVideos(w, pageNo, 'tag')),
  ])
  const merged: BilibiliVideoItem[] = []
  const seen = new Set<string>()
  let maxSourceLen = 0
  let total: number | null = null
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    maxSourceLen = Math.max(maxSourceLen, r.value.items.length)
    if (total == null) total = r.value.total
    for (const it of r.value.items) {
      if (!seen.has(it.bvid)) {
        seen.add(it.bvid)
        merged.push(it)
      }
    }
  }
  return { merged, total, maxSourceLen }
}

/** 右下角液态玻璃圆形按钮：统一 44px（触屏友好）；材质与交互态在
 *  index.css 的 .bili-liquid-btn（顶部受光渐变 + 边缘高光 + saturate
 *  折射感，hover 上浮、按压弹性回缩），颜色走主题玻璃变量自适应深浅色 */
function LiquidGlassButton({
  title,
  ariaLabel,
  disabled,
  onClick,
  children,
}: {
  title: string
  ariaLabel: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className="bili-liquid-btn lt-blur-surface flex h-11 w-11 items-center justify-center rounded-full"
    >
      {children}
    </button>
  )
}

/** 添加栏目弹窗（黑底 SETTING 风格）：粘贴 B站 链接解析视频合集/系列/收藏夹，
 *  名称留空自动使用 B站 侧标题；提交经后端 link-meta 校验
 *  （链接无法识别 / 收藏夹私密等错误原样提示） */
function AddCustomTabModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  /** 提交解析；返回错误消息（成功返回空串） */
  onSubmit: (link: string, name: string) => Promise<string>
}) {
  const [link, setLink] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 面板展开动画是否已结束（内容延后挂载，动画期间零渲染） */
  const [unfoldDone, setUnfoldDone] = useState(false)

  const submit = useCallback(async () => {
    if (submitting) return
    if (!link.trim()) {
      setError('请粘贴 B站 链接')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const err = await onSubmit(link.trim(), name)
      if (err) {
        setError(err)
        setSubmitting(false)
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析链接失败')
      setSubmitting(false)
    }
  }, [submitting, link, name, onSubmit, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  return (
    <>
      <button
        type="button"
        aria-label="关闭添加栏目"
        className="fixed inset-0 z-[74] cursor-default bg-black/40"
        onClick={() => {
          if (!submitting) onClose()
        }}
      />
      <div
        className="fixed left-1/2 top-1/2 z-[75] flex w-[min(380px,calc(100vw-32px))] flex-col overflow-hidden"
        style={
          {
            transform: 'translate(-50%, -50%)',
            '--add-panel-w': 'min(380px, calc(100vw - 32px))',
            '--add-panel-h': 'min(360px, calc(100vh - 120px))',
            animation: 'cloud-add-in 0.4s 0.1s both',
            backgroundColor: 'rgba(8, 8, 8, 0.86)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '0.5px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)',
          } as React.CSSProperties
        }
        onAnimationEnd={(e) => {
          if (
            e.target === e.currentTarget &&
            e.animationName === 'cloud-add-in'
          ) {
            setUnfoldDone(true)
          }
        }}
      >
        {/* 四角白色方块点缀 */}
        <span
          aria-hidden="true"
          className="absolute left-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 left-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 z-[2] h-2 w-2 bg-white"
        />
        {/* 标题行：超大 ADD 水印 */}
        <div
          className="relative shrink-0 border-b border-white/70 px-5 pb-3 pt-4"
          style={{ animation: 'cloud-add-title-in 0.2s 0.3s both' }}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
          >
            ADD
          </span>
          <p className="relative text-center text-[17px] font-bold text-white">
            添加栏目
          </p>
        </div>
        {unfoldDone && (
          <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {/* 说明 */}
            <p className="mb-3 text-[13px] font-medium leading-relaxed text-white/50">
              粘贴 B站 链接添加顶栏栏目：视频合集 / 系列 （
              {'space.bilibili.com/{mid}/lists/{sid}'} 或旧版 channel
              链接）、收藏夹（{'…/favlist?fid=…'}）；b23.tv 短链自动展开。
            </p>
            {/* 链接输入 */}
            <div className="mb-2">
              <input
                autoFocus
                value={link}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
                placeholder="粘贴 B站 链接"
                className="h-8 w-full rounded-full px-3 text-sm font-bold outline-none"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: '#ffffff',
                  border: '0.5px solid rgba(255, 255, 255, 0.25)',
                }}
              />
            </div>
            {/* 名称输入（留空用 B站 侧标题） */}
            <div className="mb-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
                placeholder="栏目名称（留空自动使用 B站 标题）"
                className="h-8 w-full rounded-full px-3 text-sm font-bold outline-none"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: '#ffffff',
                  border: '0.5px solid rgba(255, 255, 255, 0.25)',
                }}
              />
            </div>
            {error && (
              <p
                className="mb-2 text-[13px] font-bold leading-relaxed"
                style={{ color: '#ff8a8a' }}
              >
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full px-3 py-1.5 text-sm font-bold text-white/70 transition-colors hover:text-white"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting}
                className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-bold transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ backgroundColor: '#ffffff', color: '#000000' }}
              >
                {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                {submitting ? '解析中…' : '添加'}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export function MusicBilibiliPage({
  socket = null,
  roomId,
  canManage = false,
}: {
  /** 队列添加走 socket 广播（music:queue-upsert） */
  socket?: Socket | null
  roomId?: string
  isHost?: boolean
  canManage?: boolean
} = {}) {
  const { playBiliSong, playSong, currentSong, canControl } = useMusicPlayer()
  const currentKey = useMusicStore((s) => s.currentKey)
  const biliRoomId = roomId
  /** 队列添加（封面右下角按钮）：canManage（房主/房管）可用 */
  const { addedKeys, add: addQueueItem } = useQueueAdd(
    socket,
    biliRoomId,
    canManage
  )
  /** 顶栏搜索框关键词（哔哩哔哩页时搜索 B站 视频；null = 常规 tab 内容） */
  const biliSearchKeyword = useMusicStore((s) => s.biliSearchKeyword)
  const setBiliSearchKeyword = useMusicStore((s) => s.setBiliSearchKeyword)

  const [tab, setTab] = useState<BiliTab>('region')
  const [items, setItems] = useState<BilibiliVideoItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 正在解析点击视频（防重复点击） */
  const [playingBvid, setPlayingBvid] = useState<string | null>(null)
  /** 我的收藏：收藏夹列表与当前选中（右列切换；null = 后端默认收藏夹） */
  const [folders, setFolders] = useState<BilibiliFavFolder[]>([])
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null)
  /** 收藏夹列表只拉一次（避免每次切回 fav tab 重复请求） */
  const [foldersLoaded, setFoldersLoaded] = useState(false)
  /** 列表分页（1 起）：滑到列表底部出现上一页/下一页 */
  const [pageNo, setPageNo] = useState(1)
  /** 当前数据源总数（null = 未知，按页满估算是否有下一页） */
  const [total, setTotal] = useState<number | null>(null)
  /** 多 tag 合并模式下任一数据源是否满页（total 未知时的翻页依据） */
  const [pageFull, setPageFull] = useState(false)
  /** 右下角悬浮页码的键盘跳页：编辑态与输入值（空串/非法值提交时忽略） */
  const [pageJumpEditing, setPageJumpEditing] = useState(false)
  const [pageJumpValue, setPageJumpValue] = useState('')
  /** 音乐分区：当前选中种类（null = 推荐榜单，走分区排行榜） */
  const [regionTag, setRegionTag] = useState<RegionTagEntry | null>(null)
  /** 音乐种类列表（内置 + 自定义，localStorage 持久化；均可删） */
  const [regionTags, setRegionTags] = useState<RegionTagEntry[]>(loadRegionTags)
  /** 添加种类输入行的展开态与输入值（桌面左栏 / 移动端 chips 共用） */
  const [addingTag, setAddingTag] = useState(false)
  const [newTagInput, setNewTagInput] = useState('')
  /** 分类标签规则设置弹窗：正在编辑的分类名（null = 关闭） */
  const [tagRulesEditName, setTagRulesEditName] = useState<string | null>(null)
  /** 分区限定屏蔽词弹窗：正在编辑的分区名（null = 关闭；入口在左栏分类条目右上角） */
  const [categoryBlockEditName, setCategoryBlockEditName] = useState<
    string | null
  >(null)
  /** 屏蔽词：命中任一词的搜索结果不显示（localStorage 持久化，词级作用范围） */
  const [blockWords, setBlockWords] = useState<BlockWord[]>(loadBlockWords)
  /** 屏蔽词设置弹窗开关与添加输入 */
  const [showBlockWords, setShowBlockWords] = useState(false)
  const [blockWordInput, setBlockWordInput] = useState('')
  /** 自定义栏目（合集/系列/收藏夹，localStorage 持久化）与当前选中 id */
  const [customTabs, setCustomTabs] = useState<CustomBiliTab[]>(loadCustomTabs)
  const [activeCustomTabId, setActiveCustomTabId] = useState<string | null>(
    null
  )
  /** 添加栏目弹窗（粘贴 B站 链接解析） */
  const [showAddCustomTab, setShowAddCustomTab] = useState(false)
  const activeCustomTab =
    customTabs.find((t) => t.id === activeCustomTabId) ?? null
  /** 每页条数（搜索/合集/收藏夹类接口 page_size 固定 20，其余 24） */
  const pageSize =
    biliSearchKeyword ||
    tab === 'custom' ||
    (tab === 'region' && regionTag != null)
      ? PAGE_SIZE_SEARCH
      : PAGE_SIZE_REGION

  /**
   * B站 CDN 封面有 Referer 防盗链（localhost 直连 403），统一走后端
   * proxy-image 代理（一起看弹幕搜索同范式）。入口转换一次，列表与
   * 插播歌曲的当前播放封面（playBiliSong cover）一并生效。
   */
  const withCoverProxy = useCallback(
    (list: BilibiliVideoItem[]): BilibiliVideoItem[] =>
      list.map((it) => ({
        ...it,
        pic:
          it.pic && isBilibiliImageUrl(it.pic)
            ? buildBilibiliImageProxyUrl(it.pic)
            : it.pic,
      })),
    []
  )

  /** 加载序号：快速切换分区/翻页时丢弃过期响应，防止旧结果覆盖新状态 */
  const loadSeqRef = useRef(0)

  const load = useCallback(
    async (target: BiliTab, folderId?: number | null) => {
      setError(null)
      const seq = ++loadSeqRef.current
      // ===== 缓存 key 与「原始条目 → 展示条目」管线（fav 不缓存） =====
      let cacheKey: string | null = null
      let applyEntries: (
        raw: BilibiliVideoItem[],
        total: number | null,
        maxSourceLen: number
      ) => void = () => {}
      if (biliSearchKeyword) {
        cacheKey = biliKwCacheKey(biliSearchKeyword, pageNo)
        applyEntries = (raw, total) => {
          setItems(withCoverProxy(filterByBlockWords(raw, blockWords)))
          setTotal(total)
        }
      } else if (target === 'region') {
        // 分区路径的条目在取数阶段已完成屏蔽词过滤与装饰（见下方跳页
        // 补齐循环），缓存与展示直接使用
        if (regionTag) {
          cacheKey = biliRtCacheKey(regionTag, pageNo)
          applyEntries = (raw, total, maxSourceLen) => {
            setPageFull(maxSourceLen >= PAGE_SIZE_SEARCH)
            setItems(withCoverProxy(raw))
            setTotal(total)
          }
        } else {
          cacheKey = biliRankCacheKey(pageNo)
          applyEntries = (raw, total) => {
            setItems(withCoverProxy(raw))
            setTotal(total)
          }
        }
      } else if (target === 'custom' && activeCustomTab) {
        cacheKey = `custom:${activeCustomTab.id}|${pageNo}`
        applyEntries = (raw, total) => {
          setItems(withCoverProxy(filterByBlockWords(raw, blockWords)))
          setTotal(total)
        }
      }
      // ===== SWR 快路径：命中缓存立即渲染；过期条目随后台刷新 =====
      let showedCache = false
      const cached = cacheKey ? biliListCache.get(cacheKey) : null
      if (cached) {
        applyEntries(cached.items, cached.total, cached.maxSourceLen)
        setLoading(false)
        showedCache = true
        // 新鲜缓存直接返回（切换分区秒开）；过期缓存继续回源刷新
        if (Date.now() - cached.at < BILI_LIST_CACHE_FRESH_MS) return
      } else {
        setLoading(true)
      }
      try {
        // 顶栏搜索优先：有搜索关键词时列表显示 B站 视频搜索结果
        if (biliSearchKeyword) {
          const r = await searchBilibiliVideos(biliSearchKeyword, pageNo)
          if (seq !== loadSeqRef.current) return
          if (r.items.length > 0) {
            biliListCacheSet(biliKwCacheKey(biliSearchKeyword, pageNo), {
              items: r.items,
              total: r.total,
              maxSourceLen: r.items.length,
              at: Date.now(),
            })
          }
          applyEntries(r.items, r.total, r.items.length)
        } else if (target === 'region') {
          // 屏蔽词过滤发生在取数之后：分区最新流按时间排列，某段时间的
          // 投稿若全部命中屏蔽词（合集/盘点/歌单等），对应页会整页为空。
          // 这里过滤后为空时自动向后跳页补齐（最多再取 3 页），直到本页
          // 有视频或确认后续也没有；跳页合并结果缓存为当前页。
          const decorate = (raw: BilibiliVideoItem[]) =>
            regionTag
              ? decorateRegionItems(raw, regionTag, blockWords)
              : filterByBlockWords(raw, blockWords)
          const collected: BilibiliVideoItem[] = []
          let pn = pageNo
          let total: number | null = null
          let maxSourceLen = 0
          let hasMore = true
          for (let hop = 0; hop < REGION_HOP_MAX_PAGES && hasMore; hop++) {
            if (regionTag) {
              const r = await fetchRegionTagPage(regionTag, pn)
              if (seq !== loadSeqRef.current) return
              maxSourceLen = Math.max(maxSourceLen, r.maxSourceLen)
              total = r.total ?? total
              collected.push(...decorate(r.merged))
              hasMore =
                collected.length === 0 && r.maxSourceLen >= PAGE_SIZE_SEARCH
            } else {
              const r = await getBilibiliRegionNew(
                BILI_MUSIC_REGION_ID,
                PAGE_SIZE_REGION,
                pn
              )
              if (seq !== loadSeqRef.current) return
              total = r.total ?? total
              collected.push(...decorate(r.items))
              hasMore =
                collected.length === 0 && r.items.length >= PAGE_SIZE_REGION
            }
            pn += 1
          }
          if (seq !== loadSeqRef.current) return
          if (collected.length > 0) {
            biliListCacheSet(cacheKey!, {
              items: collected,
              total,
              maxSourceLen,
              at: Date.now(),
            })
          }
          setPageFull(maxSourceLen >= PAGE_SIZE_SEARCH)
          applyEntries(collected, total, maxSourceLen)
        } else if (target === 'custom') {
          if (activeCustomTab) {
            const r =
              activeCustomTab.kind === 'favlist'
                ? await fetchBiliFavListVideos(activeCustomTab.listId, pageNo)
                : await fetchBiliCollectionVideos(
                    activeCustomTab.mid ?? 0,
                    activeCustomTab.listId,
                    activeCustomTab.kind,
                    pageNo
                  )
            if (seq !== loadSeqRef.current) return
            if (r.items.length > 0) {
              biliListCacheSet(`custom:${activeCustomTab.id}|${pageNo}`, {
                items: r.items,
                total: r.total,
                maxSourceLen: r.items.length,
                at: Date.now(),
              })
            }
            applyEntries(r.items, r.total, r.items.length)
          } else {
            // 栏目被删除后仍停在 custom tab：清空展示
            setItems([])
            setTotal(null)
          }
        } else {
          const fav = await getBilibiliFavVideos(
            PAGE_SIZE_REGION,
            folderId ?? undefined,
            pageNo
          )
          if (seq !== loadSeqRef.current) return
          setItems(withCoverProxy(fav.items))
          setTotal(fav.total)
        }
      } catch (err) {
        if (seq !== loadSeqRef.current) return
        // 已展示缓存内容时后台刷新失败：保留旧内容不打断
        if (!showedCache) {
          setItems([])
          setError(err instanceof Error ? err.message : '获取视频列表失败')
        }
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false)
        }
      }
    },
    [
      withCoverProxy,
      biliSearchKeyword,
      pageNo,
      regionTag,
      blockWords,
      activeCustomTab,
    ]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load 内的 loading 置位与请求同步发起（与 MusicSearchPage 同范式）
    void load(tab, activeFolderId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeFolderId 由点击收藏夹时显式触发 load，不随其自动刷新
  }, [tab, load])

  // ===== 分区预取：进入哔哩哔哩页后台预热各分类首页（侧栏前 N 个、逐个
  // 间隔、已有新鲜缓存的跳过），首次切换分类也能命中缓存秒开 =====
  const prefetchSeqRef = useRef(0)
  useEffect(() => {
    if (tab !== 'region' || biliSearchKeyword) return
    const seq = ++prefetchSeqRef.current
    void (async () => {
      for (const tag of regionTags.slice(0, PREFETCH_REGION_TAG_LIMIT)) {
        if (seq !== prefetchSeqRef.current) return
        const key = biliRtCacheKey(tag, 1)
        const cached = biliListCache.get(key)
        if (cached && Date.now() - cached.at < BILI_LIST_CACHE_FRESH_MS) {
          continue
        }
        try {
          const { merged, total, maxSourceLen } = await fetchRegionTagPage(
            tag,
            1
          )
          if (seq !== prefetchSeqRef.current) return
          if (merged.length > 0) {
            biliListCacheSet(key, {
              items: merged,
              total,
              maxSourceLen,
              at: Date.now(),
            })
          }
        } catch {
          // 预取失败静默：用户真正切换该分类时按正常加载重试
        }
        await new Promise((resolve) =>
          setTimeout(resolve, PREFETCH_REGION_TAG_STAGGER_MS)
        )
        if (seq !== prefetchSeqRef.current) return
      }
    })()
  }, [tab, biliSearchKeyword, regionTags])

  // 搜索词变化（顶栏写入新词/清除）时回到第一页
  //（render 期调整，替代 effect 内 setState，与 prevSongId 同范式）
  const [prevSearchKeyword, setPrevSearchKeyword] = useState(biliSearchKeyword)
  if (prevSearchKeyword !== biliSearchKeyword) {
    setPrevSearchKeyword(biliSearchKeyword)
    setPageNo(1)
  }

  // 音乐种类切换（名称或规则变化）时回到第一页（render 期调整，同上范式）
  const [prevRegionTag, setPrevRegionTag] = useState(regionTag)
  if (
    prevRegionTag?.name !== regionTag?.name ||
    JSON.stringify(prevRegionTag?.tags) !== JSON.stringify(regionTag?.tags)
  ) {
    setPrevRegionTag(regionTag)
    setPageNo(1)
  }

  // 我的收藏：首次进入拉收藏夹列表（右列），默认选中第一个（后端默认收藏夹）
  useEffect(() => {
    if (tab !== 'fav' || foldersLoaded) return
    let cancelled = false
    const run = async () => {
      try {
        const list = await getBilibiliFavFolders()
        if (cancelled) return
        // 封面同样过防盗链代理（与列表封面同款；空 cover 交给图标兜底）
        setFolders(
          list.map((f) => ({
            ...f,
            cover:
              f.cover && isBilibiliImageUrl(f.cover)
                ? buildBilibiliImageProxyUrl(f.cover)
                : f.cover,
          }))
        )
        setActiveFolderId(list[0]?.id ?? null)
      } catch {
        // 静默：收藏夹列失败不阻塞默认列表展示
      } finally {
        if (!cancelled) setFoldersLoaded(true)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [tab, foldersLoaded])

  /** 切换收藏夹：更新选中并重载视频列表（回到第一页） */
  const handleSelectFolder = useCallback(
    (f: BilibiliFavFolder) => {
      if (f.id === activeFolderId) return
      setActiveFolderId(f.id)
      setPageNo(1)
      void load('fav', f.id)
    },
    [activeFolderId, load]
  )

  /** ===== 栏目编辑模式：拖动自定义栏目 chip 调整排序（桌面 HTML5 拖拽，
   *  移动端触屏不支持 DnD，显示左右箭头兜底）。内置 tab（音乐分区/
   *  我的收藏）固定在最前不参与排序；排序即时持久化 localStorage ===== */
  const [tabEditMode, setTabEditMode] = useState(false)
  /** 拖拽源在 customTabs 中的下标（ref 避免高频 dragover 重渲染依赖） */
  const dragTabIndexRef = useRef<number | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropTargetTabId, setDropTargetTabId] = useState<string | null>(null)

  /** 把 customTabs[from] 移动到 to 位置并持久化 */
  const handleMoveCustomTab = useCallback((from: number, to: number) => {
    setCustomTabs((prev) => {
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= prev.length ||
        to >= prev.length
      ) {
        return prev
      }
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      saveCustomTabs(next)
      return next
    })
  }, [])

  const handleCustomTabDragStart = useCallback(
    (index: number, id: string, e: React.DragEvent) => {
      dragTabIndexRef.current = index
      setDraggingTabId(id)
      e.dataTransfer.effectAllowed = 'move'
      // Firefox 需要 setData 才会启动拖拽
      e.dataTransfer.setData('text/plain', id)
    },
    []
  )

  const handleCustomTabDragOver = useCallback(
    (index: number, id: string, e: React.DragEvent) => {
      if (dragTabIndexRef.current === null || dragTabIndexRef.current === index)
        return
      // 允许 drop；悬停目标高亮指示插入位置
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTargetTabId((prev) => (prev === id ? prev : id))
    },
    []
  )

  const handleCustomTabDrop = useCallback(
    (index: number, e: React.DragEvent) => {
      e.preventDefault()
      const from = dragTabIndexRef.current
      if (from !== null && from !== index) {
        handleMoveCustomTab(from, index)
      }
      dragTabIndexRef.current = null
      setDraggingTabId(null)
      setDropTargetTabId(null)
    },
    [handleMoveCustomTab]
  )

  const handleCustomTabDragEnd = useCallback(() => {
    dragTabIndexRef.current = null
    setDraggingTabId(null)
    setDropTargetTabId(null)
  }, [])

  /** 删除自定义栏目并清理其列表缓存；删除当前选中项时回到音乐分区 */
  const handleDeleteCustomTab = useCallback(
    (id: string) => {
      setCustomTabs((prev) => {
        const next = prev.filter((t) => t.id !== id)
        saveCustomTabs(next)
        // 编辑模式依赖"至少 2 个栏目可排序"，不足时自动退出
        if (next.length < 2) setTabEditMode(false)
        return next
      })
      for (const key of [...biliListCache.keys()]) {
        if (key.startsWith(`custom:${id}|`)) biliListCache.delete(key)
      }
      if (activeCustomTabId === id) {
        setActiveCustomTabId(null)
        if (tab === 'custom') {
          setTab('region')
          setPageNo(1)
          if (biliSearchKeyword) setBiliSearchKeyword(null)
        }
      }
    },
    [activeCustomTabId, tab, biliSearchKeyword, setBiliSearchKeyword]
  )

  /** 提交添加栏目：后端解析链接（合集/系列/收藏夹 + b23.tv 短链）→
   *  名称留空用 B站 侧标题 → 去重持久化并立即选中。
   *  返回错误消息（成功返回空串） */
  const handleAddCustomTabSubmit = useCallback(
    async (link: string, name: string): Promise<string> => {
      const meta = await fetchBiliLinkMeta(link)
      const id = `${meta.kind}:${meta.listId}`
      if (customTabs.some((t) => t.id === id)) {
        return '该栏目已存在'
      }
      const finalName = (name.trim() || meta.title || '新栏目').trim()
      const next = [
        ...customTabs,
        {
          id,
          name: finalName,
          kind: meta.kind,
          mid: meta.mid,
          listId: meta.listId,
        },
      ]
      setCustomTabs(next)
      saveCustomTabs(next)
      setActiveCustomTabId(id)
      setTab('custom')
      setPageNo(1)
      if (biliSearchKeyword) setBiliSearchKeyword(null)
      return ''
    },
    [customTabs, biliSearchKeyword, setBiliSearchKeyword]
  )

  /** 新增自定义音乐种类：去重后持久化并立即选中（分类名默认为一个搜索 tag） */
  const handleAddTag = useCallback(() => {
    const name = newTagInput.trim()
    if (!name) return
    setRegionTags((prev) => {
      if (prev.some((t) => t.name === name)) return prev
      const next = [
        ...prev,
        {
          name,
          tags: [
            {
              word: name,
              source: 'search' as RegionTagSource,
              role: 'aggregate' as RegionTagRole,
            },
          ],
        },
      ]
      saveRegionTags(next)
      return next
    })
    setRegionTag({
      name,
      tags: [{ word: name, source: 'search', role: 'aggregate' }],
    })
    setNewTagInput('')
    setAddingTag(false)
  }, [newTagInput])

  /** 删除音乐种类；删除当前选中项时回推荐榜单 */
  const handleRemoveTag = useCallback(
    (name: string) => {
      setRegionTags((prev) => {
        const next = prev.filter((t) => t.name !== name)
        saveRegionTags(next)
        return next
      })
      if (regionTag?.name === name) setRegionTag(null)
    },
    [regionTag]
  )

  // ===== 分类标签词规则（多 tag 筛选）设置 =====
  const updateTagRules = useCallback(
    (name: string, updater: (prev: RegionTagRule[]) => RegionTagRule[]) => {
      setRegionTags((prev) => {
        const next = prev.map((t) =>
          t.name === name ? { ...t, tags: updater(t.tags ?? []) } : t
        )
        saveRegionTags(next)
        return next
      })
    },
    []
  )

  const handleAddTagRule = useCallback(() => {
    const parts = blockWordInput
      .split(/[,，\s]+/)
      .map((w) => w.trim())
      .filter(Boolean)
    if (parts.length === 0 || tagRulesEditName == null) return
    updateTagRules(tagRulesEditName, (prev) => {
      const next = [...prev]
      for (const p of parts) {
        if (!next.some((r) => r.word === p)) {
          next.push({ word: p, source: 'search', role: 'aggregate' })
        }
      }
      return next
    })
    setBlockWordInput('')
  }, [blockWordInput, tagRulesEditName, updateTagRules])

  const handleRemoveTagRule = useCallback(
    (word: string) => {
      if (tagRulesEditName == null) return
      updateTagRules(tagRulesEditName, (prev) =>
        prev.filter((r) => r.word !== word)
      )
    },
    [tagRulesEditName, updateTagRules]
  )

  /** 切换标签词属性：聚合 ↔ 限定（限定词按视频 tag 匹配，与来源方式无关） */
  const handleToggleTagRuleRole = useCallback(
    (word: string) => {
      if (tagRulesEditName == null) return
      updateTagRules(tagRulesEditName, (prev) =>
        prev.map((r) =>
          r.word === word
            ? {
                ...r,
                role: REGION_TAG_ROLES[
                  (REGION_TAG_ROLES.indexOf(r.role) + 1) %
                    REGION_TAG_ROLES.length
                ],
              }
            : r
        )
      )
    },
    [tagRulesEditName, updateTagRules]
  )

  /** 切换标签词来源方式：搜索 → 标签 → 全部 → 搜索（仅聚合属性生效） */
  const handleToggleTagRuleSource = useCallback(
    (word: string) => {
      if (tagRulesEditName == null) return
      updateTagRules(tagRulesEditName, (prev) =>
        prev.map((r) =>
          r.word === word
            ? {
                ...r,
                source:
                  REGION_TAG_SOURCES[
                    (REGION_TAG_SOURCES.indexOf(r.source) + 1) %
                      REGION_TAG_SOURCES.length
                  ],
              }
            : r
        )
      )
    },
    [tagRulesEditName, updateTagRules]
  )

  // ===== 分区限定屏蔽词（左栏分类条目右上角入口；仅该分区列表生效，
  // 独立于全局屏蔽词与 tag 规则；词级作用范围与全局屏蔽词同语义） =====
  const updateCategoryBlockWords = useCallback(
    (name: string, updater: (prev: BlockWord[]) => BlockWord[]) => {
      setRegionTags((prev) => {
        const next = prev.map((t) =>
          t.name === name
            ? { ...t, blockWords: updater(t.blockWords ?? []) }
            : t
        )
        saveRegionTags(next)
        return next
      })
    },
    []
  )

  const handleAddCategoryBlockWord = useCallback(() => {
    const parts = blockWordInput
      .split(/[,，\s]+/)
      .map((w) => w.trim())
      .filter(Boolean)
    if (parts.length === 0 || categoryBlockEditName == null) return
    updateCategoryBlockWords(categoryBlockEditName, (prev) => {
      const next = [...prev]
      for (const p of parts) {
        if (!next.some((b) => b.word === p))
          next.push({ word: p, scope: 'both' })
      }
      return next
    })
    setBlockWordInput('')
  }, [blockWordInput, categoryBlockEditName, updateCategoryBlockWords])

  const handleRemoveCategoryBlockWord = useCallback(
    (word: string) => {
      if (categoryBlockEditName == null) return
      updateCategoryBlockWords(categoryBlockEditName, (prev) =>
        prev.filter((b) => b.word !== word)
      )
    },
    [categoryBlockEditName, updateCategoryBlockWords]
  )

  /** 切换分区屏蔽词作用范围：全部 → 标题 → 标签 → 全部（与全局屏蔽词同语义） */
  const handleToggleCategoryBlockWordScope = useCallback(
    (word: string) => {
      if (categoryBlockEditName == null) return
      updateCategoryBlockWords(categoryBlockEditName, (prev) =>
        prev.map((b) =>
          b.word === word
            ? {
                ...b,
                scope:
                  BLOCK_WORD_SCOPES[
                    (BLOCK_WORD_SCOPES.indexOf(b.scope) + 1) %
                      BLOCK_WORD_SCOPES.length
                  ],
              }
            : b
        )
      )
    },
    [categoryBlockEditName, updateCategoryBlockWords]
  )

  /** 「在网易云搜索」弹窗：非空 = 打开（值为 B站 视频标题，自动提取歌名） */
  const [ncmSearchTitle, setNcmSearchTitle] = useState<string | null>(null)
  /** 封面右下角按钮：把视频加入播放队列（权限在 useQueueAdd 内判断：
   *  canManage 或房间控制自动通过开启；cid 缺失先经 view 补取） */
  const handleAddToQueue = useCallback(
    async (item: BilibiliVideoItem) => {
      const key = `bili:${item.bvid}:${item.cid ?? 0}`
      if (addedKeys.has(key)) {
        message.info('已在播放队列中')
        return
      }
      try {
        let cid = item.cid ?? 0
        if (!cid) {
          const view = await getBilibiliVideoView(item.bvid)
          cid = view.cid
        }
        addQueueItem({
          songId: 0,
          name: item.title,
          artist: item.upName || '哔哩哔哩',
          album: '',
          cover: item.pic,
          durationMs: Math.round((item.duration || 0) * 1000),
          vip: false,
          biliBvid: item.bvid,
          biliCid: cid,
        })
        message.success('已加入播放队列')
      } catch (err) {
        message.error(err instanceof Error ? err.message : '获取视频信息失败')
      }
    },
    [addedKeys, addQueueItem]
  )

  /** 添加屏蔽词：一次可输入多个（逗号/空格分隔），去重持久化，默认作用于全部 */
  const handleAddBlockWord = useCallback(() => {
    const parts = blockWordInput
      .split(/[,，\s]+/)
      .map((w) => w.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    setBlockWords((prev) => {
      const next = [...prev]
      for (const p of parts) {
        if (!next.some((b) => b.word === p))
          next.push({ word: p, scope: 'both' })
      }
      saveBlockWords(next)
      return next
    })
    setBlockWordInput('')
  }, [blockWordInput])

  /** 删除屏蔽词（即时持久化；下次列表刷新生效） */
  const handleRemoveBlockWord = useCallback((word: string) => {
    setBlockWords((prev) => {
      const next = prev.filter((b) => b.word !== word)
      saveBlockWords(next)
      return next
    })
  }, [])

  /** 切换单个屏蔽词的作用范围：全部 → 标题 → 标签 → 全部 */
  const handleToggleBlockWordScope = useCallback((word: string) => {
    setBlockWords((prev) => {
      const next = prev.map((b) =>
        b.word === word
          ? {
              ...b,
              scope:
                BLOCK_WORD_SCOPES[
                  (BLOCK_WORD_SCOPES.indexOf(b.scope) + 1) %
                    BLOCK_WORD_SCOPES.length
                ],
            }
          : b
      )
      saveBlockWords(next)
      return next
    })
  }, [])

  /**
   * 点击视频：收藏列表条目无 cid 时先经 view 接口补取第一 P，
   * 随后解析音频并作为本地插播歌曲播放。
   */
  const handlePlay = useCallback(
    async (item: BilibiliVideoItem) => {
      if (playingBvid) return
      // 未连接房间：回退本地插播（个人试听，不入房间队列）
      if (!socket || !roomId) {
        setPlayingBvid(item.bvid)
        try {
          let cid = item.cid ?? 0
          if (!cid) {
            const view = await getBilibiliVideoView(item.bvid)
            cid = view.cid
          }
          await playBiliSong({
            id: -1,
            roomId: '',
            songId: 0,
            name: item.title,
            artist: item.upName || '哔哩哔哩',
            album: '',
            cover: item.pic,
            durationMs: Math.round((item.duration || 0) * 1000),
            vip: false,
            order: 0,
            addedBy: '',
            biliBvid: item.bvid,
            biliCid: cid,
          })
        } catch (err) {
          message.error(err instanceof Error ? err.message : '视频解析失败')
        } finally {
          setPlayingBvid(null)
        }
        return
      }
      // 房间内点播：插入当前播放的下一首并全房间同步。
      // - 有控制权（房主/房主离线观众）：直接入队 + 立即播放
      // - 房管（无控制权）：直接入队，等队列推进
      // - 观众：走 control-request 申请（control-request addQueue），由房主
      //   按「自动通过」开关决定代理入队或拒绝（回执提示无权限）——观众端
      //   本地不知房主开关状态，不能直连 queue-upsert（后端矩阵会拒绝）
      setPlayingBvid(item.bvid)
      try {
        let cid = item.cid ?? 0
        if (!cid) {
          const view = await getBilibiliVideoView(item.bvid)
          cid = view.cid
        }
        const queueItem: MusicQueueItem = {
          id: -1,
          roomId,
          songId: 0,
          name: item.title,
          artist: item.upName || '哔哩哔哩',
          album: '',
          cover: item.pic,
          durationMs: Math.round((item.duration || 0) * 1000),
          vip: false,
          order: 0,
          addedBy: '',
          biliBvid: item.bvid,
          biliCid: cid,
        }
        // 插到当前播放的下一首（afterCurrent），全房间经 queue-changed 同步；
        // 有控制权 → 立即播放并广播；房管（无控制权）→ 入队等队列推进；
        // 观众 → 走 control-request 申请，由房主按自动通过开关决定
        if (canControl || canManage) {
          const ok = await new Promise<boolean>((resolve) => {
            socket.emit(
              'music:queue-upsert',
              { roomId, item: queueItem, afterCurrent: true },
              (res: { success?: boolean; message?: string }) =>
                resolve(res?.success !== false)
            )
          })
          if (!ok) {
            message.error('添加到播放列表失败')
            return
          }
          if (canControl) {
            playSong(queueItem)
          } else {
            message.success('已加入播放列表')
          }
        } else {
          // 观众：申请添加（无权限时房主端回执拒绝，提示见 control-response）
          socket.emit('music:control-request', {
            roomId,
            action: 'addQueue',
            item: {
              songId: 0,
              name: queueItem.name,
              artist: queueItem.artist,
              album: '',
              cover: queueItem.cover,
              durationMs: queueItem.durationMs,
              vip: false,
              biliBvid: queueItem.biliBvid,
              biliCid: queueItem.biliCid,
            },
            afterCurrent: true,
          })
        }
      } catch (err) {
        message.error(err instanceof Error ? err.message : '视频解析失败')
      } finally {
        setPlayingBvid(null)
      }
    },
    [playingBvid, playBiliSong, socket, roomId, canManage, canControl, playSong]
  )

  /** 分页派生：total 已知时精确算总页数；未知时按「本页拉满」估算下一页 */
  const rawTotalPages =
    total != null ? Math.max(1, Math.ceil(total / pageSize)) : null
  // 搜索模式（顶栏搜索 / 分区种类搜索）：B站搜索 API numResults 封顶
  // 1000（页大小 20 = 50 页），后端按排序分片扩展可达页数（tag 链路深处
  // 页为空时也回退关键词搜索），总页数下限提升到 SEARCH_MAX_PAGES；
  // 推荐榜单（ranking/v2 全量本地切页）与收藏夹的 total 为真实值，不受影响
  const totalPages =
    (biliSearchKeyword || (tab === 'region' && regionTag != null)) &&
    rawTotalPages != null
      ? Math.max(rawTotalPages, SEARCH_MAX_PAGES)
      : rawTotalPages
  const hasNextPage =
    totalPages != null
      ? pageNo < totalPages
      : items.length >= pageSize || pageFull

  /** 右下角页码键盘跳页提交：非法值忽略；total 已知时 clamp 到有效页区间 */
  const commitPageJump = useCallback(() => {
    const v = Math.floor(Number(pageJumpValue))
    if (Number.isFinite(v) && v >= 1) {
      const clamped = totalPages != null ? Math.min(v, totalPages) : v
      if (clamped !== pageNo) setPageNo(clamped)
    }
    setPageJumpEditing(false)
  }, [pageJumpValue, totalPages, pageNo])

  // 右上角屏蔽词预览：全局屏蔽词 + 当前选中分区的独立屏蔽词
  //（切分区随之变化；分区词带 region 标记，展示时加「·分区」后缀）
  const blockPreviewEntries: Array<BlockWord & { region?: boolean }> = [
    ...blockWords,
    ...(tab === 'region' && regionTag
      ? (regionTag.blockWords ?? []).map((b) => ({ ...b, region: true }))
      : []),
  ]

  // 弹窗目标分区条目（render 期派生，替代 JSX 内 IIFE，保持 ref 读取合规）
  const tagRulesEntry =
    tagRulesEditName != null
      ? (regionTags.find((t) => t.name === tagRulesEditName) ?? null)
      : null
  const categoryBlockEntry =
    categoryBlockEditName != null
      ? (regionTags.find((t) => t.name === categoryBlockEditName) ?? null)
      : null

  /** 随机页跳转：total 已知时在 [1, totalPages] 内随机；未知时在
   *  [1, 当前页+100] 内随机（深处空页显示空态可回退）；避开当前页 */
  const handleRandomPage = useCallback(() => {
    const maxPage = totalPages ?? pageNo + 100
    if (maxPage <= 1) return
    let next = pageNo
    while (next === pageNo) {
      next = 1 + Math.floor(Math.random() * maxPage)
    }
    setPageNo(next)
  }, [totalPages, pageNo])

  return (
    <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8 max-md:px-4 max-md:pb-[calc(112px+env(safe-area-inset-bottom))] max-md:pt-4">
      {/* 页头（PageBlockHeader 同范式）+ 子页切换 */}
      <div className="flex items-center">
        <span
          className="mr-1.5 w-[20vw] min-w-[140px] shrink-0 py-px pl-1 text-[12px] font-bold uppercase tracking-widest max-md:w-auto max-md:min-w-0 max-md:pr-2"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            color: 'var(--md-sys-color-surface)',
            whiteSpace: 'nowrap',
          }}
        >
          BILIBILI
        </span>
        <span
          className="h-px flex-1"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 30%, transparent)',
          }}
        />
      </div>
      {/* Tab 行：标题 + 屏蔽词入口固定，栏目区单行横滑（移动端可滑动查看
          超出部分，隐藏滚动条；桌面同排自适应） */}
      <div className="mt-2 flex items-center gap-5 max-md:mt-1.5 max-md:gap-x-3">
        <h3 className="shrink-0 text-2xl font-bold leading-relaxed text-[var(--md-sys-color-on-surface)] max-md:text-xl">
          哔哩哔哩
        </h3>
        <div className="flex min-w-0 flex-1 items-center gap-5 overflow-x-auto max-md:gap-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(
            [
              ['region', '音乐分区'],
              ['fav', '我的收藏'],
            ] as Array<[BiliTab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key)
                // 切子页即退出搜索态并回到第一页
                if (biliSearchKeyword) setBiliSearchKeyword(null)
                setPageNo(1)
              }}
              className={cn(
                'relative shrink-0 pb-0.5 text-lg font-bold transition-colors md:text-xl',
                tab === key
                  ? 'text-[var(--md-sys-color-on-surface)]'
                  : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]'
              )}
            >
              {label}
              {/* 激活下划线（与我的音乐页 Tab 同语言） */}
              <span
                className={cn(
                  'absolute inset-x-0 bottom-0 h-[2px] transition-opacity',
                  tab === key ? 'opacity-100' : 'opacity-0'
                )}
                style={{ backgroundColor: 'var(--md-sys-color-primary)' }}
              />
            </button>
          ))}
          {/* 自定义栏目 tab（链接添加的合集/系列/收藏夹；名称右侧 × 删除，
            删除当前选中项时回到音乐分区） */}
          {customTabs.map((ct, ctIndex) => {
            const kindLabel =
              ct.kind === 'favlist'
                ? '收藏夹'
                : ct.kind === 'season'
                  ? '视频合集'
                  : '系列'
            const active = tab === 'custom' && activeCustomTabId === ct.id
            return (
              <span
                key={ct.id}
                draggable={tabEditMode}
                onDragStart={(e) => handleCustomTabDragStart(ctIndex, ct.id, e)}
                onDragOver={(e) => handleCustomTabDragOver(ctIndex, ct.id, e)}
                onDrop={(e) => handleCustomTabDrop(ctIndex, e)}
                onDragEnd={handleCustomTabDragEnd}
                className={cn(
                  'relative inline-flex shrink-0 items-center gap-1',
                  tabEditMode &&
                    'cursor-grab select-none active:cursor-grabbing',
                  draggingTabId === ct.id && 'opacity-40'
                )}
              >
                {/* 拖放落点指示线（primary 竖条 = 松手后插入到该栏目左侧） */}
                {tabEditMode &&
                  dropTargetTabId === ct.id &&
                  draggingTabId != null &&
                  draggingTabId !== ct.id && (
                    <span
                      className="absolute -left-[5px] top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full"
                      style={{ backgroundColor: 'var(--md-sys-color-primary)' }}
                    />
                  )}
                {/* 拖拽把手（鼠标设备编辑态显示；触屏用右侧箭头） */}
                {tabEditMode && (
                  <GripVertical className="hidden h-3 w-3 shrink-0 text-[var(--md-sys-color-on-surface-variant)] [@media(pointer:fine)]:block" />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setTab('custom')
                    setActiveCustomTabId(ct.id)
                    // 切子页即退出搜索态并回到第一页
                    if (biliSearchKeyword) setBiliSearchKeyword(null)
                    setPageNo(1)
                  }}
                  className={cn(
                    'relative pb-0.5 text-lg font-bold transition-colors md:text-xl max-md:max-w-[110px] max-md:truncate',
                    active
                      ? 'text-[var(--md-sys-color-on-surface)]'
                      : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]'
                  )}
                  title={`${kindLabel}：${ct.name}（点击右侧 × 删除）`}
                >
                  {ct.name}
                  {/* 激活下划线（与内置 tab 同语言） */}
                  <span
                    className={cn(
                      'absolute inset-x-0 bottom-0 h-[2px] transition-opacity',
                      active ? 'opacity-100' : 'opacity-0'
                    )}
                    style={{ backgroundColor: 'var(--md-sys-color-primary)' }}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteCustomTab(ct.id)}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface-variant)] opacity-40 transition-opacity hover:opacity-100"
                  title={`删除栏目「${ct.name}」`}
                  aria-label={`删除栏目 ${ct.name}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
                {/* 触屏排序箭头（编辑态）：HTML5 拖拽在触屏不可用，
                    左右移动一位兜底；鼠标设备隐藏（直接拖把手） */}
                {tabEditMode && (
                  <span className="hidden shrink-0 items-center [@media(pointer:coarse)]:flex">
                    <button
                      type="button"
                      onClick={() => handleMoveCustomTab(ctIndex, ctIndex - 1)}
                      disabled={ctIndex === 0}
                      className="flex h-5 w-4 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] disabled:opacity-25"
                      title="向前移动"
                      aria-label={`向前移动栏目 ${ct.name}`}
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoveCustomTab(ctIndex, ctIndex + 1)}
                      disabled={ctIndex === customTabs.length - 1}
                      className="flex h-5 w-4 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] disabled:opacity-25"
                      title="向后移动"
                      aria-label={`向后移动栏目 ${ct.name}`}
                    >
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </span>
            )
          })}
          {/* 编辑栏目顺序：≥2 个自定义栏目时可用，进入后拖动栏目
              chip（触屏用左右箭头）调整排序，即时持久化 */}
          {customTabs.length >= 2 && (
            <button
              type="button"
              onClick={() => setTabEditMode((v) => !v)}
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors',
                tabEditMode
                  ? 'text-[var(--md-sys-color-primary)]'
                  : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]'
              )}
              title="编辑栏目顺序：拖动栏目调整位置（触屏用箭头）"
              aria-label="编辑栏目顺序"
              aria-pressed={tabEditMode}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </button>
          )}
          {/* 添加栏目：粘贴 B站 链接（视频合集 / 系列 / 收藏夹；b23.tv 短链自动展开） */}
          <button
            type="button"
            onClick={() => setShowAddCustomTab(true)}
            className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:text-[var(--md-sys-color-on-surface)]"
            title="通过链接添加栏目（视频合集 / 系列 / 收藏夹）"
            aria-label="添加栏目"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        {/* 全局屏蔽词入口（tab 行右侧）：左侧预览 = 全局屏蔽词 + 当前选中分区
            的独立屏蔽词（切分区随之变化，分区词带「·分区」标记）；
            按钮弹出全局屏蔽词设置弹窗（配置的词全局生效） */}
        <div className="ml-auto flex items-center gap-2">
          {/* 屏蔽词预览（移动端隐藏：太多字挤爆 Tab 行，悬停标题保留在按钮上） */}
          <span
            className="max-w-[260px] truncate text-[13px] font-bold text-[var(--md-sys-color-on-surface-variant)] max-md:max-w-[140px] max-md:hidden"
            title={
              blockPreviewEntries.length > 0
                ? `屏蔽词：${blockPreviewEntries
                    .map((b) =>
                      b.region
                        ? `${b.word}·分区(${SCOPE_LABEL[b.scope]})`
                        : `${b.word}(${SCOPE_LABEL[b.scope]})`
                    )
                    .join('、')}`
                : '未设置屏蔽词'
            }
          >
            {blockPreviewEntries.length > 0
              ? `屏蔽：${blockPreviewEntries
                  .map((b) => (b.region ? `${b.word}·分区` : b.word))
                  .join('、')}`
              : '未设置屏蔽词'}
          </span>
          <button
            type="button"
            onClick={() => setShowBlockWords(true)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-70 active:scale-90"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
            }}
            title="全局屏蔽词设置"
            aria-label="全局屏蔽词设置"
          >
            <Ban
              className="h-4 w-4"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            />
          </button>
        </div>
      </div>

      {/* 列表区 */}
      <div className="mt-5 flex min-h-[240px] flex-1 flex-col">
        {/* 搜索态提示条（顶栏搜索框在哔哩哔哩页搜索 B站 视频） */}
        {biliSearchKeyword && (
          <div className="mb-3 flex items-center gap-2 px-2">
            <span
              className="flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
              }}
            >
              搜索「{biliSearchKeyword}」
              <button
                type="button"
                onClick={() => {
                  setBiliSearchKeyword(null)
                  setPageNo(1)
                }}
                className="flex h-4 w-4 items-center justify-center rounded-full transition-opacity hover:opacity-70"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 15%, transparent)',
                }}
                title="清除搜索"
                aria-label="清除搜索"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          </div>
        )}
        {/* 左栏（移动 chips + 桌面竖列）在加载中保持显示，仅右侧视频区切换
            加载动画/错误/空态/列表——切换分类时左栏不再闪退 */}
        <div className="flex flex-1 flex-col gap-3 lg:flex-row lg:items-start lg:gap-5">
          {/* 移动端收藏夹切换 chips（桌面用左列） */}
          {tab === 'fav' && folders.length > 0 && (
            <div className="mb-1 flex w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden">
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => handleSelectFolder(f)}
                  className={cn(
                    'shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[15px] font-bold transition-opacity',
                    f.id === activeFolderId
                      ? 'text-[var(--md-sys-color-surface)]'
                      : 'text-[var(--md-sys-color-on-surface)] hover:opacity-70'
                  )}
                  style={{
                    backgroundColor:
                      f.id === activeFolderId
                        ? 'var(--md-sys-color-on-surface)'
                        : 'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                  }}
                >
                  {f.title} · {f.mediaCount}
                </button>
              ))}
            </div>
          )}
          {/* 移动端音乐种类 chips（桌面用左列）：单行横滚 + 隐藏滚动条
              （推荐榜单 + 种类 + 添加；与收藏夹 chips 同交互范式） */}
          {tab === 'region' && (
            <>
              <div className="mb-1 flex w-full gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:hidden">
                {(
                  [
                    [REGION_TAG_HEADER, null],
                    ...regionTags.map((t) => [t.name, t.name]),
                  ] as Array<[string, string | null]>
                ).map(([label, tagName]) => {
                  const entry = tagName
                    ? regionTags.find((t) => t.name === tagName)
                    : null
                  return (
                    <span
                      key={`m-tag-${label}`}
                      className={cn(
                        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full py-1 pl-3 pr-1.5 text-[15px] font-bold transition-opacity',
                        regionTag?.name === tagName
                          ? 'text-[var(--md-sys-color-surface)]'
                          : 'text-[var(--md-sys-color-on-surface)]'
                      )}
                      style={{
                        backgroundColor:
                          regionTag?.name === tagName
                            ? 'var(--md-sys-color-on-surface)'
                            : 'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setRegionTag(entry ? entry : null)}
                        className="transition-opacity hover:opacity-70"
                      >
                        {label}
                      </button>
                      {entry && (
                        <>
                          <button
                            type="button"
                            onClick={() => setTagRulesEditName(entry.name)}
                            className="rounded-full px-1.5 py-0.5 text-[12px] font-bold transition-opacity hover:opacity-70 max-md:px-2 max-md:py-1"
                            style={{
                              backgroundColor:
                                'color-mix(in srgb, var(--md-sys-color-on-surface) 15%, transparent)',
                            }}
                            title="分类标签规则设置"
                            aria-label={`设置分类 ${entry.name} 的标签规则`}
                          >
                            <Settings2 className="h-2.5 w-2.5 max-md:h-3 max-md:w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setCategoryBlockEditName(entry.name)}
                            className="rounded-full px-1.5 py-0.5 text-[12px] font-bold transition-opacity hover:opacity-70 max-md:px-2 max-md:py-1"
                            style={{
                              backgroundColor:
                                'color-mix(in srgb, var(--md-sys-color-on-surface) 15%, transparent)',
                            }}
                            title="分区屏蔽词设置"
                            aria-label={`设置分区 ${entry.name} 的屏蔽词`}
                          >
                            <Ban className="h-2.5 w-2.5 max-md:h-3 max-md:w-3" />
                          </button>
                        </>
                      )}
                    </span>
                  )
                })}
                {!addingTag && (
                  <button
                    type="button"
                    onClick={() => setAddingTag(true)}
                    className="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[15px] font-bold text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 lg:hidden"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                    }}
                    title="添加自定义音乐种类"
                  >
                    + 添加
                  </button>
                )}
              </div>
              {/* 移动端添加种类输入行（共用 addingTag 状态） */}
              {addingTag && (
                <div className="mb-1 flex w-full items-center gap-2 lg:hidden">
                  <input
                    autoFocus
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddTag()
                      else if (e.key === 'Escape') {
                        setAddingTag(false)
                        setNewTagInput('')
                      }
                    }}
                    placeholder="输入音乐种类关键词"
                    className="h-8 min-w-0 flex-1 rounded-full px-3 text-[15px] font-bold outline-none"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                      color: 'var(--md-sys-color-on-surface)',
                      border:
                        '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 25%, transparent)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleAddTag}
                    className="shrink-0 rounded-full px-3 py-1.5 text-[15px] font-bold transition-opacity hover:opacity-70"
                    style={{
                      backgroundColor: 'var(--md-sys-color-on-surface)',
                      color: 'var(--md-sys-color-surface)',
                    }}
                  >
                    添加
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingTag(false)
                      setNewTagInput('')
                    }}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-70"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                    }}
                    title="取消"
                    aria-label="取消添加"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </>
          )}
          {/* 左侧收藏夹竖列（桌面；与我的音乐歌单列同视觉语言，
                用户要求从右侧移到左侧） */}
          {tab === 'fav' && (
            <aside className="hidden w-[220px] shrink-0 flex-col lg:flex">
              <div className="pb-1 text-[14px] font-bold uppercase tracking-widest text-[var(--md-sys-color-on-surface-variant)]">
                收藏夹
              </div>
              <div
                className="h-px w-full"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 35%, transparent)',
                }}
              />
              <div className="zen-scroll mt-1 max-h-[calc(100vh-220px)] overflow-y-auto pb-2">
                {folders.length === 0 ? (
                  <div className="px-2 py-3 text-[15px] text-[var(--md-sys-color-on-surface-variant)]">
                    暂无收藏夹
                  </div>
                ) : (
                  folders.map((f) => (
                    <FavFolderItem
                      key={f.id}
                      name={f.title}
                      info={`${f.mediaCount} 个视频`}
                      cover={f.cover}
                      selected={f.id === activeFolderId}
                      onClick={() => handleSelectFolder(f)}
                    />
                  ))
                )}
              </div>
            </aside>
          )}
          {/* 左侧音乐种类竖列（桌面）：首项推荐榜单走分区排行榜，
                其余种类点击即用 B站 搜索该关键词；底部可添加自定义种类
                （localStorage 持久化，内置种类不可删） */}
          {tab === 'region' && (
            <aside className="hidden w-[220px] shrink-0 flex-col lg:flex">
              <div className="pb-1 text-[14px] font-bold uppercase tracking-widest text-[var(--md-sys-color-on-surface-variant)]">
                音乐分区
              </div>
              <div
                className="h-px w-full"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 35%, transparent)',
                }}
              />
              <div className="zen-scroll mt-1 max-h-[calc(100vh-220px)] overflow-y-auto pb-2">
                <RegionTagItem
                  name={REGION_TAG_HEADER}
                  selected={regionTag === null}
                  onClick={() => setRegionTag(null)}
                />
                {regionTags.map((t) => (
                  <RegionTagItem
                    key={t.name}
                    name={t.name}
                    selected={regionTag?.name === t.name}
                    removable
                    onClick={() => setRegionTag(t)}
                    onOpenRules={() => setTagRulesEditName(t.name)}
                    onOpenBlockWords={() => setCategoryBlockEditName(t.name)}
                    onRemove={() => handleRemoveTag(t.name)}
                  />
                ))}
              </div>
              {/* 添加自定义种类（内联输入行） */}
              {addingTag ? (
                <div className="mt-1 flex items-center gap-1.5 px-2 pb-1">
                  <input
                    autoFocus
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddTag()
                      else if (e.key === 'Escape') {
                        setAddingTag(false)
                        setNewTagInput('')
                      }
                    }}
                    placeholder="输入音乐种类关键词"
                    className="h-8 min-w-0 flex-1 rounded-md px-2 text-[15px] font-bold outline-none"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                      color: 'var(--md-sys-color-on-surface)',
                      border:
                        '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 25%, transparent)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleAddTag}
                    className="shrink-0 rounded-md px-2 py-1 text-[15px] font-bold transition-opacity hover:opacity-70"
                    style={{
                      backgroundColor: 'var(--md-sys-color-on-surface)',
                      color: 'var(--md-sys-color-surface)',
                    }}
                  >
                    添加
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingTag(false)
                      setNewTagInput('')
                    }}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-70"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                    }}
                    title="取消"
                    aria-label="取消添加"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingTag(true)}
                  className="mt-1 flex items-center gap-1.5 px-3 py-2 text-[15px] font-bold text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:text-[var(--md-sys-color-on-surface)]"
                  title="添加自定义音乐种类"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加种类
                </button>
              )}
            </aside>
          )}
          {/* 右侧视频区：加载动画 / 错误 / 空态 / 网格四态切换（左栏常驻） */}
          {loading ? (
            <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 py-12 text-base text-[var(--md-sys-color-on-surface-variant)]">
              <Loader2 className="h-6 w-6 animate-spin" />
              正在获取视频…
            </div>
          ) : error ? (
            <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
              <span className="text-base text-[var(--md-sys-color-on-surface-variant)]">
                {error}
              </span>
              {tab === 'fav' && (
                <span className="text-sm text-[var(--md-sys-color-on-surface-variant)] opacity-70">
                  需登录 B站 账号：可在完整播放器「添加视频」弹窗中扫码登录
                </span>
              )}
              <button
                type="button"
                onClick={() => void load(tab, activeFolderId)}
                className="mt-1 border px-4 py-1 text-sm font-bold text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70"
                style={{ borderColor: 'var(--md-sys-color-outline)' }}
              >
                重试
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex min-w-0 flex-1 items-center justify-center py-12 text-base text-[var(--md-sys-color-on-surface-variant)]">
              {biliSearchKeyword
                ? '没有找到相关视频'
                : tab === 'fav'
                  ? '收藏夹暂无视频'
                  : tab === 'custom'
                    ? '该栏目暂无视频'
                    : tab === 'region' && blockWords.length > 0
                      ? '该区间的视频均被屏蔽词过滤，可调整屏蔽词或稍后再看'
                      : '分区暂无视频'}
            </div>
          ) : (
            <div
              className={cn(
                'grid min-w-0 flex-1 grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 max-md:gap-x-3 max-md:gap-y-5',
                tab === 'fav'
                  ? 'lg:grid-cols-3 xl:grid-cols-4'
                  : 'lg:grid-cols-4 xl:grid-cols-5'
              )}
            >
              {items.map((item) => {
                const key = `bili:${item.bvid}:${item.cid ?? 0}`
                const isCurrent =
                  currentKey === key ||
                  (currentSong != null && musicItemKey(currentSong) === key)
                const busy = playingBvid === item.bvid
                const dateText = formatDate(item.date ?? 0)
                // 卡片整体可点播放。外层必须用 div[role=button]：
                // button 内不允许嵌套 button（浏览器会把内层「加入队列」
                // 按钮拆出 DOM，点击事件错落到卡片播放上）
                return (
                  <div
                    key={item.bvid}
                    role="button"
                    tabIndex={0}
                    onClick={() => void handlePlay(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void handlePlay(item)
                      }
                    }}
                    className="group cursor-pointer text-left"
                    title="以视频音频作为歌曲播放"
                  >
                    {/* 封面（16:9，左上播放量 / 左下弹幕 / 右下时长，B站 客户端同款） */}
                    <div
                      className="relative aspect-video overflow-hidden rounded-lg"
                      style={{
                        backgroundColor:
                          'var(--md-sys-color-surface-container-high)',
                      }}
                    >
                      {item.pic ? (
                        <img
                          src={item.pic}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center">
                          <Tv className="h-6 w-6 opacity-40" />
                        </span>
                      )}
                      {/* 左上：播放量 */}
                      {(item.view ?? 0) > 0 && (
                        <span
                          className="absolute left-2 top-2 flex items-center gap-1 text-[13px] font-medium text-white"
                          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.7)' }}
                        >
                          <Play className="h-3 w-3 fill-white text-white" />
                          {formatCount(item.view ?? 0)}
                        </span>
                      )}
                      {/* 左下：弹幕数 */}
                      {(item.danmaku ?? 0) > 0 && (
                        <span
                          className="absolute bottom-2 left-2 flex items-center gap-1 text-[13px] font-medium text-white"
                          style={{ textShadow: '0 1px 3px rgba(0,0,0,0.7)' }}
                        >
                          <MessageCircle className="h-3 w-3 fill-white text-white" />
                          {formatCount(item.danmaku ?? 0)}
                        </span>
                      )}
                      {/* 右下：时长 + 加入播放队列（canManage 时显示，hover 显形）。
                          z-10：必须垫在下方 hover 遮罩（absolute inset-0，DOM 序靠后）
                          之上，否则遮罩 opacity-0 时也会拦截点击，按钮永远点不到 */}
                      <div className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-1">
                        {/* 在网易云搜索：自动提取歌名在网易云搜索（试听/收藏） */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setNcmSearchTitle(item.title)
                          }}
                          className="lt-touch-visible flex h-[20px] items-center justify-center rounded bg-black/70 px-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                          title="在网易云搜索这首歌"
                          aria-label="在网易云搜索这首歌"
                        >
                          <Search className="h-3 w-3" />
                        </button>
                        {canManage && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleAddToQueue(item)
                            }}
                            className={cn(
                              'lt-touch-visible flex h-[20px] items-center justify-center rounded bg-black/70 px-1 text-white transition-opacity',
                              addedKeys.has(
                                `bili:${item.bvid}:${item.cid ?? 0}`
                              )
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100'
                            )}
                            title={
                              addedKeys.has(
                                `bili:${item.bvid}:${item.cid ?? 0}`
                              )
                                ? '已在播放队列'
                                : '添加到播放队列'
                            }
                            aria-label="添加到播放队列"
                          >
                            <ListPlus className="h-3 w-3" />
                          </button>
                        )}
                        <span className="rounded bg-black/70 px-1 py-px text-[13px] font-medium tabular-nums text-white">
                          {formatSec(item.duration)}
                        </span>
                      </div>
                      {/* hover / 当前播放遮罩 */}
                      <span
                        className={cn(
                          'absolute inset-0 flex items-center justify-center bg-black/35 transition-opacity',
                          isCurrent
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100'
                        )}
                      >
                        {busy ? (
                          <Loader2 className="h-6 w-6 animate-spin text-white" />
                        ) : (
                          <Play className="h-6 w-6 fill-white text-white" />
                        )}
                      </span>
                    </div>
                    {/* 标题（两行截断，当前播放高亮） */}
                    <div
                      className={cn(
                        'mt-2 line-clamp-2 text-[15px] leading-snug max-md:text-sm',
                        isCurrent
                          ? 'text-[var(--md-sys-color-primary)]'
                          : 'text-[var(--md-sys-color-on-surface)]'
                      )}
                      title={item.title}
                    >
                      {item.title}
                    </div>
                    {/* 元信息：UP主 · 日期 */}
                    <div className="mt-1 flex items-center gap-1.5 text-[13px] text-[var(--md-sys-color-on-surface-variant)] max-md:text-[12px]">
                      <span className="truncate">{item.upName}</span>
                      {dateText && (
                        <>
                          <span className="shrink-0 opacity-60">·</span>
                          <span className="shrink-0">{dateText}</span>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 分页条（滑到列表底部可见）：上一页 / 页码 / 下一页。
            total 未知时按「本页拉满 = 可能还有下一页」估算 */}
        {!loading &&
          !error &&
          items.length > 0 &&
          (pageNo > 1 || hasNextPage) && (
            <div className="mt-8 flex items-center justify-center gap-3 pb-2">
              <button
                type="button"
                onClick={() => setPageNo((p) => Math.max(1, p - 1))}
                disabled={pageNo <= 1}
                className="rounded-full px-4 py-1.5 text-sm font-bold transition-opacity hover:opacity-70 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
                style={{
                  border:
                    '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 25%, transparent)',
                  color: 'var(--md-sys-color-on-surface)',
                }}
                title="上一页"
              >
                上一页
              </button>
              <span className="text-sm font-bold tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                第 {pageNo} 页
                {totalPages != null ? ` · 共 ${totalPages} 页` : ''}
              </span>
              <button
                type="button"
                onClick={() => setPageNo((p) => p + 1)}
                disabled={!hasNextPage}
                className="rounded-full px-4 py-1.5 text-sm font-bold transition-opacity hover:opacity-70 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
                style={{
                  border:
                    '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 25%, transparent)',
                  color: 'var(--md-sys-color-on-surface)',
                }}
                title="下一页"
              >
                下一页
              </button>
            </div>
          )}
      </div>

      {/* 右下角悬浮工具组（液态玻璃）：上一页 / 页码（点击可键盘输入页码
          跳转）/ 下一页 / 随机 / 刷新；统一 44px 圆形（bottom 避开底部
          悬浮播放条；分页控件与底部分页条同条件显示） */}
      <div
        className="fixed right-5 z-20 flex flex-col items-center gap-2 max-md:right-4"
        style={{ bottom: 'calc(104px + env(safe-area-inset-bottom))' }}
      >
        {items.length > 0 && (pageNo > 1 || hasNextPage) && (
          <>
            <LiquidGlassButton
              title="上一页"
              ariaLabel="上一页"
              disabled={pageNo <= 1 || loading}
              onClick={() => setPageNo((p) => Math.max(1, p - 1))}
            >
              <ChevronUp className="h-[18px] w-[18px]" />
            </LiquidGlassButton>
            {pageJumpEditing ? (
              <input
                autoFocus
                value={pageJumpValue}
                onChange={(e) =>
                  setPageJumpValue(e.target.value.replace(/[^\d]/g, ''))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitPageJump()
                  else if (e.key === 'Escape') setPageJumpEditing(false)
                }}
                onBlur={() => setPageJumpEditing(false)}
                inputMode="numeric"
                className="bili-liquid-btn lt-blur-surface h-11 w-11 rounded-full text-center text-[13px] font-bold tabular-nums outline-none"
                style={{ border: '1px solid var(--md-sys-color-primary)' }}
                title="输入页码后回车跳转（Esc 取消）"
                aria-label="输入页码跳转"
              />
            ) : (
              <LiquidGlassButton
                title={`当前第 ${pageNo} 页${totalPages != null ? ` / 共 ${totalPages} 页` : ''}；点击输入页码跳转`}
                ariaLabel="跳转到指定页"
                disabled={loading}
                onClick={() => {
                  setPageJumpValue(String(pageNo))
                  setPageJumpEditing(true)
                }}
              >
                {totalPages != null ? (
                  <span className="text-[12px] font-bold tabular-nums leading-none">
                    {pageNo}/{totalPages}
                  </span>
                ) : (
                  <span className="text-sm font-bold tabular-nums leading-none">
                    {pageNo}
                  </span>
                )}
              </LiquidGlassButton>
            )}
            <LiquidGlassButton
              title="下一页"
              ariaLabel="下一页"
              disabled={!hasNextPage || loading}
              onClick={() => setPageNo((p) => p + 1)}
            >
              <ChevronDown className="h-[18px] w-[18px]" />
            </LiquidGlassButton>
            <LiquidGlassButton
              title="随机跳转一页"
              ariaLabel="随机跳转一页"
              disabled={loading}
              onClick={handleRandomPage}
            >
              <Dices className="h-[18px] w-[18px]" />
            </LiquidGlassButton>
          </>
        )}
        <LiquidGlassButton
          title="刷新"
          ariaLabel="刷新列表"
          onClick={() => void load(tab, activeFolderId)}
        >
          <RefreshCw
            className={cn('h-[18px] w-[18px]', loading && 'animate-spin')}
          />
        </LiquidGlassButton>
      </div>

      {/* 添加栏目弹窗：解析 B站 链接（合集/系列/收藏夹）→ 保存自定义栏目并选中 */}
      {showAddCustomTab && (
        <AddCustomTabModal
          onClose={() => setShowAddCustomTab(false)}
          onSubmit={handleAddCustomTabSubmit}
        />
      )}

      {/* 全局屏蔽词设置弹窗（黑底 SETTING 风格；配置的词全局生效，
          即时持久化，作用于搜索/榜单/各分区列表的最终过滤） */}
      {showBlockWords && (
        <BlockWordsModal
          title="全局屏蔽词设置"
          words={blockWords}
          input={blockWordInput}
          onInputChange={setBlockWordInput}
          onAdd={handleAddBlockWord}
          onRemove={handleRemoveBlockWord}
          onToggleScope={handleToggleBlockWordScope}
          onClose={() => {
            setShowBlockWords(false)
            setBlockWordInput('')
            // 屏蔽词可能变化，重载当前列表使过滤立即生效
            void load(tab, activeFolderId)
          }}
        />
      )}

      {/* 分类标签规则弹窗（多 tag 筛选；规则变化经 render 期调整自动重载） */}
      {tagRulesEntry && (
        <TagRulesModal
          title={`「${tagRulesEntry.name}」标签规则`}
          rules={tagRulesEntry.tags ?? []}
          input={blockWordInput}
          onInputChange={setBlockWordInput}
          onAdd={handleAddTagRule}
          onRemove={handleRemoveTagRule}
          onToggleRole={handleToggleTagRuleRole}
          onToggleSource={handleToggleTagRuleSource}
          onClose={() => {
            setTagRulesEditName(null)
            setBlockWordInput('')
            // 编辑的是当前选中分类时，重载列表使规则立即生效
            if (regionTag?.name === tagRulesEntry.name) {
              void load(tab, activeFolderId)
            }
          }}
        />
      )}

      {/* 分区限定屏蔽词弹窗（左栏分类条目右上角入口；词级作用范围
          （标题/标签/全部）与全局屏蔽词同语义，但仅对该分区列表生效；
          改动即时持久化，关闭时重载当前列表） */}
      {categoryBlockEntry && (
        <BlockWordsModal
          title={`「${categoryBlockEntry.name}」屏蔽词`}
          description={`仅对「${categoryBlockEntry.name}」分区的列表生效；点击词上的范围徽标可单独设置匹配标题还是标签`}
          words={categoryBlockEntry.blockWords ?? []}
          input={blockWordInput}
          onInputChange={setBlockWordInput}
          onAdd={handleAddCategoryBlockWord}
          onRemove={handleRemoveCategoryBlockWord}
          onToggleScope={handleToggleCategoryBlockWordScope}
          onClose={() => {
            setCategoryBlockEditName(null)
            setBlockWordInput('')
            // 编辑的是当前选中分类时，重载列表使屏蔽立即生效
            if (regionTag?.name === categoryBlockEntry.name) {
              void load(tab, activeFolderId)
            }
          }}
        />
      )}

      {/* 在网易云搜索弹窗（封面入口：歌名提取搜索 + 试听/收藏到歌单） */}
      <NcmSearchModal
        open={ncmSearchTitle != null}
        sourceTitle={ncmSearchTitle ?? ''}
        onClose={() => setNcmSearchTitle(null)}
      />
    </div>
  )
}

/** 分类标签规则弹窗（多 tag 筛选；黑底 SETTING 风格，复用屏蔽词弹窗骨架）。
 *  每条规则两个独立徽标：属性（聚合/限定）+ 来源方式（搜索/标签/全部，
 *  仅聚合属性生效）；屏蔽词不在本弹窗设置（入口在分类条目右上角），即时持久化 */
function TagRulesModal({
  title,
  rules,
  input,
  onInputChange,
  onAdd,
  onRemove,
  onToggleRole,
  onToggleSource,
  onClose,
}: {
  title: string
  rules: RegionTagRule[]
  input: string
  onInputChange: (v: string) => void
  onAdd: () => void
  onRemove: (word: string) => void
  /** 切换属性：聚合 ↔ 限定 */
  onToggleRole: (word: string) => void
  /** 切换来源方式：搜索 → 标签 → 全部（仅聚合属性生效） */
  onToggleSource: (word: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 面板展开动画是否已结束（内容延后挂载，动画期间零渲染） */
  const [unfoldDone, setUnfoldDone] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label="关闭分类标签规则"
        className="fixed inset-0 z-[74] cursor-default bg-black/40"
        onClick={onClose}
      />
      <div
        className="fixed left-1/2 top-1/2 z-[75] flex w-[min(380px,calc(100vw-32px))] flex-col overflow-hidden"
        style={
          {
            transform: 'translate(-50%, -50%)',
            '--add-panel-w': 'min(380px, calc(100vw - 32px))',
            '--add-panel-h': 'min(500px, calc(100vh - 120px))',
            animation: 'cloud-add-in 0.4s 0.1s both',
            backgroundColor: 'rgba(8, 8, 8, 0.86)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '0.5px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)',
          } as React.CSSProperties
        }
        onAnimationEnd={(e) => {
          if (
            e.target === e.currentTarget &&
            e.animationName === 'cloud-add-in'
          ) {
            setUnfoldDone(true)
          }
        }}
      >
        {/* 四角白色方块点缀 */}
        <span
          aria-hidden="true"
          className="absolute left-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 left-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 z-[2] h-2 w-2 bg-white"
        />
        {/* 标题行：超大 TAG 水印 */}
        <div
          className="relative shrink-0 border-b border-white/70 px-5 pb-3 pt-4"
          style={{ animation: 'cloud-add-title-in 0.2s 0.3s both' }}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
          >
            TAG
          </span>
          <p className="relative text-center text-[17px] font-bold text-white">
            {title}
          </p>
        </div>
        {unfoldDone && (
          <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {/* 说明（属性 × 方式两维；屏蔽词指引到分类条目右上角入口） */}
            <div className="mb-3 space-y-1.5 text-[13px] font-medium leading-relaxed text-white/50">
              <p>每个标签词由两个独立徽标控制，点击词右侧对应徽标切换：</p>
              <p>
                <span
                  className="mr-1 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                >
                  聚合
                </span>
                <span
                  className="mr-1.5 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.12)' }}
                >
                  限定
                </span>
                属性：聚合词的结果并入列表（多个聚合词合并显示）；限定词要求视频标签包含该词才显示
              </p>
              <p>
                <span
                  className="mr-1 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                >
                  搜索
                </span>
                <span
                  className="mx-1 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                >
                  标签
                </span>
                <span
                  className="mr-1.5 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.12)' }}
                >
                  全部
                </span>
                方式（仅聚合词生效）：搜索 = 关键词搜索；标签 = B站 tag
                检索；全部 = 两源都取
              </p>
              <p>
                屏蔽词不在这里设置：点音乐分区列表中分类条目右上角的
                <Ban className="mx-1 inline h-3 w-3 align-[-2px]" />
                按钮单独管理
              </p>
            </div>
            {/* 添加输入行 */}
            <div className="mb-3 flex items-center gap-2">
              <input
                autoFocus
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onAdd()
                }}
                placeholder="输入标签词（逗号/空格分隔可批量）"
                className="h-8 min-w-0 flex-1 rounded-full px-3 text-sm font-bold outline-none"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: '#ffffff',
                  border: '0.5px solid rgba(255, 255, 255, 0.25)',
                }}
              />
              <button
                type="button"
                onClick={onAdd}
                className="shrink-0 rounded-full px-3 py-1.5 text-sm font-bold transition-opacity hover:opacity-70"
                style={{ backgroundColor: '#ffffff', color: '#000000' }}
              >
                添加
              </button>
            </div>
            {/* 已添加规则 chips（属性徽标 + 方式徽标两个独立按钮，点击各自切换） */}
            {rules.length === 0 ? (
              <p className="text-sm font-medium text-white/40">暂无标签词</p>
            ) : (
              <div className="zen-scroll flex max-h-[220px] flex-wrap gap-2 overflow-y-auto">
                {rules.map((r) => (
                  <span
                    key={r.word}
                    className="flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-bold text-white"
                    style={{
                      backgroundColor: 'rgba(255, 255, 255, 0.12)',
                    }}
                  >
                    {r.word}
                    {/* 属性徽标：聚合 ↔ 限定 */}
                    <button
                      type="button"
                      onClick={() => onToggleRole(r.word)}
                      className="rounded-full px-1.5 py-0.5 text-[12px] font-bold transition-opacity hover:opacity-70"
                      style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                      title={`属性：${REGION_ROLE_LABEL[r.role]}（点击切换 聚合/限定）`}
                      aria-label={`切换标签词 ${r.word} 的属性，当前 ${REGION_ROLE_LABEL[r.role]}`}
                    >
                      {REGION_ROLE_LABEL[r.role]}
                    </button>
                    {/* 方式徽标：搜索 → 标签 → 全部（仅聚合属性生效） */}
                    {r.role === 'aggregate' && (
                      <button
                        type="button"
                        onClick={() => onToggleSource(r.word)}
                        className="rounded-full px-1.5 py-0.5 text-[12px] font-bold transition-opacity hover:opacity-70"
                        style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                        title={`来源方式：${REGION_SOURCE_LABEL[r.source]}（点击切换 搜索/标签/全部）`}
                        aria-label={`切换标签词 ${r.word} 的来源方式，当前 ${REGION_SOURCE_LABEL[r.source]}`}
                      >
                        {REGION_SOURCE_LABEL[r.source]}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemove(r.word)}
                      className="flex h-4 w-4 items-center justify-center rounded-full transition-opacity hover:opacity-70"
                      style={{ backgroundColor: 'rgba(255, 255, 255, 0.18)' }}
                      title={`删除标签词 ${r.word}`}
                      aria-label={`删除标签词 ${r.word}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** 音乐分区种类行（左列；选中滑入背景同 FavFolderItem 语言；
 *  设置按钮打开多 tag 规则弹窗、右上角屏蔽词按钮打开分类屏蔽词弹窗，hover 显示删除） */
function RegionTagItem({
  name,
  selected,
  removable = false,
  onClick,
  onOpenRules,
  onOpenBlockWords,
  onRemove,
}: {
  name: string
  selected: boolean
  removable?: boolean
  onClick: () => void
  /** 分类标签规则设置（多 tag 筛选）入口 */
  onOpenRules?: () => void
  /** 分区限定屏蔽词设置入口（左栏分类条目右上角） */
  onOpenBlockWords?: () => void
  onRemove?: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="group relative flex cursor-pointer items-center overflow-hidden rounded-md p-2"
      aria-selected={selected}
    >
      {/* 滑入背景层（hover 延迟 0.2s，1s cubic-bezier；选中常驻） */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-0 -translate-x-full bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)] will-change-transform transition-transform duration-1000 ease-[cubic-bezier(0.22,0.61,0.36,1)] group-hover:translate-x-0 group-hover:delay-200',
          selected && 'translate-x-0'
        )}
      />
      <span
        className={cn(
          'relative min-w-0 flex-1 truncate text-[17px] font-bold',
          selected
            ? 'text-[var(--md-sys-color-primary)]'
            : 'text-[var(--md-sys-color-on-surface)]'
        )}
      >
        {name}
      </span>
      {/* 分类标签规则设置（hover 显形） */}
      {onOpenRules && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenRules()
          }}
          className="relative mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
          title="分类标签规则设置"
          aria-label={`设置分类 ${name} 的标签规则`}
        >
          <Settings2
            className="h-3 w-3"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          />
        </button>
      )}
      {/* 分区屏蔽词设置（右上角 Ban 图标；hover 显形） */}
      {onOpenBlockWords && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenBlockWords()
          }}
          className="relative mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
          title="分区屏蔽词设置"
          aria-label={`设置分区 ${name} 的屏蔽词`}
        >
          <Ban
            className="h-3 w-3"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          />
        </button>
      )}
      {removable && onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
          title="删除该种类"
          aria-label={`删除种类 ${name}`}
        >
          <X
            className="h-3 w-3"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          />
        </button>
      )}
    </div>
  )
}

/** 屏蔽词设置弹窗（黑底 SETTING 风格：高斯模糊 + 四角白方块 + 大字水印）。
 * 添加/删除即时持久化；关闭时由调用方重载列表使过滤生效。
 * 全局弹窗与分区弹窗共用（分区弹窗传 title + description 说明仅本分区生效） */
function BlockWordsModal({
  title = '屏蔽词设置',
  description,
  words,
  input,
  onInputChange,
  onAdd,
  onRemove,
  onToggleScope,
  onClose,
}: {
  /** 弹窗标题（分区弹窗传「分区名」屏蔽词） */
  title?: string
  /** 说明文案（分区弹窗传「仅对该分区生效」提示）；缺省用全局默认 */
  description?: string
  words: BlockWord[]
  input: string
  onInputChange: (v: string) => void
  onAdd: () => void
  onRemove: (word: string) => void
  /** 切换词作用范围：全部 → 标题 → 标签 */
  onToggleScope: (word: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** 面板展开动画是否已结束（内容延后挂载，动画期间零渲染） */
  const [unfoldDone, setUnfoldDone] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label="关闭屏蔽词设置"
        className="fixed inset-0 z-[74] cursor-default bg-black/40"
        onClick={onClose}
      />
      <div
        className="fixed left-1/2 top-1/2 z-[75] flex w-[min(380px,calc(100vw-32px))] flex-col overflow-hidden"
        style={
          {
            transform: 'translate(-50%, -50%)',
            '--add-panel-w': 'min(380px, calc(100vw - 32px))',
            '--add-panel-h': 'min(440px, calc(100vh - 120px))',
            animation: 'cloud-add-in 0.4s 0.1s both',
            backgroundColor: 'rgba(8, 8, 8, 0.86)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '0.5px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)',
          } as React.CSSProperties
        }
        onAnimationEnd={(e) => {
          if (
            e.target === e.currentTarget &&
            e.animationName === 'cloud-add-in'
          ) {
            setUnfoldDone(true)
          }
        }}
      >
        {/* 四角白色方块点缀 */}
        <span
          aria-hidden="true"
          className="absolute left-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 left-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 z-[2] h-2 w-2 bg-white"
        />
        {/* 标题行：超大 BLOCK 水印压在「屏蔽词设置」后面 */}
        <div
          className="relative shrink-0 border-b border-white/70 px-5 pb-3 pt-4"
          style={{ animation: 'cloud-add-title-in 0.2s 0.3s both' }}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
          >
            BLOCK
          </span>
          <p className="relative text-center text-[17px] font-bold text-white">
            {title}
          </p>
        </div>
        {unfoldDone && (
          <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <p className="mb-3 text-[13px] font-medium text-white/50">
              {description ??
                '全局生效：命中屏蔽词的搜索结果将被隐藏；点击词上的范围徽标可单独设置匹配标题还是标签'}
            </p>
            {/* 添加输入行 */}
            <div className="mb-3 flex items-center gap-2">
              <input
                autoFocus
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onAdd()
                }}
                placeholder="输入屏蔽词（逗号/空格分隔可批量）"
                className="h-8 min-w-0 flex-1 rounded-full px-3 text-sm font-bold outline-none"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: '#ffffff',
                  border: '0.5px solid rgba(255, 255, 255, 0.25)',
                }}
              />
              <button
                type="button"
                onClick={onAdd}
                className="shrink-0 rounded-full px-3 py-1.5 text-sm font-bold transition-opacity hover:opacity-70"
                style={{ backgroundColor: '#ffffff', color: '#000000' }}
              >
                添加
              </button>
            </div>
            {/* 已添加屏蔽词 chips */}
            {words.length === 0 ? (
              <p className="text-sm font-medium text-white/40">暂无屏蔽词</p>
            ) : (
              <div className="flex max-h-[220px] flex-wrap gap-2 overflow-y-auto zen-scroll">
                {words.map((b) => (
                  <span
                    key={b.word}
                    className="flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-bold text-white"
                    style={{
                      backgroundColor: 'rgba(255, 255, 255, 0.12)',
                    }}
                  >
                    {b.word}
                    {/* 范围徽标：点击循环 全部 → 标题 → 标签 */}
                    <button
                      type="button"
                      onClick={() => onToggleScope(b.word)}
                      className="rounded-full px-1.5 py-0.5 text-[12px] font-bold transition-opacity hover:opacity-70"
                      style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                      title={`作用范围：${SCOPE_LABEL[b.scope]}（点击切换）`}
                      aria-label={`切换屏蔽词 ${b.word} 的作用范围，当前 ${SCOPE_LABEL[b.scope]}`}
                    >
                      {SCOPE_LABEL[b.scope]}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(b.word)}
                      className="flex h-4 w-4 items-center justify-center rounded-full transition-opacity hover:opacity-70"
                      style={{ backgroundColor: 'rgba(255, 255, 255, 0.18)' }}
                      title={`删除屏蔽词 ${b.word}`}
                      aria-label={`删除屏蔽词 ${b.word}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** 收藏夹条目（我的音乐 LibraryItem 同视觉语言：滑入背景 + 图标位 + 双行文字） */
function FavFolderItem({
  name,
  info,
  cover,
  selected,
  onClick,
}: {
  name: string
  info: string
  /** 收藏夹封面（分页版接口条目带 cover；空串/加载失败回退图标） */
  cover?: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="group relative flex cursor-pointer items-center overflow-hidden p-2"
      aria-selected={selected}
    >
      {/* 滑入背景层（hover 延迟 0.2s，1s cubic-bezier；选中常驻） */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-0 -translate-x-full bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)] will-change-transform transition-transform duration-1000 ease-[cubic-bezier(0.22,0.61,0.36,1)] group-hover:translate-x-0 group-hover:delay-200',
          selected && 'translate-x-0'
        )}
      />
      <div
        className="relative mr-2.5 flex h-[44px] w-[44px] shrink-0 items-center justify-center overflow-hidden"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
          border:
            '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
        }}
      >
        <ListMusic
          className="h-5 w-5 opacity-40"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        />
        {/* 收藏夹封面（absolute 盖住图标位；加载失败隐藏自身露出图标兜底） */}
        {cover && (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
      </div>
      <div className="relative min-w-0 flex-1">
        <p className="truncate text-[17px] font-bold leading-snug text-[var(--md-sys-color-on-surface)]">
          {name}
        </p>
        <p className="truncate text-[14px] font-bold leading-snug text-[var(--md-sys-color-on-surface-variant)]">
          {info}
        </p>
      </div>
    </div>
  )
}
