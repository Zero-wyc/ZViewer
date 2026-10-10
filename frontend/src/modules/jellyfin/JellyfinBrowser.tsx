/**
 * Jellyfin 浏览器（复用 EmbyBrowser 的双列 itemId 树形浏览逻辑）
 *
 * Jellyfin 是 Emby 开源分支，媒体库结构一致，仅传入 Jellyfin 的浏览 API 与标题。
 */
import EmbyBrowser from '@/modules/emby/EmbyBrowser'
import type { EmbyDirectoryEntry } from '@/modules/emby/types'
import { browseJellyfinMount } from './jellyfinApi'

interface JellyfinBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFiles?: (paths: string[]) => void
  selectable?: boolean
}

export default function JellyfinBrowser({
  mountId,
  open,
  onClose,
  onSelectFiles,
  selectable = false,
}: JellyfinBrowserProps) {
  return (
    <EmbyBrowser
      mountId={mountId}
      open={open}
      onClose={onClose}
      onSelectFiles={onSelectFiles}
      selectable={selectable}
      imageApi="jellyfin"
      browse={
        browseJellyfinMount as (
          mountId: number,
          path?: string
        ) => Promise<EmbyDirectoryEntry[]>
      }
      title="浏览 Jellyfin 媒体库"
    />
  )
}
