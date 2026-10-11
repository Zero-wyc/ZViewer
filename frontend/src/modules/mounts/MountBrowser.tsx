// 统一挂载浏览器：按挂载类型分流到对应模块的独立浏览器
import type { WebDAVMount } from '@/modules/webdav/types'
import type { OpenListMount } from '@/modules/openlist/types'
import type { FTPMount } from '@/modules/ftp/types'
import type { EmbyMount } from '@/modules/emby/types'
import type { EmbyDirectoryEntry } from '@/modules/emby/types'
import type { JellyfinMount } from '@/modules/jellyfin/types'
import WebDAVBrowser from '@/modules/webdav/WebDAVBrowser'
import OpenListBrowser from '@/modules/openlist/OpenListBrowser'
import FTPBrowser from '@/modules/ftp/FTPBrowser'
import EmbyBrowser from '@/modules/emby/EmbyBrowser'
import JellyfinBrowser from '@/modules/jellyfin/JellyfinBrowser'
import type { UnionMount } from './types'
import {
  isWebDAVMount,
  isOpenListMount,
  isFTPMount,
  isEmbyMount,
  isJellyfinMount,
} from './types'

interface MountBrowserProps {
  mount: UnionMount | null
  open: boolean
  onClose: () => void
  onSelectFile?: (path: string) => void
  /** entries：选中条目的完整信息（emby/jellyfin 剧集整卡添加需要 embyType/imageTag） */
  onSelectFiles?: (paths: string[], entries?: EmbyDirectoryEntry[]) => void
  /** 一键添加整部影片（emby/jellyfin 的 Series/Season 条目快捷按钮） */
  onQuickAddSeries?: (entry: EmbyDirectoryEntry) => void
  selectable?: boolean
}

export default function MountBrowser({
  mount,
  open,
  onClose,
  onSelectFile,
  onSelectFiles,
  onQuickAddSeries,
  selectable = false,
}: MountBrowserProps) {
  const handleFiles = (paths: string[], entries?: EmbyDirectoryEntry[]) => {
    if (onSelectFiles) {
      onSelectFiles(paths, entries)
    } else if (onSelectFile && paths[0]) {
      onSelectFile(paths[0])
    }
    onClose()
  }

  if (mount && isWebDAVMount(mount)) {
    return (
      <WebDAVBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        selectable={selectable}
      />
    )
  }

  if (mount && isOpenListMount(mount)) {
    return (
      <OpenListBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        selectable={selectable}
      />
    )
  }

  if (mount && isFTPMount(mount)) {
    return (
      <FTPBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        selectable={selectable}
      />
    )
  }

  if (mount && isEmbyMount(mount)) {
    return (
      <EmbyBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        onQuickAddSeries={onQuickAddSeries}
        selectable={selectable}
      />
    )
  }

  if (mount && isJellyfinMount(mount)) {
    return (
      <JellyfinBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFiles={selectable ? handleFiles : undefined}
        onQuickAddSeries={onQuickAddSeries}
        selectable={selectable}
      />
    )
  }

  // mount 为 null 时返回一个不可见的占位 Modal，保持 hook 调用数稳定
  return (
    <WebDAVBrowser
      mountId={null}
      open={open}
      onClose={onClose}
      onSelectFiles={undefined}
      selectable={selectable}
    />
  )
}

// 重新导出各类型，方便调用方使用
export type { WebDAVMount, OpenListMount, FTPMount, EmbyMount, JellyfinMount }
