import { cn } from '@/lib/utils'

export interface TitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  level?: 1 | 2 | 3 | 4 | 5
  children: React.ReactNode
}

export function Title({
  level = 1,
  children,
  className,
  ...props
}: TitleProps) {
  const Tag = `h${level}` as const
  const sizes = {
    1: 'text-3xl font-bold',
    2: 'text-2xl font-bold',
    3: 'text-xl font-semibold',
    4: 'text-lg font-semibold',
    5: 'text-base font-semibold',
  }

  return (
    <Tag
      className={cn(
        'text-[var(--md-sys-color-on-surface)]',
        sizes[level],
        className
      )}
      {...props}
    >
      {children}
    </Tag>
  )
}

export interface TextProps extends React.HTMLAttributes<HTMLParagraphElement> {
  type?: 'default' | 'secondary' | 'success' | 'warning' | 'danger'
  children: React.ReactNode
}

export function Text({
  type = 'default',
  children,
  className,
  ...props
}: TextProps) {
  const colors = {
    default: 'text-[var(--md-sys-color-on-surface)]',
    secondary: 'text-[var(--md-sys-color-on-surface-variant)]',
    success: 'text-[var(--md-sys-color-secondary)]',
    warning: 'text-[var(--md-sys-color-tertiary)]',
    danger: 'text-[var(--md-sys-color-error)]',
  }

  return (
    <span className={cn(colors[type], className)} {...props}>
      {children}
    </span>
  )
}

export interface ParagraphProps extends React.HTMLAttributes<HTMLParagraphElement> {
  type?: 'default' | 'secondary' | 'success' | 'warning' | 'danger'
  children: React.ReactNode
}

export function Paragraph({
  type = 'default',
  children,
  className,
  ...props
}: ParagraphProps) {
  const colors = {
    default: 'text-[var(--md-sys-color-on-surface)]',
    secondary: 'text-[var(--md-sys-color-on-surface-variant)]',
    success: 'text-[var(--md-sys-color-secondary)]',
    warning: 'text-[var(--md-sys-color-tertiary)]',
    danger: 'text-[var(--md-sys-color-error)]',
  }

  return (
    <p className={cn(colors[type], className)} {...props}>
      {children}
    </p>
  )
}
