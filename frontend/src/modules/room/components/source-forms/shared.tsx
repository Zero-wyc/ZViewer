/**
 * 添加影片面板的表单原语。
 *
 * 各来源表单（WebDAV / FTP / OpenList / Emby / Jellyfin / …）在交互上高度重合：
 * 挂载选择 + 路径输入 + 播放方式（服务器转发 / 直链直连）+ 内网地址提示。
 * 这些块在此统一实现，避免 10 个来源各写一遍。
 */
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Dropdown, type DropdownOption } from '@/components/ui/Dropdown'
import { Text } from '@/components/ui/Typography'
import type { MountType, UnionMount } from '@/modules/mounts'
import { normalizeMountPath } from './utils'
import { t } from '@/i18n'

/** 挂载下拉选项：首项固定为「手动填写」（value=''） */
function buildMountOptions(
  mounts: UnionMount[],
  type: MountType
): DropdownOption[] {
  return [
    { value: '', label: t('手动填写') },
    ...mounts
      .filter((m) => m.type === type)
      .map((m) => ({ value: String(m.id), label: m.name })),
  ]
}

interface MountPickerProps {
  /** 下拉标题，如「使用已保存的 WebDAV 挂载」 */
  label: string
  mounts: UnionMount[]
  type: MountType
  selectedMountId: string
  onSelect: (value: string) => void
  onBrowse: (mount: UnionMount) => void
  /** 已选挂载时显示的浏览按钮文案 */
  browseLabel?: string
  browseIcon?: ReactNode
}

/** 已保存挂载选择器 + 「浏览文件」按钮（仅已选挂载时出现） */
export function MountPicker({
  label,
  mounts,
  type,
  selectedMountId,
  onSelect,
  onBrowse,
  browseLabel = t('浏览文件'),
  browseIcon,
}: MountPickerProps) {
  return (
    <>
      <Dropdown
        label={label}
        value={selectedMountId}
        options={buildMountOptions(mounts, type)}
        onChange={onSelect}
      />
      {selectedMountId && (
        <Button
          variant="secondary"
          size="sm"
          icon={browseIcon}
          onClick={() => {
            const mount = mounts.find((m) => m.id === Number(selectedMountId))
            if (mount) onBrowse(mount)
          }}
        >
          {browseLabel}
        </Button>
      )}
    </>
  )
}

interface SingleLineInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** 回车提交（Shift+Enter 不触发，保留换行语义） */
  onEnter?: () => void
  /** 输入即按挂载路径规范化（路径类输入使用） */
  normalizePath?: boolean
}

/** 单行输入：统一回车提交与路径规范化口径 */
export function SingleLineInput({
  value,
  onChange,
  placeholder,
  onEnter,
  normalizePath = false,
}: SingleLineInputProps) {
  return (
    <Input
      size="sm"
      value={value}
      onChange={(e) =>
        onChange(
          normalizePath ? normalizeMountPath(e.target.value) : e.target.value
        )
      }
      placeholder={placeholder}
      onKeyDown={
        onEnter
          ? (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onEnter()
              }
            }
          : undefined
      }
    />
  )
}

interface PathInputProps {
  value: string
  onChange: (value: string) => void
  /** 已选挂载时占位文案切换为「留空可从挂载根目录浏览」 */
  selectedMountId: string
  onEnter?: () => void
}

/** 挂载文件路径输入（占位文案随「是否已选挂载」变化） */
export function PathInput({
  value,
  onChange,
  selectedMountId,
  onEnter,
}: PathInputProps) {
  return (
    <SingleLineInput
      value={value}
      onChange={onChange}
      normalizePath
      onEnter={onEnter}
      placeholder={
        selectedMountId
          ? t('文件路径（已选挂载，留空可从挂载根目录浏览）')
          : t('文件路径，如 /movies/video.mp4')
      }
    />
  )
}

interface PlaybackModeFieldProps {
  /** true=直链直连，false=服务器转发 */
  directLink: boolean
  onChange: (directLink: boolean) => void
  /** 内网地址：浏览器无法直连，禁用「直链直连」选项 */
  directDisabled?: boolean
}

/** 播放方式：服务器转发 / 直链直连 */
export function PlaybackModeField({
  directLink,
  onChange,
  directDisabled = false,
}: PlaybackModeFieldProps) {
  return (
    <Dropdown
      label={t('播放方式')}
      value={directLink && !directDisabled ? 'direct' : 'proxy'}
      options={[
        { value: 'proxy', label: t('服务器转发') },
        { value: 'direct', label: t('直链直连'), disabled: directDisabled },
      ]}
      onChange={(value) => onChange(value === 'direct')}
    />
  )
}

interface PathPlaybackModeFieldProps {
  /** true=直链直连，false=服务器转发 */
  directLink: boolean
  onChangeDirectLink: (directLink: boolean) => void
  /** 内网地址：浏览器无法直连，仅允许「服务器转发」 */
  directDisabled?: boolean
}

/**
 * 路径型挂载（WebDAV / OpenList）的播放方式二选一。
 * - 服务器转发：resolve 返回代理流 URL，媒体由服务器实时读取挂载文件
 * - 直链直连：挂载直链解析，浏览器直接访问挂载服务器，失败不回退
 */
export function PathPlaybackModeField({
  directLink,
  onChangeDirectLink,
  directDisabled = false,
}: PathPlaybackModeFieldProps) {
  const value = directDisabled ? 'proxy' : directLink ? 'direct' : 'proxy'
  return (
    <>
      <Dropdown
        label={t('播放方式')}
        value={value}
        options={[
          {
            value: 'direct',
            label: t('直链直连（浏览器直接访问挂载服务器）'),
            disabled: directDisabled,
          },
          { value: 'proxy', label: t('服务器转发（服务器读取挂载流）') },
        ]}
        onChange={(next) => onChangeDirectLink(next === 'direct')}
      />
      {directDisabled && <InternalNotice />}
    </>
  )
}

/** 内网地址提示：已强制服务器转发 */
export function InternalNotice() {
  return (
    <div className="rounded border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
      {t('检测到内网地址，浏览器无法直连，已强制使用服务器转发模式')}
    </div>
  )
}

/** 订阅源/说明卡片（ani-subs / Kazumi 等无表单字段的来源） */
export function SourceHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)] p-3">
      <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
        {children}
      </Text>
    </div>
  )
}
