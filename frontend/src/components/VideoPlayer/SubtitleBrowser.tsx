import { readSubtitleLoadResponse } from './subtitleResponse'
/**
 * 字幕目录浏览器组件。
 *
 * 在设置面板左侧展开的侧面板，列出当前影片所在目录的文件列表。
 * 支持目录导航（进入子目录 / 返回上级），点击字幕文件即加载。
 *
 * 内部调用：
 *   GET /api/subtitles/browse?movieId=&path=  列出目录
 *   GET /api/subtitles/load?movieId=&path=    读取字幕内容
 */
import { useCallback, useEffect, useState } from 'react'
import {
  ChevronLeft,
  Folder,
  FileText,
  Loader2,
  FileQuestion,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/EmptyState'
import { t } from '@/i18n'

interface BrowseEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  isSubtitle: boolean
  size?: number
}

interface BrowseResponse {
  success: boolean
  entries?: BrowseEntry[]
  currentPath?: string
  parentPath?: string | null
  message?: string
}

interface SubtitleBrowserProps {
  movieId: number
  onSelect: (content: string, filename: string, format: string) => void
}

export function SubtitleBrowser({ movieId, onSelect }: SubtitleBrowserProps) {
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [currentPath, setCurrentPath] = useState<string>('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingFile, setLoadingFile] = useState<string | null>(null)
  const [error, setError] = useState('')

  const fetchDir = useCallback(
    async (dirPath?: string) => {
      setLoading(true)
      setError('')
      try {
        const params = new URLSearchParams({ movieId: String(movieId) })
        if (dirPath) params.set('path', dirPath)
        const res = await apiFetch(`/api/subtitles/browse?${params}`)
        const data = (await res.json()) as BrowseResponse
        if (!res.ok || !data.success) {
          setError(data.message || t('浏览目录失败'))
          setEntries([])
          return
        }
        setEntries(data.entries || [])
        setCurrentPath(data.currentPath || '')
        setParentPath(data.parentPath ?? null)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('网络错误'))
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [movieId]
  )

  // 首次挂载时加载影片所在目录
  useEffect(() => {
    void fetchDir()
  }, [fetchDir])

  const handleEntryClick = useCallback(
    async (entry: BrowseEntry) => {
      if (entry.type === 'directory') {
        void fetchDir(entry.path)
        return
      }
      if (!entry.isSubtitle || loadingFile) return
      setLoadingFile(entry.path)
      setError('')
      try {
        const params = new URLSearchParams({
          movieId: String(movieId),
          path: entry.path,
        })
        const res = await apiFetch(`/api/subtitles/load?${params}`)
        const data = await readSubtitleLoadResponse(res)
        onSelect(
          data.content,
          data.filename || entry.name,
          data.format || 'srt'
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : t('网络错误'))
      } finally {
        setLoadingFile(null)
      }
    },
    [movieId, onSelect, loadingFile, fetchDir]
  )

  const handleBack = useCallback(() => {
    if (parentPath) void fetchDir(parentPath)
  }, [parentPath, fetchDir])

  // 显示当前路径的简短形式（仅最后一级目录名）
  const shortPath = (() => {
    if (!currentPath) return ''
    const parts = currentPath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length === 0) return '/'
    return parts[parts.length - 1]
  })()

  return (
    <div className="flex h-full flex-col">
      {/* 标题栏 */}
      <div className="mb-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleBack}
          disabled={!parentPath || loading}
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors',
            parentPath && !loading
              ? 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
              : 'text-[var(--md-sys-color-on-surface)] opacity-30'
          )}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span
          className="truncate text-xs font-semibold"
          style={{ color: 'var(--md-sys-color-on-surface)' }}
          title={currentPath}
        >
          {shortPath || t('根目录')}
        </span>
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--md-sys-color-on-surface-variant)]" />
          </div>
        ) : error ? (
          <div
            className="py-4 text-center text-[11px]"
            style={{ color: 'var(--md-sys-color-error)' }}
          >
            {error}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState text={t('目录为空')} className="py-4" />
        ) : (
          <div className="flex flex-col gap-0.5">
            {entries.map((entry) => {
              const isLoadingThis = loadingFile === entry.path
              const clickable = entry.type === 'directory' || entry.isSubtitle
              return (
                <button
                  key={entry.path}
                  type="button"
                  disabled={!clickable || isLoadingThis}
                  onClick={() => handleEntryClick(entry)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    clickable &&
                      'hover:bg-[var(--md-sys-color-surface-container-highest)]',
                    !clickable && 'cursor-default opacity-40',
                    entry.isSubtitle &&
                      'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] hover:bg-[var(--md-sys-color-primary-container)]',
                    isLoadingThis && 'opacity-60'
                  )}
                  style={!entry.isSubtitle ? { color: '#000' } : undefined}
                >
                  {isLoadingThis ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : entry.type === 'directory' ? (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--md-sys-color-primary)]" />
                  ) : entry.isSubtitle ? (
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <FileQuestion className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="truncate" title={entry.name}>
                    {entry.name}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
