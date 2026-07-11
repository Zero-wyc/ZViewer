import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'size'
> {
  label?: string
  error?: string
  size?: 'sm' | 'md' | 'lg'
  variant?: 'filled' | 'outlined'
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, size = 'md', variant = 'outlined', className, ...props }, ref) => {
    const sizes = {
      sm: 'px-2.5 py-1.5 text-xs',
      md: 'px-3 py-2 text-sm',
      lg: 'px-4 py-3 text-base',
    }

    const variants = {
      outlined:
        'border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] focus:border-[var(--md-sys-color-primary)] focus:ring-1 focus:ring-[var(--md-sys-color-primary)]',
      filled:
        'border-0 border-b border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-highest)] rounded-b-none focus:border-b-2 focus:border-[var(--md-sys-color-primary)] focus:ring-0',
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
          className={cn(
            'w-full rounded-[var(--md-sys-shape-corner)] text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:outline-none disabled:cursor-not-allowed disabled:bg-[var(--md-sys-color-surface-container)] disabled:opacity-60',
            sizes[size],
            variants[variant],
            error && 'border-[var(--md-sys-color-error)] focus:border-[var(--md-sys-color-error)] focus:ring-[var(--md-sys-color-error)]'
          )}
          {...props}
        />
        {error && <p className="mt-1 text-xs text-[var(--md-sys-color-error)]">{error}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
