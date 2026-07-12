import { useCallback, useEffect, useState } from 'react'
import { Folder, File, ChevronLeft } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { browseUserMount, type MountBrowseEntry, type UserMount } from './mountApi'

interface MountBrowserModalProps {
  mount: UserMount | null
  open: boolean
  onClose: () => void
  onSelectFile?: (path: string) => void
  selectable?: boolean
}

export default function MountBrowserModal({
  mount,
  open,
  onClose,
  onSelectFile,
  selectable = false,
}: MountBrowserModalProps) {
  const [entries, setEntries] = useState<MountBrowseEntry[]>([])
  const [currentPath, setCurrentPath] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (path?: string) => {
    if (!mount) return
    setLoading(true)
    setError('')
    try {
      const data = await browseUserMount(mount.id, path)
      setEntries(data)
      setCurrentPath(path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载失败'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [mount])

  useEffect(() => {
    if (open && mount) {
      setCurrentPath(undefined)
      setEntries([])
      void load()
    }
  }, [open, mount, load])

  const handleEntryClick = (entry: MountBrowseEntry) => {
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
    <Modal open={open} onClose={onClose} title={`浏览：${mount?.name || ''}`}>
      <div className="min-h-[200px]">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <Text className="text-sm text-[var(--md-sys-color-error)]">{error}</Text>
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
            <div className="max-h-[400px] overflow-y-auto">
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
                </div>
              ))}
              {entries.length === 0 && !loading && !error && (
                <Text className="py-6 text-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  当前目录为空
                </Text>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
