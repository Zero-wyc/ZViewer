import { Input } from '@/components/ui/Input'
import { Space } from '@/components/ui/Space'
import type { UnionMount } from '@/modules/mounts'
import type { FTPParams } from '@/modules/movie-source/resolveSource'
import { MountPicker, PathInput, SingleLineInput } from './shared'
import { t } from '@/i18n'

interface FtpSourceFormProps {
  mounts: UnionMount[]
  selectedMountId: string
  onMountSelect: (value: string) => void
  onBrowseMount: (mount: UnionMount) => void
  value: FTPParams
  onPatch: (patch: Partial<FTPParams>) => void
}

/** FTP 来源：挂载选择 + 手动填写主机/端口/账号/路径 */
export function FtpSourceForm({
  mounts,
  selectedMountId,
  onMountSelect,
  onBrowseMount,
  value,
  onPatch,
}: FtpSourceFormProps) {
  return (
    <Space direction="vertical" className="w-full" size="sm">
      <MountPicker
        label={t('使用已保存的 FTP 挂载')}
        mounts={mounts}
        type="ftp"
        selectedMountId={selectedMountId}
        onSelect={onMountSelect}
        onBrowse={onBrowseMount}
      />
      {!selectedMountId && (
        <>
          <SingleLineInput
            value={value.serverUrl}
            onChange={(serverUrl) => onPatch({ serverUrl })}
            placeholder={t('FTP 服务器地址，如 ftp.example.com')}
          />
          <Input
            size="sm"
            type="number"
            value={String(value.port)}
            onChange={(e) => onPatch({ port: Number(e.target.value) || 21 })}
            placeholder={t('端口，默认 21')}
          />
          <SingleLineInput
            value={value.username}
            onChange={(username) => onPatch({ username })}
            placeholder={t('用户名（可选）')}
          />
          <Input
            size="sm"
            type="password"
            value={value.password}
            onChange={(e) => onPatch({ password: e.target.value })}
            placeholder={t('密码（可选）')}
          />
        </>
      )}
      <PathInput
        value={value.path}
        onChange={(path) => onPatch({ path })}
        selectedMountId={selectedMountId}
      />
    </Space>
  )
}
