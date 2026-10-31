/**
 * Jellyfin 浏览器（复用 EmbyBrowser 的双列 itemId 树形浏览逻辑）
 *
 * Jellyfin 是 Emby 开源分支，媒体库结构一致，仅传入 Jellyfin 的浏览 API 与标题。
 */
import EmbyBrowser from '@/modules/emby/EmbyBrowser'
import type { EmbyDirectoryEntry } from '@/modules/emby/types'
import { browseJellyfinMount, searchJellyfinMount } from './jellyfinApi'
import { t } from '@/i18n'

interface JellyfinBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFiles?: (paths: string[], entries?: EmbyDirectoryEntry[]) => void
  onQuickAddSeries?: (entry: EmbyDirectoryEntry) => void
  selectable?: boolean
}

export default function JellyfinBrowser({
  mountId,
  open,
  onClose,
  onSelectFiles,
  onQuickAddSeries,
  selectable = false,
}: JellyfinBrowserProps) {
  return (
    <EmbyBrowser
      mountId={mountId}
      open={open}
      onClose={onClose}
      onSelectFiles={onSelectFiles}
      onQuickAddSeries={onQuickAddSeries}
      selectable={selectable}
      imageApi="jellyfin"
      browse={
        browseJellyfinMount as (
          mountId: number,
          path?: string
        ) => Promise<EmbyDirectoryEntry[]>
      }
      search={
        searchJellyfinMount as (
          mountId: number,
          term: string
        ) => Promise<EmbyDirectoryEntry[]>
      }
      title={t('浏览 Jellyfin 媒体库')}
    />
  )
}
