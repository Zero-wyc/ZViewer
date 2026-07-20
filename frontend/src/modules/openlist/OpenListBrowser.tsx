/**
 * OpenList 浏览器：支持目录导航与文件选择
 *
 * 复用 WebDAV 协议浏览 OpenList 文件系统，支持进入子目录、返回上级、选择文件。
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, File, Folder } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { browseOpenListMount } from './openlistApi'
import type { OpenListDirectoryEntry } from './types'

interface OpenListBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFile?: (path: string) => void
  selectable?: boolean
}

function formatSize(size?: number): string {
  if (size === undefined || size === null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function OpenListBrowser({
  mountId,
  open,
  onClose,
  onSelectFile,
  selectable = false,
}: OpenListBrowserProps) {
  const [entries, setEntries] = useState<OpenListDirectoryEntry[]>([])
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(
    async (path?: string) => {
      if (mountId === null) return
      setLoading(true)
      setError('')
      try {
        const data = await browseOpenListMount(mountId, path)
        setEntries(data)
        setCurrentPath(path)
      } catch (err) {
        const msg = err instanceof Error ? err.message : '加载失败'
        setError(msg)
      } finally {
        setLoading(false)
      }
    },
    [mountId]
  )

  useEffect(() => {
    if (open && mountId !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置路径并加载
      setCurrentPath(undefined)
      setEntries([])
      void load()
    }
  }, [open, mountId, load])

  const handleEntryClick = (entry: OpenListDirectoryEntry) => {
    if (entry.type === 'directory') {
      void load(entry.path)
    } else if (selectable && onSelectFile) {
      onSelectFile(entry.path)
      onClose()
    }
  }

  const handleBack = () => {
    if (!currentPath) return
    const parent = currentPath.split('/').slice(0, -1).join('/') || undefined
    void load(parent)
  }

  return (
    <Modal open={open} onClose={onClose} title="浏览 OpenList 目录">
      <div className="relative min-h-[200px]">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <Text className="text-sm text-[var(--md-sys-color-error)]">
              {error}
            </Text>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load(currentPath)}
            >
              重试
            </Button>
          </div>
        ) : loading && entries.length === 0 ? (
          <Spinner tip="加载中..." />
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                icon={<ChevronLeft className="h-4 w-4" />}
                onClick={handleBack}
                disabled={!currentPath}
              >
                返回
              </Button>
              <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                {currentPath || '根目录'}
              </Text>
            </div>
            <div className="relative max-h-[400px] overflow-y-auto">
              {entries.map((entry) => (
                <div
                  key={entry.path}
                  onClick={() => handleEntryClick(entry)}
                  className="flex cursor-pointer items-center gap-2 rounded p-2 hover:bg-[var(--md-sys-color-surface-container-high)]"
                >
                  {entry.type === 'directory' ? (
                    <Folder className="h-4 w-4 shrink-0 text-[var(--md-sys-color-primary)]" />
                  ) : (
                    <File className="h-4 w-4 shrink-0" />
                  )}
                  <span className="truncate text-sm">{entry.name}</span>
                  {entry.size !== undefined && entry.type === 'file' && (
                    <span className="ml-auto shrink-0 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      {formatSize(entry.size)}
                    </span>
                  )}
                </div>
              ))}
              {entries.length === 0 && !loading && !error && (
                <Text className="py-6 text-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  当前目录为空
                </Text>
              )}
              {/* 切换目录时的加载蒙层：保留已有列表，叠加半透明遮罩 + 居中 Spinner */}
              {loading && entries.length > 0 && (
                <div className="absolute inset-0 flex items-center justify-center rounded bg-[var(--md-sys-color-surface)]/50 backdrop-blur-[1px]">
                  <Spinner tip="加载中..." size={20} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
