import { useState } from 'react'
import { Check, Link2, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { t } from '@/i18n'
import { cn, formatFileSize } from '@/lib/utils'
import type { Live2DModelEntry } from '../core/model-catalog'
import { validateModelUrl } from '../core/model-url'
import {
  LIVE2D_LIBRARY_MAX_PER_OWNER,
  LIVE2D_LIBRARY_MAX_TOTAL,
  type Live2DLibraryEntry,
} from '../core/model-library'
import type { Live2DModelKind } from '../types'

// 模型来源选择：本服模型（随包 + 服务端上传库）、自定义地址，两段平铺。
//
// 为什么把「内置模型」和「模型库」合成一段：从用户角度看，这两者都是"这个
// 服务器上能选的角色"，区别只在于谁把文件放进来的（部署时随包 vs 有人上传）。
// 分成两个列表会让人以为它们是两种东西，而实际上选哪个效果完全一样——协议里
// 的 kind 仍然分成 builtin/room，那只是数据出处，不该漏到界面上。
//
// 不用 Tab：切 Tab 就要维护「当前 Tab」状态，而当前选中项可能来自任意一段
// （比如统一模型是房主在别的面板里选的），同步逻辑只会带来闪烁。平铺之后
// 用户一眼能看到全部可选的角色，点谁是谁。
//
// 上传与删除也在这里，而不是在设置面板里另开一段列表：那样同一个模型会在
// 界面上出现两次（一次用来选、一次用来删），是两个入口在描述同一份数据。

export interface ModelPickerValue {
  kind: Live2DModelKind
  id: string
}

export interface Live2DModelPickerProps {
  builtins: Live2DModelEntry[]
  libraryModels: Live2DLibraryEntry[]
  value: ModelPickerValue
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  /** 房主才能填自定义地址（外链会让每个人的浏览器都去拉第三方资源） */
  allowUrl: boolean
  disabled?: boolean
  /** 上传入口：只有登录用户能传，不传这个 prop 就不显示按钮 */
  upload?: { uploading: boolean; onUpload: (file: File) => void }
  /** 当前用户有权删除的模型 id（服务端下发的 deletable）；为空则没有管理入口 */
  removableIds?: string[]
  onDeleteModel?: (modelId: string) => void
}

export function Live2DModelPicker({
  builtins,
  libraryModels,
  value,
  onSelect,
  allowUrl,
  disabled = false,
  upload,
  removableIds,
  onDeleteModel,
}: Live2DModelPickerProps) {
  // 管理态是纯本机的临时视图，不进任何 store：它只决定"能不能删"，与选了
  // 哪个模型无关。
  const [managing, setManaging] = useState(false)
  const removable = new Set(removableIds ?? [])
  const canManage = removable.size > 0 && Boolean(onDeleteModel)
  const activeManaging = managing && canManage

  const items: ChipItem[] = [
    ...builtins.map((item) => ({
      kind: 'builtin' as Live2DModelKind,
      id: item.id,
      label: item.label,
      removable: false,
      bytes: 0,
    })),
    ...libraryModels.map((item) => ({
      kind: 'room' as Live2DModelKind,
      id: item.id,
      label: item.label,
      removable: removable.has(item.id),
      bytes: item.bytes,
    })),
  ]

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-[10px] uppercase tracking-wide opacity-55">
            {t('本服模型')}
          </p>
          <div className="flex items-center gap-1">
            {canManage && (
              <ToolButton onClick={() => setManaging((prev) => !prev)}>
                {activeManaging ? t('结束管理') : t('管理')}
              </ToolButton>
            )}
            {upload && (
              <UploadButton
                uploading={upload.uploading}
                onUpload={upload.onUpload}
                // 配额只在 title 里说：真正超了由服务端拒绝并给出具体原因，
                // 界面上常驻一行"每人 8 个"只会占地方。
                title={t('每人最多 {{perOwner}} 个，全库最多 {{total}} 个', {
                  perOwner: LIVE2D_LIBRARY_MAX_PER_OWNER,
                  total: LIVE2D_LIBRARY_MAX_TOTAL,
                })}
              />
            )}
          </div>
        </div>

        {items.length > 0 ? (
          <Chips
            items={items}
            value={value}
            onSelect={onSelect}
            disabled={disabled}
            managing={activeManaging}
            onDelete={onDeleteModel}
          />
        ) : (
          <Hint>
            {/* 只说现状，不给做不到的承诺：游客不能上传，能不能传由传不传
                upload 这个 prop 决定（真的能传时按钮就在上面）。 */}
            {upload
              ? t('还没有可用的模型，上传一个模型包就能开始')
              : t('还没有可用的模型，等房主或别人上传一个')}
          </Hint>
        )}

        {activeManaging && (
          <Hint>
            {t('点模型右侧的删除按钮可以删掉它，正在使用的人会退回默认角色')}
          </Hint>
        )}
      </div>

      {allowUrl && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide opacity-55">
            {t('自定义模型地址')}
          </p>
          <UrlRow value={value} onSelect={onSelect} disabled={disabled} />
        </div>
      )}
    </div>
  )
}

function UrlRow({
  value,
  onSelect,
  disabled,
}: {
  value: ModelPickerValue
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  disabled: boolean
}) {
  const [url, setUrl] = useState(value.kind === 'url' ? value.id : '')
  const [error, setError] = useState('')

  const apply = () => {
    const problem = validateModelUrl(url)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    onSelect('url', url.trim())
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply()
          }}
          placeholder="https://…/model3.json"
          disabled={disabled}
          size="sm"
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          onClick={apply}
          disabled={disabled}
          aria-label={t('应用地址')}
          title={t('应用地址')}
        >
          <Link2 size={13} />
        </Button>
      </div>
      {error && (
        <p
          className="mt-1 text-[10px]"
          style={{ color: 'var(--md-sys-color-error)' }}
        >
          {error}
        </p>
      )}
    </div>
  )
}

function UploadButton({
  uploading,
  onUpload,
  title,
}: {
  uploading: boolean
  onUpload: (file: File) => void
  title?: string
}) {
  // input 无法美化，藏起来由 label 触发；value 每次都要清空，否则同一个文件
  // 连选两次不会触发 change。
  return (
    <label
      title={title}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-opacity',
        uploading ? 'cursor-not-allowed opacity-55' : 'hover:opacity-80'
      )}
      style={{
        background: 'var(--md-sys-color-surface)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      <Upload size={11} />
      {uploading ? t('上传中…') : t('上传')}
      <input
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        disabled={uploading}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) onUpload(file)
        }}
      />
    </label>
  )
}

function ToolButton({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border px-1.5 py-0.5 text-[10px] transition-opacity hover:opacity-80"
      style={{
        background: 'var(--md-sys-color-surface)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      {children}
    </button>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-[11px] leading-relaxed opacity-60">{children}</p>
  )
}

interface ChipItem {
  kind: Live2DModelKind
  id: string
  label: string
  /** 这个条目在管理态下能不能删（只有服务端说 deletable 的才行） */
  removable: boolean
  /** 大小（服务端已下发），管理态下显示，便于挑出占地方的那个 */
  bytes: number
}

function Chips({
  items,
  value,
  onSelect,
  disabled,
  managing,
  onDelete,
}: {
  items: ChipItem[]
  value: ModelPickerValue
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  disabled: boolean
  managing: boolean
  onDelete?: (modelId: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {items.map((item) => {
        const active = value.kind === item.kind && value.id === item.id
        const deleting = managing && item.removable && Boolean(onDelete)
        const chip = (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(item.kind, item.id)}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-between gap-1 rounded-lg border px-2 py-1.5 text-left text-[11px] transition-colors',
              disabled ? 'cursor-not-allowed opacity-60' : 'hover:opacity-90'
            )}
            style={{
              background: active
                ? 'color-mix(in srgb, var(--md-sys-color-primary) 12%, var(--md-sys-color-surface))'
                : 'var(--md-sys-color-surface)',
              borderColor: active
                ? 'var(--md-sys-color-primary)'
                : 'var(--md-sys-color-outline-variant)',
              color: active
                ? 'var(--md-sys-color-primary)'
                : 'var(--md-sys-color-on-surface)',
            }}
          >
            <span className="truncate">{item.label}</span>
            {deleting ? (
              // 管理态显示大小：这一段就是为了"哪个模型占地方、要不要删"
              <span className="shrink-0 text-[9px] tabular-nums opacity-55">
                {item.bytes > 0 ? formatFileSize(item.bytes) : ''}
              </span>
            ) : (
              active && <Check size={12} className="shrink-0" />
            )}
          </button>
        )

        if (!deleting) {
          return <div key={`${item.kind}:${item.id}`}>{chip}</div>
        }

        return (
          <div
            key={`${item.kind}:${item.id}`}
            className="flex min-w-0 items-stretch gap-1"
          >
            {chip}
            <button
              type="button"
              onClick={() => onDelete?.(item.id)}
              aria-label={t('删除该模型')}
              title={t('删除该模型')}
              className="shrink-0 rounded-lg border px-1.5 transition-opacity hover:opacity-80"
              style={{
                background: 'var(--md-sys-color-surface)',
                borderColor: 'var(--md-sys-color-outline-variant)',
                color: 'var(--md-sys-color-error)',
              }}
            >
              <Trash2 size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
