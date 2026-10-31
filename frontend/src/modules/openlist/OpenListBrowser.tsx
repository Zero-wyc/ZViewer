import MountBrowserBase from '@/modules/mounts/MountBrowserBase'
import { browseOpenListMount } from './openlistApi'
import type { OpenListDirectoryEntry } from './types'
import { t } from '@/i18n'

interface OpenListBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFiles?: (paths: string[]) => void
  selectable?: boolean
}

export default function OpenListBrowser({
  mountId,
  open,
  onClose,
  onSelectFiles,
}: OpenListBrowserProps) {
  return (
    <MountBrowserBase<OpenListDirectoryEntry>
      title={t('浏览 OpenList 目录')}
      mountId={mountId}
      open={open}
      onClose={onClose}
      onConfirm={(paths) => onSelectFiles?.(paths)}
      browse={browseOpenListMount}
    />
  )
}
