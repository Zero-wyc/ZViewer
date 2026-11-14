import { useState } from 'react'
import { t } from '@/i18n'
import { Check, Link2, X } from 'lucide-react'
import type { Live2DModelEntry } from '../core/model-catalog'
import { validateModelUrl } from '../core/model-url'
import type { Live2DModelKind } from '../types'

// 角色面板：选模型、房主填 URL、调大小。
//
// 位置与样式服从房间页的玻璃语言（--glass-* + --md-sys-color-*），
// 但**不加 backdrop-filter**：宿主的定位靠绝对/固定定位，一旦祖先有 filter
// 就会创建包含块，内层定位全部失效。

export interface Live2DControlPanelProps {
  builtins: Live2DModelEntry[]
  myKind: Live2DModelKind
  myModelId: string
  myScale: number
  isHost: boolean
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  onScale: (scale: number) => void
  onClose: () => void
}

export function Live2DControlPanel({
  builtins,
  myKind,
  myModelId,
  myScale,
  isHost,
  onSelect,
  onScale,
  onClose,
}: Live2DControlPanelProps) {
  const [url, setUrl] = useState(myKind === 'url' ? myModelId : '')
  const [error, setError] = useState<string | null>(null)

  const applyUrl = () => {
    const problem = validateModelUrl(url)
    if (problem) {
      setError(t(problem))
      return
    }
    setError(null)
    onSelect('url', url.trim())
  }

  return (
    <div
      className="pointer-events-auto w-64 rounded-xl border p-3 shadow-lg"
      style={{
        background: 'var(--glass-bg)',
        borderColor: 'var(--glass-border)',
        color: 'var(--md-sys-color-on-surface)',
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">{t('角色')}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('关闭')}
          className="rounded-md p-1 opacity-70 hover:opacity-100"
        >
          <X size={14} />
        </button>
      </div>

      {builtins.length === 0 ? (
        <p className="mb-2 text-[11px] leading-relaxed opacity-70">
          {t('还没有内置模型，可先用下面的地址加载一个')}
        </p>
      ) : (
        <div className="mb-2 grid grid-cols-2 gap-1.5">
          {builtins.map((item) => {
            const active = myKind === 'builtin' && myModelId === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect('builtin', item.id)}
                className="flex items-center justify-between gap-1 rounded-lg border px-2 py-1.5 text-[11px] transition-colors"
                style={{
                  background: 'var(--md-sys-color-surface)',
                  borderColor: active
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline-variant)',
                }}
              >
                <span className="truncate">{item.label}</span>
                {active && (
                  <Check
                    size={12}
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                )}
              </button>
            )
          })}
        </div>
      )}

      {isHost && (
        <div className="mb-2">
          <label className="mb-1 block text-[10px] uppercase tracking-wide opacity-60">
            {t('自定义模型地址')}
          </label>
          <div className="flex items-center gap-1">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…/model3.json"
              className="min-w-0 flex-1 rounded-md border px-2 py-1 text-[11px] outline-none"
              style={{
                background: 'var(--md-sys-color-surface)',
                borderColor: 'var(--md-sys-color-outline-variant)',
                color: 'var(--md-sys-color-on-surface)',
              }}
            />
            <button
              type="button"
              onClick={applyUrl}
              aria-label={t('应用地址')}
              className="shrink-0 rounded-md border p-1"
              style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
            >
              <Link2 size={13} />
            </button>
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
      )}

      <label className="block text-[10px] uppercase tracking-wide opacity-60">
        {t('大小')}
      </label>
      <input
        type="range"
        min={0.5}
        max={2}
        step={0.1}
        value={myScale}
        onChange={(event) => onScale(Number(event.target.value))}
        className="mt-1 w-full"
        aria-label={t('模型大小')}
      />
    </div>
  )
}
