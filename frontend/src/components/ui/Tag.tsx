import { cn } from '@/lib/utils'

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  color?:
    'default' | 'primary' | 'success' | 'warning' | 'danger' | 'cyan' | 'purple'
  children: React.ReactNode
}

export function Tag({
  children,
  color = 'default',
  className,
  style,
  ...props
}: TagProps) {
  const colors = {
    default:
      'bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)] border-[var(--md-sys-color-outline)]',
    primary:
      'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-[var(--md-sys-color-primary)]',
    success:
      'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)] border-[var(--md-sys-color-secondary)]',
    warning:
      'bg-[var(--md-sys-color-tertiary-container)] text-[var(--md-sys-color-on-tertiary-container)] border-[var(--md-sys-color-tertiary)]',
    danger:
      'bg-[var(--md-sys-color-error-container)] text-[var(--md-sys-color-on-error-container)] border-[var(--md-sys-color-error)]',
    cyan: 'text-[var(--md-sys-color-primary)] border-[var(--md-sys-color-primary)]',
    purple:
      'text-[var(--md-sys-color-tertiary)] border-[var(--md-sys-color-tertiary)]',
  }

  const extraStyle: React.CSSProperties =
    color === 'cyan' || color === 'purple'
      ? {
          backgroundColor:
            color === 'cyan'
              ? 'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)'
              : 'color-mix(in srgb, var(--md-sys-color-tertiary) 12%, transparent)',
        }
      : {}

  return (
    <span
      className={cn(
        'zen-tag-hover inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        colors[color],
        className
      )}
      style={{ ...extraStyle, ...style }}
      {...props}
    >
      {children}
    </span>
  )
}
