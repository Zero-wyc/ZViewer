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
} from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { cn } from '@/lib/utils'
import { browseEmbyMount } from './embyApi'
import type { EmbyDirectoryEntry } from './types'

export interface MediaLibraryBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFiles?: (paths: string[]) => void
  selectable?: boolean
  /** 浏览函数（Emby/Jellyfin 传入各自实现），默认 Emby */
  browse?: (mountId: number, path?: string) => Promise<EmbyDirectoryEntry[]>
  /** 弹窗标题，默认「浏览 Emby 媒体库」 */
  title?: string
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
  browse = browseEmbyMount,
  title = '浏览 Emby 媒体库',
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
      void load([])
    }
  }, [open, mountId, load])
  /* eslint-enable react-hooks/set-state-in-effect */

  const openDirectory = (entry: EmbyDirectoryEntry) => {
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
            entries.find((e) => e.path === p) ??
            parentEntries.find((e) => e.path === p)
        )
        .filter((e): e is EmbyDirectoryEntry => !!e && e.type === 'file'),
    [selectedPaths, entries, parentEntries]
  )

  const confirmSelection = () => {
    if (selectedFiles.length === 0) return
    onSelectFiles?.(selectedFiles.map((f) => f.path))
    onClose()
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
          title={entry.name}
        >
          {entry.name}
        </span>

        {entry.childCount !== undefined && entry.childCount > 0 && (
          <span className="shrink-0 text-[13px] text-[var(--md-sys-color-on-surface-variant)]">
            {entry.childCount} 项
          </span>
        )}

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
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      className="max-w-4xl"
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
      <div className="relative min-h-[320px]">
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
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5 text-sm text-[var(--md-sys-color-on-surface-variant)]">
                {breadcrumb.map((item, index) => (
                  <span key={item.path ?? 'root'} className="flex items-center">
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

            <div className="grid h-[420px] grid-cols-1 gap-4 overflow-hidden rounded-2xl border border-[var(--md-sys-color-outline-variant)] backdrop-blur-sm md:grid-cols-2">
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
