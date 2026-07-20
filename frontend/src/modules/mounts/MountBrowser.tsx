// 统一挂载浏览器：按挂载类型分流到对应模块的独立浏览器
import type { WebDAVMount } from '@/modules/webdav/types'
import type { OpenListMount } from '@/modules/openlist/types'
import type { FTPMount } from '@/modules/ftp/types'
import WebDAVBrowser from '@/modules/webdav/WebDAVBrowser'
import OpenListBrowser from '@/modules/openlist/OpenListBrowser'
import FTPBrowser from '@/modules/ftp/FTPBrowser'
import type { UnionMount } from './types'
import { isWebDAVMount, isOpenListMount, isFTPMount } from './types'

interface MountBrowserProps {
  mount: UnionMount | null
  open: boolean
  onClose: () => void
  onSelectFile?: (path: string) => void
  selectable?: boolean
}

export default function MountBrowser({
  mount,
  open,
  onClose,
  onSelectFile,
  selectable = false,
}: MountBrowserProps) {
  if (mount && isWebDAVMount(mount)) {
    return (
      <WebDAVBrowser
        mountId={mount.id}
        open={open}
        onClose={onClose}
        onSelectFile={onSelectFile}
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
        onSelectFile={onSelectFile}
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
        onSelectFile={onSelectFile}
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
      onSelectFile={onSelectFile}
      selectable={selectable}
    />
  )
}

// 重新导出各类型，方便调用方使用
export type { WebDAVMount, OpenListMount, FTPMount }
