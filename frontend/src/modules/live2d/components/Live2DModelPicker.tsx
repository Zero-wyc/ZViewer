import { useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { t } from '@/i18n'
import { cn } from '@/lib/utils'
import type { Live2DModelEntry } from '../core/model-catalog'
import { validateModelUrl } from '../core/model-url'
import type { RoomModelEntry } from '../core/room-models'
import type { Live2DModelKind } from '../types'

// 模型来源选择：内置 / 房间模型库 / 自定义地址，三段平铺。
//
// 不用 Tab：切 Tab 就要维护「当前 Tab」状态，而当前选中项可能来自任意一段
// （比如统一模型是房主在别的面板里选的），同步逻辑只会带来闪烁。平铺之后
// 用户一眼能看到全部可选的角色，点谁是谁。

export interface ModelPickerValue {
  kind: Live2DModelKind
  id: string
}

export interface Live2DModelPickerProps {
  builtins: Live2DModelEntry[]
  roomModels: RoomModelEntry[]
  value: ModelPickerValue
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  /** 房主才能填自定义地址（外链会让每个人的浏览器都去拉第三方资源） */
  allowUrl: boolean
  disabled?: boolean
  /** 紧凑模式（右键菜单）：不显示地址输入、空态文案更短 */
  compact?: boolean
}

export function Live2DModelPicker({
  builtins,
  roomModels,
  value,
  onSelect,
  allowUrl,
  disabled = false,
  compact = false,
}: Live2DModelPickerProps) {
  return (
    <div className={cn('flex flex-col', compact ? 'gap-2' : 'gap-3')}>
      <Group label={t('内置模型')}>
        {builtins.length > 0 ? (
          <Chips
            items={builtins.map((item) => ({
              kind: 'builtin' as Live2DModelKind,
              id: item.id,
              label: item.label,
            }))}
            value={value}
            onSelect={onSelect}
            disabled={disabled}
          />
        ) : (
          <Hint>
            {compact
              ? t('还没有内置模型')
              : t('还没有内置模型，可以上传一个模型包，或填写下面的地址')}
          </Hint>
        )}
      </Group>

      {roomModels.length > 0 && (
        <Group label={t('房间模型')}>
          <Chips
            items={roomModels.map((item) => ({
              kind: 'room' as Live2DModelKind,
              id: item.id,
              label: item.label,
            }))}
            value={value}
            onSelect={onSelect}
            disabled={disabled}
          />
        </Group>
      )}

      {!compact && allowUrl && (
        <Group label={t('自定义模型地址')}>
          <UrlRow value={value} onSelect={onSelect} disabled={disabled} />
        </Group>
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

function Group({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1 text-[10px] uppercase tracking-wide opacity-55">
        {label}
      </p>
      {children}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-relaxed opacity-60">{children}</p>
}

interface ChipItem {
  kind: Live2DModelKind
  id: string
  label: string
}

function Chips({
  items,
  value,
  onSelect,
  disabled,
}: {
  items: ChipItem[]
  value: ModelPickerValue
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  disabled: boolean
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {items.map((item) => {
        const active = value.kind === item.kind && value.id === item.id
        return (
          <button
            key={`${item.kind}:${item.id}`}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(item.kind, item.id)}
            className={cn(
              'flex items-center justify-between gap-1 rounded-lg border px-2 py-1.5 text-left text-[11px] transition-colors',
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
            {active && <Check size={12} className="shrink-0" />}
          </button>
        )
      })}
    </div>
  )
}
