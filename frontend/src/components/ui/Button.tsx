import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: React.ReactNode
  block?: boolean
}

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  icon,
  block = false,
  className,
  style,
  ...props
}: ButtonProps) {
  const baseStyles =
    'inline-flex items-center justify-center gap-2 rounded-[var(--md-sys-shape-corner)] font-medium transition-all focus:outline-none focus:ring-2 focus:ring-[var(--md-sys-color-primary)] focus:ring-offset-1 focus:ring-offset-[var(--md-sys-color-surface)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none active:scale-[0.98]'

  const variants = {
    primary: {
      backgroundColor: 'var(--md-sys-color-primary)',
      color: 'var(--md-sys-color-on-primary)',
      border: '1px solid var(--md-sys-color-primary)',
      boxShadow:
        '0 1px 2px 0 color-mix(in srgb, var(--md-sys-color-shadow) 30%, transparent), 0 1px 3px 1px color-mix(in srgb, var(--md-sys-color-primary) 15%, transparent)',
    },
    secondary: {
      backgroundColor: 'var(--md-sys-color-secondary-container)',
      color: 'var(--md-sys-color-on-secondary-container)',
      border: '1px solid var(--md-sys-color-outline)',
      boxShadow:
        '0 1px 2px 0 color-mix(in srgb, var(--md-sys-color-shadow) 20%, transparent)',
    },
    ghost: {
      backgroundColor: 'transparent',
      color: 'var(--md-sys-color-on-surface)',
      border: '1px solid transparent',
      boxShadow: 'none',
    },
    danger: {
      backgroundColor: 'var(--md-sys-color-error)',
      color: 'var(--md-sys-color-on-error)',
      border: '1px solid var(--md-sys-color-error)',
      boxShadow:
        '0 1px 2px 0 color-mix(in srgb, var(--md-sys-color-shadow) 30%, transparent)',
    },
  }

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-5 py-2.5 text-base',
  }

  return (
    <button
      className={cn(
        baseStyles,
        sizes[size],
        block && 'w-full',
        variant !== 'ghost' && 'hover:shadow-md hover:brightness-105',
        className
      )}
      disabled={disabled || loading}
      style={{ ...variants[variant], ...style }}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}
