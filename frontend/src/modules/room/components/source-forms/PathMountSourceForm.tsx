import { Space } from '@/components/ui/Space'
import type { UnionMount } from '@/modules/mounts'
import {
  DirectTransferField,
  InternalNotice,
  MountPicker,
  PathInput,
  PlaybackModeField,
  SingleLineInput,
} from './shared'

interface PathMountSourceFormProps {
  /** 挂载类型决定「已保存挂载」列表的过滤口径 */
  mountType: 'webdav' | 'openlist'
  /** 挂载选择器标题 */
  mountLabel: string
  /** 服务器地址占位文案 */
  serverPlaceholder: string
  mounts: UnionMount[]
  selectedMountId: string
  onMountSelect: (value: string) => void
  onBrowseMount: (mount: UnionMount) => void
  value: { serverUrl: string; path: string }
  onPatch: (patch: Partial<{ serverUrl: string; path: string }>) => void
  /** 路径回车提交（仅 OpenList 支持，保持既有交互差异） */
  onSubmitPath?: () => void
  directLink: boolean
  onChangeDirectLink: (directLink: boolean) => void
  directLinkProxy: boolean
  onChangeDirectLinkProxy: (proxy: boolean) => void
  /** 内网地址：强制服务器转发 */
  isInternal: boolean
}

/**
 * WebDAV / OpenList 共用的路径型挂载表单。
 * 两者字段与交互完全一致，仅标题文案与是否支持回车提交不同。
 */
export function PathMountSourceForm({
  mountType,
  mountLabel,
  serverPlaceholder,
  mounts,
  selectedMountId,
  onMountSelect,
  onBrowseMount,
  value,
  onPatch,
  onSubmitPath,
  directLink,
  onChangeDirectLink,
  directLinkProxy,
  onChangeDirectLinkProxy,
  isInternal,
}: PathMountSourceFormProps) {
  return (
    <Space direction="vertical" className="w-full" size="sm">
      <MountPicker
        label={mountLabel}
        mounts={mounts}
        type={mountType}
        selectedMountId={selectedMountId}
        onSelect={onMountSelect}
        onBrowse={onBrowseMount}
      />
      {!selectedMountId && (
        <SingleLineInput
          value={value.serverUrl}
          onChange={(serverUrl) => onPatch({ serverUrl })}
          placeholder={serverPlaceholder}
        />
      )}
      <PathInput
        value={value.path}
        onChange={(path) => onPatch({ path })}
        selectedMountId={selectedMountId}
        onEnter={onSubmitPath}
      />
      <PlaybackModeField
        directLink={directLink}
        onChange={onChangeDirectLink}
        directDisabled={isInternal}
      />
      {directLink && !isInternal && (
        <DirectTransferField
          proxy={directLinkProxy}
          onChange={onChangeDirectLinkProxy}
        />
      )}
      {isInternal && <InternalNotice />}
    </Space>
  )
}
