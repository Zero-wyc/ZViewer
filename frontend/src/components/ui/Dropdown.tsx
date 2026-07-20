import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface DropdownOption {
  label: string
  value: string | number
}

export interface DropdownProps {
  label?: string
  error?: string
  options: DropdownOption[]
  value?: string | number
  placeholder?: string
  disabled?: boolean
  className?: string
  onChange?: (value: string) => void
}

export function Dropdown({
  label,
  error,
  options,
  value,
  placeholder = '请选择',
  disabled = false,
  className,
  onChange,
}: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const selectedLabel = useMemo(() => {
    const found = options.find((opt) => String(opt.value) === String(value))
    return found?.label ?? placeholder
  }, [options, value, placeholder])

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPosition({
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width,
    })
  }, [])

  const closeMenu = useCallback(() => {
    if (!open) return
    setClosing(true)
    setTimeout(() => {
      setOpen(false)
      setClosing(false)
      setPosition(null)
    }, 160)
  }, [open])

  useEffect(() => {
    if (!open) return
    computePosition()
    const handler = () => computePosition()
    window.addEventListener('resize', handler)
    window.addEventListener('scroll', handler, true)
    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('scroll', handler, true)
    }
  }, [open, computePosition])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return
      }
      closeMenu()
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [open, closeMenu])

  const handleSelect = (opt: DropdownOption) => {
    onChange?.(String(opt.value))
    closeMenu()
  }

  return (
    <div className={cn('w-full text-left', className)}>
      {label && (
        <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
          {label}
        </label>
      )}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (open) {
            closeMenu()
          } else {
            setOpen(true)
            setClosing(false)
          }
        }}
        className={cn(
          'zen-input-glow w-full flex items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)] disabled:cursor-not-allowed disabled:bg-[var(--md-sys-color-surface-container)] disabled:opacity-60',
          'transition-all duration-200',
          'hover:border-[var(--md-sys-color-primary)] hover:shadow-sm',
          error &&
            'border-[var(--md-sys-color-error)] focus:border-[var(--md-sys-color-error)] focus:ring-[var(--md-sys-color-error)]'
        )}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-[var(--md-sys-color-on-surface-variant)] transition-transform duration-200',
            open && !closing && 'rotate-180'
          )}
        />
      </button>
      {error && (
        <p className="mt-1 text-xs text-[var(--md-sys-color-error)]">{error}</p>
      )}

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            className={cn(
              'glass-strong fixed max-h-72 overflow-auto rounded-[var(--md-sys-shape-corner)] p-1.5 shadow-lg',
              closing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
            )}
            style={{
              top: `${position.top}px`,
              left: `${position.left}px`,
              width: `${position.width}px`,
              zIndex: 60,
              boxShadow:
                '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
            }}
          >
            {options.map((opt) => {
              const active = String(opt.value) === String(value)
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleSelect(opt)}
                  className={cn(
                    'zen-dropdown-item flex w-full items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-left text-sm transition-all',
                    active
                      ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                      : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                  )}
                  style={{ '--item-delay': '0ms' } as React.CSSProperties}
                >
                  <span className="truncate">{opt.label}</span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}
