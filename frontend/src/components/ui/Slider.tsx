import { forwardRef, useMemo, useState, useCallback } from 'react'
import { cn } from '@/lib/utils'

export interface SliderProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'onChange' | 'value' | 'size'
> {
  label?: string
  value?: number
  min?: number
  max?: number
  step?: number
  showValue?: boolean
  valueFormatter?: (value: number) => string
  onChange?: (value: number) => void
  size?: 'sm' | 'md'
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  (
    {
      label,
      value = 0,
      min = 0,
      max = 100,
      step = 1,
      showValue = true,
      valueFormatter,
      onChange,
      className,
      disabled,
      size = 'md',
      ...props
    },
    ref
  ) => {
    const [dragging, setDragging] = useState(false)
    const [hovering, setHovering] = useState(false)
    const clamped = Math.min(max, Math.max(min, value))
    const percent = useMemo(
      () => ((clamped - min) / (max - min)) * 100,
      [clamped, min, max]
    )

    const format = useCallback(
      (v: number) => {
        if (valueFormatter) return valueFormatter(v)
        return String(v)
      },
      [valueFormatter]
    )

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange?.(Number(e.target.value))
    }

    const isSm = size === 'sm'

    return (
      <div className={cn('w-full text-left', className)}>
        {(label || showValue) && (
          <div
            className={cn(
              'flex items-center justify-between text-[var(--md-sys-color-on-surface-variant)] transition-colors',
              isSm ? 'mb-1 text-[10px]' : 'mb-1.5 text-xs',
              (dragging || hovering) && 'text-[var(--md-sys-color-primary)]'
            )}
          >
            {label && <span>{label}</span>}
            {showValue && (
              <span
                className={cn(
                  'tabular-nums transition-transform',
                  dragging && 'scale-110'
                )}
              >
                {format(clamped)}
              </span>
            )}
          </div>
        )}
        <div
          className={cn('relative flex items-center', isSm ? 'h-4' : 'h-5')}
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => setHovering(false)}
        >
          <div
            className={cn(
              'absolute w-full rounded-full transition-colors duration-200',
              isSm ? 'h-1' : 'h-1.5'
            )}
            style={{
              backgroundColor: hovering
                ? 'color-mix(in srgb, var(--md-sys-color-on-surface) 16%, transparent)'
                : 'color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent)',
            }}
          />
          <div
            className={cn(
              'absolute rounded-full transition-all duration-150',
              isSm ? 'h-1' : 'h-1.5'
            )}
            style={{
              width: `${percent}%`,
              backgroundColor: 'var(--md-sys-color-primary)',
              boxShadow:
                dragging || hovering
                  ? '0 0 8px color-mix(in srgb, var(--md-sys-color-primary) 50%, transparent)'
                  : 'none',
            }}
          />
          <input
            ref={ref}
            type="range"
            min={min}
            max={max}
            step={step}
            value={clamped}
            disabled={disabled}
            onChange={handleChange}
            onMouseDown={() => setDragging(true)}
            onMouseUp={() => setDragging(false)}
            onMouseLeave={() => setDragging(false)}
            onTouchStart={() => setDragging(true)}
            onTouchEnd={() => setDragging(false)}
            className={cn(
              'absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0',
              disabled && 'cursor-not-allowed'
            )}
            {...props}
          />
          <div
            className={cn(
              'pointer-events-none absolute rounded-full border-2 shadow transition-all duration-200',
              isSm ? 'h-3 w-3' : 'h-4 w-4',
              'bg-[var(--md-sys-color-primary)] border-[var(--md-sys-color-primary)]'
            )}
            style={{
              left: `${percent}%`,
              transform: `translateX(-50%) scale(${dragging ? 1.3 : hovering ? 1.1 : 1})`,
              boxShadow:
                dragging || hovering
                  ? '0 0 0 4px color-mix(in srgb, var(--md-sys-color-primary) 20%, transparent), 0 0 12px color-mix(in srgb, var(--md-sys-color-primary) 50%, transparent)'
                  : 'none',
            }}
          />
        </div>
      </div>
    )
  }
)

Slider.displayName = 'Slider'
