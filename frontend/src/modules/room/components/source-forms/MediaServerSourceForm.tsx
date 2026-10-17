import { Clapperboard } from 'lucide-react'
import { Space } from '@/components/ui/Space'
import { Text } from '@/components/ui/Typography'
import type { UnionMount } from '@/modules/mounts'
import { MountPicker, PlaybackModeField, SingleLineInput } from './shared'

type MediaServerName = 'Emby' | 'Jellyfin'

interface MediaServerSourceFormProps {
  name: MediaServerName
  mounts: UnionMount[]
  selectedMountId: string
  onMountSelect: (value: string) => void
  onBrowseMount: (mount: UnionMount) => void
  /** 手动粘贴 itemId（一般通过媒体库浏览选择） */
  url: string
  onChangeUrl: (value: string) => void
  onAdd: () => void
  directLink: boolean
  onChangeDirectLink: (directLink: boolean) => void
}

/**
 * Emby / Jellyfin 共用的媒体服务器表单。
 * 两者字段、交互、提示文案完全同构，仅服务名不同。
 */
export function MediaServerSourceForm({
  name,
  mounts,
  selectedMountId,
  onMountSelect,
  onBrowseMount,
  url,
  onChangeUrl,
  onAdd,
  directLink,
  onChangeDirectLink,
}: MediaServerSourceFormProps) {
  return (
    <Space direction="vertical" className="w-full" size="sm">
      <MountPicker
        label={`使用已保存的 ${name} 挂载`}
        mounts={mounts}
        type={name === 'Emby' ? 'emby' : 'jellyfin'}
        selectedMountId={selectedMountId}
        onSelect={onMountSelect}
        onBrowse={onBrowseMount}
        browseLabel={`浏览 ${name} 媒体库`}
        browseIcon={<Clapperboard className="h-4 w-4" />}
      />
      {!selectedMountId && (
        <SingleLineInput
          value={url}
          onChange={onChangeUrl}
          placeholder={`粘贴 ${name} itemId（可选，一般通过浏览选择）`}
          onEnter={onAdd}
        />
      )}
      <PlaybackModeField
        directLink={directLink}
        onChange={onChangeDirectLink}
      />
      <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
        {selectedMountId
          ? `已选择挂载，点击「浏览 ${name} 媒体库」逐级选择电影 / 剧集，多选模式可批量添加。`
          : `选择挂载后点击「浏览 ${name} 媒体库」逐级选择电影 / 剧集，多选模式可批量添加。服务器转发由本服务中转（跨域/防盗链友好）；直链直连由浏览器直接访问 ${name} 服务器。`}
      </Text>
    </Space>
  )
}
