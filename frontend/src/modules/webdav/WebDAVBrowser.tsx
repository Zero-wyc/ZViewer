import MountBrowserBase from '@/modules/mounts/MountBrowserBase'
import { browseWebDAVMount } from './webdavApi'
import type { WebDAVDirectoryEntry } from './types'
import { t } from '@/i18n'

interface WebDAVBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFiles?: (paths: string[]) => void
  selectable?: boolean
}

export default function WebDAVBrowser({
  mountId,
  open,
  onClose,
  onSelectFiles,
}: WebDAVBrowserProps) {
  return (
    <MountBrowserBase<WebDAVDirectoryEntry>
      title={t('浏览 WebDAV 目录')}
      mountId={mountId}
      open={open}
      onClose={onClose}
      onConfirm={(paths) => onSelectFiles?.(paths)}
      browse={browseWebDAVMount}
    />
  )
}
