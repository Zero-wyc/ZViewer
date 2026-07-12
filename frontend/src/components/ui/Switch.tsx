import { cn } from '@/lib/utils'

export interface SwitchProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type'
> {
  label?: string
}

export function Switch({ label, className, checked, ...props }: SwitchProps) {
  return (
    <label
      className={cn('inline-flex cursor-pointer items-center gap-2', className)}
    >
      <div className="relative">
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          {...props}
        />
        <div
          className={cn(
            'h-5 w-9 rounded-full transition-colors',
            checked
              ? 'bg-[var(--md-sys-color-primary)]'
              : 'bg-[var(--md-sys-color-outline-variant)]'
          )}
        />
        <div
          className={cn(
            'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--md-sys-color-surface)] shadow-sm transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0'
          )}
        />
      </div>
      {label && (
        <span className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
          {label}
        </span>
      )}
    </label>
  )
}

Switch.displayName = 'Switch'
