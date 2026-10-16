import { cn } from '@/lib/utils'

export type TagColor =
  'default' | 'primary' | 'success' | 'warning' | 'danger' | 'cyan' | 'purple'

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  color?: TagColor
  /** 前置图标（lucide 等，建议 w-3.5 h-3.5） */
  icon?: React.ReactNode
  /**
   * 半透明染色风格：12% 底色 + 25% 边框 + 实色文字（color-mix）。
   * 适合连接状态等状态徽章；默认 false 使用 container 实色底。
   */
  tinted?: boolean
  children: React.ReactNode
}

const colors: Record<TagColor, string> = {
  default:
    'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)] border-[var(--md-sys-color-outline)]',
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

/** tinted 风格使用的基色 CSS 变量 */
const tintedBaseVar: Record<Exclude<TagColor, 'default'>, string> = {
  primary: 'var(--md-sys-color-primary)',
  success: 'var(--md-sys-color-secondary)',
  warning: 'var(--md-sys-color-tertiary)',
  danger: 'var(--md-sys-color-error)',
  cyan: 'var(--md-sys-color-primary)',
  purple: 'var(--md-sys-color-tertiary)',
}

export function Tag({
  children,
  color = 'default',
  icon,
  tinted = false,
  className,
  style,
  ...props
}: TagProps) {
  const extraStyle: React.CSSProperties =
    color === 'cyan' || color === 'purple'
      ? {
          backgroundColor:
            color === 'cyan'
              ? 'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)'
              : 'color-mix(in srgb, var(--md-sys-color-tertiary) 12%, transparent)',
        }
      : {}

  if (tinted) {
    if (color === 'default') {
      // default 保持玻璃底，但允许 tinted 语义（无染色）
      extraStyle.backgroundColor = 'var(--glass-bg)'
      extraStyle.color = 'var(--md-sys-color-on-surface)'
      extraStyle.borderColor = 'var(--md-sys-color-outline)'
    } else {
      const base = tintedBaseVar[color]
      extraStyle.backgroundColor = `color-mix(in srgb, ${base} 12%, transparent)`
      extraStyle.color = base
      extraStyle.borderColor = `color-mix(in srgb, ${base} 25%, transparent)`
    }
  }

  return (
    <span
      className={cn(
        'zen-tag-hover inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        colors[color],
        icon && 'gap-1.5',
        className
      )}
      style={{ ...extraStyle, ...style }}
      {...props}
    >
      {icon}
      {children}
    </span>
  )
}
