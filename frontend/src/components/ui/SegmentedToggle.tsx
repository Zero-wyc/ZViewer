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
  return (
    <div
      className={cn(
        'glass-strong flex items-center gap-1 rounded-full p-1 shadow-lg',
        'border border-[var(--md-sys-color-outline)] ring-1 ring-[var(--md-sys-color-outline-variant)]/40',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
      role="group"
      aria-disabled={disabled}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled || isActive}
            aria-pressed={isActive}
            className={cn(
              'rounded-full px-4 py-1.5 text-xs font-medium transition-all',
              isActive
                ? 'shadow-md ring-1 ring-[var(--md-sys-color-outline-variant)]'
                : 'hover:bg-[var(--md-sys-color-surface-container-high)]'
            )}
            style={
              isActive
                ? {
                    backgroundColor: 'var(--md-sys-color-primary)',
                    color: 'var(--md-sys-color-on-primary)',
                  }
                : { color: 'var(--md-sys-color-on-surface-variant)' }
            }
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
