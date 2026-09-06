import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  File,
  Folder,
  ChevronRight,
  Plus,
  CheckSquare2,
  Square,
  ListChecks,
} from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { cn, formatFileSize } from '@/lib/utils'

export interface DirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  lastModified?: string
}

interface MountBrowserBaseProps<T extends DirectoryEntry> {
  title: string
  mountId: number | null
  open: boolean
  onClose: () => void
  onConfirm: (paths: string[]) => void
  browse: (mountId: number, path?: string) => Promise<T[]>
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

function getParentPath(path?: string): string | undefined {
  if (!path) return undefined
  const parts = path.replace(/\/$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return undefined
  return parts.slice(0, -1).join('/') || undefined
}

function getEntryName(path: string): string {
  const raw = path.replace(/\/$/, '').split('/').pop() || path
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export default function MountBrowserBase<T extends DirectoryEntry>({
  title,
  mountId,
  open,
  onClose,
  onConfirm,
  browse,
}: MountBrowserBaseProps<T>) {
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined)
  const [entries, setEntries] = useState<T[]>([])
  const [parentEntries, setParentEntries] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [multiSelectMode, setMultiSelectMode] = useState(false)

  const load = useCallback(
    async (path?: string) => {
      if (mountId === null) return
      setLoading(true)
      setError('')
      try {
        const data = await browse(mountId, path)
        setEntries(data)
        setCurrentPath(path)

        const parent = getParentPath(path)
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

  // React Compiler 严格规则误报：Modal 打开时重置浏览状态并加载目录。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open && mountId !== null) {
      setCurrentPath(undefined)
      setEntries([])
      setParentEntries([])
      setSelectedPaths(new Set())
      setMultiSelectMode(false)
      void load()
    }
  }, [open, mountId, load])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleOpenDirectory = (path: string) => {
    void load(path)
  }

  const toggleSelection = (path: string) => {
    setSelectedPaths((prev) => {
      // 非多选模式：单选行为，点击新文件替换已有选择，再次点击取消
      if (!multiSelectMode) {
        return prev.has(path) ? new Set<string>() : new Set([path])
      }
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
        .filter((e): e is T => !!e && e.type === 'file'),
    [selectedPaths, entries, parentEntries]
  )

  const renderEntry = (entry: T, side: 'left' | 'right') => {
    const isSelected = selectedPaths.has(entry.path)
    const isDirectory = entry.type === 'directory'
    const showCheckbox = multiSelectMode && side === 'right' && !isDirectory

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
            handleOpenDirectory(entry.path)
          } else if (showCheckbox || side === 'right') {
            toggleSelection(entry.path)
          }
        }}
      >
        {isDirectory ? (
          <Folder className="h-5 w-5 shrink-0 text-[var(--md-sys-color-primary)]" />
        ) : (
          <File className="h-5 w-5 shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
        )}

        <span
          className="min-w-0 flex-1 truncate text-[15px] font-medium"
          title={entry.name}
        >
          {entry.name}
        </span>

        {!isDirectory && (
          <>
            {entry.size !== undefined && (
              <span className="shrink-0 text-[13px] text-[var(--md-sys-color-on-surface-variant)]">
                {formatFileSize(entry.size)}
              </span>
            )}
            {(showCheckbox || isSelected) && (
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
          </>
        )}
      </div>
    )
  }

  const breadcrumb = useMemo(() => {
    if (!currentPath) return [{ name: '根目录', path: undefined }]
    const parts = currentPath.replace(/\/$/, '').split('/').filter(Boolean)
    const items = [{ name: '根目录', path: undefined }]
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      items.push({ name: part, path: acc })
    }
    return items
  }, [currentPath])

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
              ? `已选择 ${selectedFiles.length} 个文件`
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
              onClick={() => {
                if (selectedFiles.length === 0) return
                onConfirm(selectedFiles.map((f) => f.path))
                onClose()
              }}
              disabled={selectedFiles.length === 0}
            >
              {multiSelectMode
                ? `添加 (${selectedFiles.length})`
                : '添加当前文件'}
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
              onClick={() => void load(currentPath)}
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
                      onClick={() => void load(item.path)}
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
                    if (prev) {
                      setSelectedPaths(new Set())
                    }
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
                    <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                      已在根目录
                    </Text>
                  )}
                </div>
              </div>

              {/* 右侧：当前目录 */}
              <div className="flex min-h-0 flex-col bg-[var(--md-sys-color-surface)]/80">
                <div className="shrink-0 border-b border-[var(--md-sys-color-outline-variant)] px-4 py-3 text-sm font-semibold uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {currentPath ? getEntryName(currentPath) : '根目录'}
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
