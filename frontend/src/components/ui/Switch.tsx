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
      <div className="relative group">
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          {...props}
        />
        <div
          className={cn(
            'h-5 w-9 rounded-full transition-all duration-300',
            checked
              ? 'bg-[var(--md-sys-color-primary)]'
              : 'bg-[var(--md-sys-color-outline-variant)]'
          )}
          style={{
            boxShadow: checked
              ? '0 0 0 0 color-mix(in srgb, var(--md-sys-color-primary) 30%, transparent), 0 2px 6px -1px color-mix(in srgb, var(--md-sys-color-primary) 35%, transparent)'
              : 'inset 0 1px 2px rgba(0,0,0,0.08)',
          }}
        />
        <div
          className={cn(
            'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--md-sys-color-surface)] shadow-sm',
            checked ? 'zen-switch-knob-on' : 'zen-switch-knob-off'
          )}
          style={{ '--switch-travel': '16px' } as React.CSSProperties}
        />
      </div>
      {label && (
        <span className="text-sm text-[var(--md-sys-color-on-surface-variant)] transition-colors group-hover:text-[var(--md-sys-color-on-surface)]">
          {label}
        </span>
      )}
    </label>
  )
}

Switch.displayName = 'Switch'
