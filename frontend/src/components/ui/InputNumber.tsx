import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

export interface InputNumberProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'onChange'
> {
  label?: string
  error?: string
  min?: number
  max?: number
  onChange?: (value: number | undefined) => void
}

export const InputNumber = forwardRef<HTMLInputElement, InputNumberProps>(
  ({ label, error, min, max, onChange, className, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      if (value === '') {
        onChange?.(undefined)
        return
      }
      const num = Number(value)
      if (!Number.isNaN(num)) {
        let clamped = num
        if (min !== undefined && num < min) clamped = min
        if (max !== undefined && num > max) clamped = max
        onChange?.(clamped)
      }
    }

    return (
      <div className={cn('w-full text-left', className)}>
        {label && (
          <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
            {label}
          </label>
        )}
        <input
          ref={ref}
          type="number"
          min={min}
          max={max}
          className={cn(
            'w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)] disabled:cursor-not-allowed disabled:bg-[var(--md-sys-color-surface-container)] disabled:opacity-60',
            error &&
              'border-[var(--md-sys-color-error)] focus:border-[var(--md-sys-color-error)] focus:ring-[var(--md-sys-color-error)]'
          )}
          {...props}
          onChange={handleChange}
        />
        {error && (
          <p className="mt-1 text-xs text-[var(--md-sys-color-error)]">
            {error}
          </p>
        )}
      </div>
    )
  }
)

InputNumber.displayName = 'InputNumber'
