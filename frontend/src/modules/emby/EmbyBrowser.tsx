/**
 * Emby 浏览器（双列布局，与 WebDAV/OpenList 浏览框交互一致）
 *
 * Emby 是媒体库型（itemId 树形），无路径概念，
 * 因此用历史栈（{name, path}）模拟"上级目录"：
 * - 左列 = 上级目录的条目（父级文件夹），点击进入
 * - 右列 = 当前目录条目（文件夹进入，文件选中/添加）
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Folder,
  Film,
  ChevronRight,
  Plus,
  CheckSquare2,
  Square,
  ListChecks,
  Clapperboard,
  LayoutGrid,
  List,
  Search,
  X,
  ListPlus,
} from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { Input } from '@/components/ui/Input'
import { Text } from '@/components/ui/Typography'
import { cn } from '@/lib/utils'
import {
  browseEmbyMount,
  buildEmbyImageUrl,
  parseEpisodeFromFilePath,
  searchEmbyMount,
} from './embyApi'
import type { EmbyDirectoryEntry } from './types'

export interface MediaLibraryBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  /**
   * 选中回调。paths 为条目 path 列表；entries 为对应完整条目信息
   * （含 embyType/imageTag 等，供剧集整卡添加等场景判断类型），可能为 undefined。
   */
  onSelectFiles?: (paths: string[], entries?: EmbyDirectoryEntry[]) => void
  /**
   * 一键添加整部影片（Series → 整部剧 / Season → 整季）。
   * 提供时，剧集/季条目上会渲染快捷按钮，点击直接走整卡添加流程，
   * 无需进入目录逐个勾选分集。
   */
  onQuickAddSeries?: (entry: EmbyDirectoryEntry) => void
  selectable?: boolean
  /** 浏览函数（Emby/Jellyfin 传入各自实现），默认 Emby */
  browse?: (mountId: number, path?: string) => Promise<EmbyDirectoryEntry[]>
  /** 全库搜索函数（官方 API SearchTerm 递归检索），缺省不显示搜索框 */
  search?: (mountId: number, term: string) => Promise<EmbyDirectoryEntry[]>
  /** 弹窗标题，默认「浏览 Emby 媒体库」 */
  title?: string
  /** 海报图代理的 API 前缀（Jellyfin 传 'jellyfin'），默认 'emby' */
  imageApi?: 'emby' | 'jellyfin'
}

interface Crumb {
  name: string
  path: string | undefined
}

function EntrySkeleton() {
  return (
    <div className="flex animate-pulse items-center gap-3 rounded-lg p-2.5">
      <div className="h-5 w-5 rounded bg-[var(--md-sys-color-surface-container-high)]" />
      <div className="h-4 flex-1 rounded bg-[var(--md-sys-color-surface-container-high)]" />
      <div className="h-3 w-12 rounded bg-[var(--md-sys-color-surface-container-high)]" />
    </div>
  )
}

const FOLDER_ICONS: Record<string, React.ReactNode> = {
  CollectionFolder: (
    <Folder className="h-5 w-5 shrink-0 text-[var(--md-sys-color-primary)]" />
  ),
  Series: (
    <Clapperboard className="h-5 w-5 shrink-0 text-[var(--md-sys-color-tertiary)]" />
  ),
  Season: (
    <Folder className="h-5 w-5 shrink-0 text-[var(--md-sys-color-tertiary)]" />
  ),
}

export default function EmbyBrowser({
  mountId,
  open,
  onClose,
  onSelectFiles,
  onQuickAddSeries,
  browse = browseEmbyMount,
  search = searchEmbyMount,
  title = '浏览 Emby 媒体库',
  imageApi = 'emby',
}: MediaLibraryBrowserProps) {
  /** 面包屑历史栈：不含根（根 = 媒体库） */
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  /** 右列：当前目录条目 */
  const [entries, setEntries] = useState<EmbyDirectoryEntry[]>([])
  /** 左列：上级目录条目（父级文件夹） */
  const [parentEntries, setParentEntries] = useState<EmbyDirectoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  /** 视图模式：list = 双列文件列表，wall = 刮削海报瀑布流 */
  const [viewMode, setViewMode] = useState<'list' | 'wall'>(() => {
    const saved = localStorage.getItem('media-library-view-mode')
    return saved === 'wall' ? 'wall' : 'list'
  })
  // 全库搜索：非空时结果替代目录浏览（官方 API SearchTerm 递归检索）
  const [searchTerm, setSearchTerm] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<EmbyDirectoryEntry[]>([])
  const searchActive = searchTerm.trim().length > 0

  const switchViewMode = (mode: 'list' | 'wall') => {
    setViewMode(mode)
    localStorage.setItem('media-library-view-mode', mode)
  }

  const currentPath =
    crumbs.length > 0 ? crumbs[crumbs.length - 1].path : undefined

  const load = useCallback(
    async (nextCrumbs: Crumb[]) => {
      if (mountId === null) return
      setLoading(true)
      setError('')
      try {
        const target =
          nextCrumbs.length > 0
            ? nextCrumbs[nextCrumbs.length - 1].path
            : undefined
        const data = await browse(mountId, target)
        setEntries(data)
        setCrumbs(nextCrumbs)

        // 左列：父级目录条目（仅文件夹）
        const parent =
          nextCrumbs.length > 1
            ? nextCrumbs[nextCrumbs.length - 2].path
            : undefined
        if (parent !== undefined) {
          try {
            const parentData = await browse(mountId, parent)
            setParentEntries(parentData)
          } catch {
            setParentEntries([])
          }
        } else {
          setParentEntries([])
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '加载失败'
        setError(msg)
      } finally {
        setLoading(false)
      }
    },
    [mountId, browse]
  )

  // React Compiler 严格规则误报：Modal 打开时重置浏览状态并加载媒体库。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open && mountId !== null) {
      setCrumbs([])
      setEntries([])
      setParentEntries([])
      setSelectedPaths(new Set())
      setMultiSelectMode(false)
      setSearchTerm('')
      setSearchResults([])
      void load([])
    }
  }, [open, mountId, load])
  /* eslint-enable react-hooks/set-state-in-effect */

  const doSearch = useCallback(
    async (term: string) => {
      const trimmed = term.trim()
      if (!search || mountId === null) return
      if (!trimmed) {
        setSearchResults([])
        return
      }
      setSearching(true)
      try {
        const data = await search(mountId, trimmed)
        setSearchResults(data)
      } catch (err) {
        setSearchResults([])
        setError(err instanceof Error ? err.message : '搜索失败')
      } finally {
        setSearching(false)
      }
    },
    [search, mountId]
  )

  /** 当前展示的条目：搜索态 = 搜索结果，否则 = 当前目录 */
  const displayEntries = searchActive ? searchResults : entries

  const openDirectory = (entry: EmbyDirectoryEntry) => {
    // 搜索结果进入目录：清搜索态并重置面包屑（搜索结果与浏览路径无层级关系）
    if (searchActive) {
      setSearchTerm('')
      setSearchResults([])
      void load([{ name: entry.name, path: entry.path }])
      return
    }
    void load([...crumbs, { name: entry.name, path: entry.path }])
  }

  const openLeftDirectory = (entry: EmbyDirectoryEntry) => {
    // 左列条目位于父级：进入该条目后，历史 = 父级路径 + 该条目
    // crumbs 此时为 [父1, 父2...]；左列条目 = 父级目录下的文件夹
    // 点击后它成为新的当前目录，父级链条保留（去掉当前层级）
    const base = crumbs.slice(0, -1)
    void load([...base, { name: entry.name, path: entry.path }])
  }

  const goRoot = () => void load([])

  const toggleSelection = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const selectedFiles = useMemo(
    () =>
      [...selectedPaths]
        .map(
          (p) =>
            displayEntries.find((e) => e.path === p) ??
            (searchActive ? undefined : parentEntries.find((e) => e.path === p))
        )
        .filter((e): e is EmbyDirectoryEntry => !!e && e.type === 'file'),
    [selectedPaths, displayEntries, searchActive, parentEntries]
  )

  const confirmSelection = () => {
    if (selectedFiles.length === 0) return
    onSelectFiles?.(
      selectedFiles.map((f) => f.path),
      selectedFiles
    )
    onClose()
  }

  /** 剧集/季/普通文件夹条目支持一键整卡添加（Series=整部剧，Season=整季，
   *  Folder=该目录下全部视频文件；CollectionFolder=媒体库根不显示） */
  const canQuickAdd = (entry: EmbyDirectoryEntry) =>
    !!onQuickAddSeries &&
    (entry.embyType === 'Series' ||
      entry.embyType === 'Season' ||
      (entry.type === 'directory' && entry.embyType !== 'CollectionFolder'))

  const quickAddLabel = (entry: EmbyDirectoryEntry) =>
    entry.embyType === 'Season' ? '添加整季' : '添加整部影片'

  /** 快捷整卡添加按钮（list 行尾 / wall 卡片右下角浮层），阻断条目点击 */
  const renderQuickAddButton = (
    entry: EmbyDirectoryEntry,
    variant: 'row' | 'overlay'
  ) => {
    if (!canQuickAdd(entry)) return null
    return (
      <button
        type="button"
        className={cn(
          'flex items-center gap-1 rounded-[var(--md-sys-shape-corner)] font-medium transition-all',
          variant === 'row'
            ? 'shrink-0 px-2 py-1 text-xs text-[var(--md-sys-color-primary)] opacity-0 hover:bg-[var(--md-sys-color-primary-container)] group-hover:opacity-100'
            : 'absolute bottom-1.5 right-1.5 bg-black/60 px-1.5 py-1 text-[10px] leading-none text-white opacity-0 hover:bg-[var(--md-sys-color-primary)] group-hover:opacity-100'
        )}
        title={quickAddLabel(entry)}
        onClick={(e) => {
          e.stopPropagation()
          onQuickAddSeries?.(entry)
        }}
      >
        <ListPlus className="h-3.5 w-3.5" />
        {variant === 'row' ? quickAddLabel(entry) : '整部'}
      </button>
    )
  }

  /**
   * 条目显示名：Episode 常全部同名（如「Sousou no Frieren」×28），
   * 无法分辨集数——识别顺序：
   * 1. Episode 类型自带 IndexNumber → 「S1E3 · 名称」
   * 2. 无序号时从文件路径解析集号（非刮削库的 Video 条目）→ 「EP03 · 名称」
   */
  const entryDisplayName = (entry: EmbyDirectoryEntry) => {
    if (entry.embyType === 'Episode' && entry.indexNumber != null) {
      const label = `S${entry.parentIndexNumber ?? '?'}E${entry.indexNumber}`
      return `${label} · ${entry.name}`
    }
    if (entry.type === 'file' && entry.filePath) {
      const parsed = parseEpisodeFromFilePath(entry.filePath)
      if (parsed) {
        const season = parsed.season != null ? `S${parsed.season}` : ''
        return `EP${season}${parsed.episode} · ${entry.name}`
      }
    }
    return entry.name
  }

  const renderEntry = (entry: EmbyDirectoryEntry, side: 'left' | 'right') => {
    const isSelected = selectedPaths.has(entry.path)
    const isDirectory = entry.type === 'directory'
    const showCheckbox = multiSelectMode && side === 'right' && !isDirectory
    const folderIcon = (entry.embyType
      ? FOLDER_ICONS[entry.embyType]
      : undefined) ?? (
      <Folder className="h-5 w-5 shrink-0 text-[var(--md-sys-color-primary)]" />
    )

    return (
      <div
        key={`${side}-${entry.path}`}
        className={cn(
          'group flex cursor-pointer items-center gap-3 rounded-lg p-2.5 transition-all',
          isSelected
            ? 'bg-[var(--md-sys-color-primary-container)] shadow-sm'
            : 'hover:bg-[var(--md-sys-color-surface-container-high)] hover:translate-x-0.5'
        )}
        onClick={() => {
          if (isDirectory) {
            if (side === 'left') {
              openLeftDirectory(entry)
            } else {
              openDirectory(entry)
            }
          } else if (showCheckbox || side === 'right') {
            toggleSelection(entry.path)
          }
        }}
      >
        {isDirectory ? (
          folderIcon
        ) : (
          <Film className="h-5 w-5 shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
        )}

        <span
          className="min-w-0 flex-1 truncate text-[15px] font-medium"
          title={entryDisplayName(entry)}
        >
          {entryDisplayName(entry)}
        </span>

        {entry.childCount !== undefined && entry.childCount > 0 && (
          <span className="shrink-0 text-[13px] text-[var(--md-sys-color-on-surface-variant)]">
            {entry.childCount} 项
          </span>
        )}

        {side === 'right' && renderQuickAddButton(entry, 'row')}

        {!isDirectory && (showCheckbox || isSelected) && (
          <span
            className={cn(
              'shrink-0 rounded-md p-1.5 text-[var(--md-sys-color-primary)] transition-all',
              showCheckbox
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100',
              isSelected && 'bg-[var(--md-sys-color-primary-container)]'
            )}
            onClick={(e) => {
              e.stopPropagation()
              toggleSelection(entry.path)
            }}
          >
            {isSelected ? (
              <CheckSquare2 className="h-5 w-5" />
            ) : (
              <Square className="h-5 w-5" />
            )}
          </span>
        )}
      </div>
    )
  }

  /** 海报墙卡片：封面(刮削 Primary 海报) + 名称 + 年份 */
  const renderWallCard = (entry: EmbyDirectoryEntry) => {
    const isSelected = selectedPaths.has(entry.path)
    const isDirectory = entry.type === 'directory'
    return (
      <div
        key={entry.path}
        className={cn(
          'group relative cursor-pointer overflow-hidden rounded-[var(--md-sys-shape-corner)] border transition-all',
          isSelected
            ? 'border-[var(--md-sys-color-primary)] shadow-md'
            : 'border-transparent hover:-translate-y-0.5 hover:shadow-md'
        )}
        onClick={() => {
          if (isDirectory) {
            openDirectory(entry)
          } else {
            toggleSelection(entry.path)
          }
        }}
      >
        <div className="relative aspect-[2/3] w-full bg-[var(--glass-bg)]">
          {/* 图标兜底层：无 Primary tag 的文件夹经后端回退取子项海报，
              图片加载失败（onError 隐藏）时露出图标 */}
          <div className="absolute inset-0 flex items-center justify-center">
            {isDirectory ? (
              <Folder className="h-8 w-8 opacity-40" />
            ) : (
              <Film className="h-8 w-8 opacity-40" />
            )}
          </div>
          <img
            src={buildEmbyImageUrl(
              imageApi,
              mountId ?? 0,
              entry.path,
              entry.imageTag,
              300
            )}
            alt={entry.name}
            loading="lazy"
            className="relative h-full w-full object-cover"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.visibility = 'hidden'
            }}
          />
          {isDirectory && (
            <div className="absolute right-1.5 top-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] leading-none text-white">
              {entry.childCount ?? 0} 项
            </div>
          )}
          {renderQuickAddButton(entry, 'overlay')}
          {multiSelectMode && !isDirectory && (
            <div
              className="absolute left-1.5 top-1.5"
              onClick={(e) => {
                e.stopPropagation()
                toggleSelection(entry.path)
              }}
            >
              {isSelected ? (
                <CheckSquare2 className="h-5 w-5 text-white drop-shadow" />
              ) : (
                <Square className="h-5 w-5 text-white/70 drop-shadow" />
              )}
            </div>
          )}
        </div>
        <div className="p-1.5">
          <Text
            className="block truncate text-[11px] font-medium leading-tight"
            title={entryDisplayName(entry)}
          >
            {entryDisplayName(entry)}
          </Text>
          {entry.productionYear != null && (
            <Text type="secondary" className="block text-[10px] leading-tight">
              {entry.productionYear}
            </Text>
          )}
        </div>
      </div>
    )
  }

  const breadcrumb = useMemo(
    () => [
      { name: '媒体库', path: undefined as string | undefined },
      ...crumbs,
    ],
    [crumbs]
  )

  const loadingSkeletons = (
    <>
      <div className="mb-4 h-5 w-2/3 animate-pulse rounded bg-[var(--md-sys-color-surface-container-high)]" />
      {viewMode === 'wall' ? (
        <div className="grid h-[420px] grid-cols-3 gap-3 overflow-hidden rounded-2xl border border-[var(--md-sys-color-outline-variant)] p-3 md:grid-cols-4 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex animate-pulse flex-col gap-1.5">
              <div className="aspect-[2/3] w-full rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)]" />
              <div className="h-3 w-3/4 rounded bg-[var(--md-sys-color-surface-container-high)]" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid h-[420px] grid-cols-1 gap-4 overflow-hidden rounded-2xl border border-[var(--md-sys-color-outline-variant)] md:grid-cols-2">
          <div className="hidden min-h-0 flex-col border-r border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)]/60 p-3 md:flex">
            <div className="mb-3 h-4 w-16 animate-pulse rounded bg-[var(--md-sys-color-surface-container-high)]" />
            <div className="flex-1 space-y-1 overflow-hidden">
              {Array.from({ length: 8 }).map((_, i) => (
                <EntrySkeleton key={`left-${i}`} />
              ))}
            </div>
          </div>
          <div className="flex flex-col bg-[var(--md-sys-color-surface)]/80 p-3">
            <div className="mb-3 h-4 w-16 animate-pulse rounded bg-[var(--md-sys-color-surface-container-high)]" />
            <div className="flex-1 space-y-1 overflow-hidden">
              {Array.from({ length: 8 }).map((_, i) => (
                <EntrySkeleton key={`right-${i}`} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      className="max-w-4xl"
      fullscreenable
      footer={
        <div className="flex w-full items-center justify-between">
          <Text
            className={cn(
              'text-sm transition-colors',
              selectedFiles.length > 0
                ? 'text-[var(--md-sys-color-primary)]'
                : 'text-[var(--md-sys-color-on-surface-variant)]'
            )}
          >
            {multiSelectMode
              ? `已选择 ${selectedFiles.length} 个条目`
              : '多选模式可批量添加'}
          </Text>
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="md" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              icon={<Plus className="h-4 w-4" />}
              onClick={confirmSelection}
              disabled={selectedFiles.length === 0}
            >
              {multiSelectMode
                ? `添加 (${selectedFiles.length})`
                : '添加当前条目'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="relative flex h-full min-h-[420px] flex-col">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Text className="text-base text-[var(--md-sys-color-error)]">
              {error}
            </Text>
            <Button
              variant="secondary"
              size="md"
              onClick={() => void load(crumbs)}
            >
              重试
            </Button>
          </div>
        ) : loading && entries.length === 0 ? (
          loadingSkeletons
        ) : (
          <>
            {search && (
              <div className="mb-3 flex items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    size="md"
                    value={searchTerm}
                    onChange={(e) => {
                      setSearchTerm(e.target.value)
                      if (!e.target.value.trim()) setSearchResults([])
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void doSearch(searchTerm)
                      }
                    }}
                    placeholder="搜索媒体库（电影 / 剧集 / 单集）"
                    className="w-full pr-9"
                  />
                  {searchTerm && (
                    <button
                      type="button"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]"
                      onClick={() => {
                        setSearchTerm('')
                        setSearchResults([])
                      }}
                      aria-label="清除搜索"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="md"
                  icon={<Search className="h-4 w-4" />}
                  loading={searching}
                  disabled={!searchTerm.trim()}
                  onClick={() => void doSearch(searchTerm)}
                  className="h-[42px] shrink-0"
                >
                  搜索
                </Button>
              </div>
            )}
            {!searchActive ? (
              <>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm text-[var(--md-sys-color-on-surface-variant)]">
                    {breadcrumb.map((item, index) => (
                      <span
                        key={item.path ?? 'root'}
                        className="flex items-center"
                      >
                        {index > 0 && <ChevronRight className="mx-1 h-4 w-4" />}
                        <button
                          className="rounded-lg px-2 py-1 hover:bg-[var(--md-sys-color-surface-container-high)] hover:text-[var(--md-sys-color-on-surface)]"
                          onClick={() => {
                            if (item.path === undefined) {
                              goRoot()
                            } else {
                              void load(crumbs.slice(0, index))
                            }
                          }}
                        >
                          {item.name}
                        </button>
                      </span>
                    ))}
                  </div>

                  {/* 视图切换：列表 / 海报墙 */}
                  <div
                    className="inline-flex rounded-[var(--md-sys-shape-corner)] border p-0.5"
                    style={{
                      borderColor: 'var(--md-sys-color-outline-variant)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => switchViewMode('list')}
                      className={cn(
                        'flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1 text-xs font-medium transition-all',
                        viewMode === 'list'
                          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                          : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-high)]'
                      )}
                      title="列表视图"
                    >
                      <List className="h-3.5 w-3.5" />
                      列表
                    </button>
                    <button
                      type="button"
                      onClick={() => switchViewMode('wall')}
                      className={cn(
                        'flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1 text-xs font-medium transition-all',
                        viewMode === 'wall'
                          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                          : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-high)]'
                      )}
                      title="海报墙视图（拉取刮削封面）"
                    >
                      <LayoutGrid className="h-3.5 w-3.5" />
                      海报墙
                    </button>
                  </div>

                  <Button
                    variant={multiSelectMode ? 'primary' : 'secondary'}
                    size="sm"
                    icon={<ListChecks className="h-4 w-4" />}
                    onClick={() => {
                      setMultiSelectMode((prev) => {
                        if (prev) setSelectedPaths(new Set())
                        return !prev
                      })
                    }}
                  >
                    {multiSelectMode ? '退出多选' : '多选'}
                  </Button>
                </div>

                {viewMode === 'wall' ? (
                  /* 海报墙视图：直接消费刮削内容（Primary 海报经后端代理）。
                      auto-fill 按容器宽度自适应列数：网页全屏（分辨率更高）时
                      显示更多更小的卡片，而不是把固定列数的卡片拉大 */
                  <div className="zen-scroll min-h-0 flex-1 overflow-y-auto rounded-2xl border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface)]/80 p-3">
                    {entries.length > 0 ? (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                        {entries.map(renderWallCard)}
                      </div>
                    ) : (
                      <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                        当前目录为空
                      </Text>
                    )}
                  </div>
                ) : (
                  <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden rounded-2xl border border-[var(--md-sys-color-outline-variant)] backdrop-blur-sm md:grid-cols-2">
                    {/* 左侧：上级目录（小屏单栏时隐藏，导航由面包屑承担） */}
                    <div className="hidden min-h-0 flex-col border-r border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)]/60 md:flex">
                      <div className="shrink-0 border-b border-[var(--md-sys-color-outline-variant)] px-4 py-3 text-sm font-semibold uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                        上级目录
                      </div>
                      <div className="zen-scroll min-h-0 flex-1 overflow-y-auto p-3">
                        {currentPath ? (
                          parentEntries.length > 0 ? (
                            parentEntries.map((entry) =>
                              entry.type === 'directory'
                                ? renderEntry(entry, 'left')
                                : null
                            )
                          ) : (
                            <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                              上级目录为空
                            </Text>
                          )
                        ) : (
                          <div className="flex flex-col items-center gap-3 py-10 text-center">
                            <Folder className="h-8 w-8 text-[var(--md-sys-color-outline)]" />
                            <Text className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
                              当前位于媒体库根目录
                              <br />
                              在右侧进入媒体库后即可查看上级
                            </Text>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 右侧：当前目录 */}
                    <div className="flex min-h-0 flex-col bg-[var(--md-sys-color-surface)]/80">
                      <div className="shrink-0 border-b border-[var(--md-sys-color-outline-variant)] px-4 py-3 text-sm font-semibold uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                        当前目录
                      </div>
                      <div className="zen-scroll min-h-0 flex-1 overflow-y-auto p-3">
                        {entries.length > 0 ? (
                          entries.map((entry) => renderEntry(entry, 'right'))
                        ) : (
                          <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                            当前目录为空
                          </Text>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : /* 搜索结果区：列表 = 单列条目；海报墙 = 刮削海报 grid */
            viewMode === 'wall' ? (
              <div className="zen-scroll min-h-0 flex-1 overflow-y-auto rounded-2xl border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface)]/80 p-3">
                {searchResults.length > 0 ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                    {searchResults.map(renderWallCard)}
                  </div>
                ) : (
                  <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                    {searching ? '搜索中...' : '未找到匹配结果'}
                  </Text>
                )}
              </div>
            ) : (
              <div className="zen-scroll min-h-0 flex-1 overflow-y-auto rounded-2xl border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface)]/80 p-2">
                {searchResults.length > 0 ? (
                  searchResults.map((entry) => renderEntry(entry, 'right'))
                ) : (
                  <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                    {searching ? '搜索中...' : '未找到匹配结果'}
                  </Text>
                )}
              </div>
            )}

            {loading && entries.length > 0 && (
              <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-[var(--md-sys-color-surface)]/40 backdrop-blur-md">
                <Spinner tip="加载中..." size={28} />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
