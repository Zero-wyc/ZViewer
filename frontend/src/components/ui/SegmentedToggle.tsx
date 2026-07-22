import { useRef, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export interface SegmentedToggleOption {
  value: string
  label: string
}

export interface SegmentedToggleProps {
  options: SegmentedToggleOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

export function SegmentedToggle({
  options,
  value,
  onChange,
  disabled = false,
  className,
}: SegmentedToggleProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [indicatorStyle, setIndicatorStyle] = useState<{
    left: number
    width: number
  }>({
    left: 0,
    width: 0,
  })

  useEffect(() => {
    if (!containerRef.current) return
    const activeIndex = options.findIndex((o) => o.value === value)
    if (activeIndex < 0) return
    const buttons = containerRef.current.querySelectorAll(
      'button[data-segment]'
    )
    const activeBtn = buttons[activeIndex] as HTMLElement | undefined
    if (activeBtn) {
      setIndicatorStyle({
        left: activeBtn.offsetLeft,
        width: activeBtn.offsetWidth,
      })
    }
  }, [value, options])

  return (
    <div
      ref={containerRef}
      className={cn(
        'glass-strong relative flex items-center gap-1 rounded-full p-1 shadow-lg',
        'border border-[var(--md-sys-color-outline)] ring-1 ring-[var(--md-sys-color-outline-variant)]/40',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
      role="group"
      aria-disabled={disabled}
    >
      {/* 滑动指示器（带光晕） */}
      <div
        className="absolute top-1 bottom-1 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)] shadow-md ring-1 ring-[var(--md-sys-color-outline-variant)]"
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          backgroundColor: 'var(--md-sys-color-primary)',
          boxShadow:
            '0 2px 8px -1px color-mix(in srgb, var(--md-sys-color-primary) 40%, transparent), 0 0 12px color-mix(in srgb, var(--md-sys-color-primary) 30%, transparent)',
        }}
      />

      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            data-segment={option.value}
            onClick={() => onChange(option.value)}
            disabled={disabled || isActive}
            aria-pressed={isActive}
            className={cn(
              'relative z-10 rounded-full px-4 py-1.5 text-xs font-medium transition-all duration-300',
              isActive
                ? 'text-[var(--md-sys-color-on-primary)]'
                : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)]/50 hover:scale-105'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
