import { useRef } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: React.ReactNode
  block?: boolean
  disableAnimation?: boolean
}

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  icon,
  block = false,
  disableAnimation = false,
  className,
  style,
  onClick,
  onMouseMove,
  ...props
}: ButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disableAnimation || disabled || loading) {
      onClick?.(e)
      return
    }

    const btn = buttonRef.current
    if (btn) {
      const rect = btn.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const size = Math.max(rect.width, rect.height) * 2.4

      const ripple = document.createElement('span')
      ripple.className = 'zen-ripple-effect'
      ripple.style.left = `${x}px`
      ripple.style.top = `${y}px`
      ripple.style.width = `${size}px`
      ripple.style.height = `${size}px`
      btn.appendChild(ripple)

      const cleanup = () => {
        if (ripple.parentNode === btn) {
          btn.removeChild(ripple)
        }
      }
      ripple.addEventListener('animationend', cleanup, { once: true })
      setTimeout(cleanup, 900)
    }

    onClick?.(e)
  }

  // 鼠标位置感知：更新 --mx / --my 供 ::before 高光层使用
  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    const btn = buttonRef.current
    if (btn) {
      const rect = btn.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 100
      const y = ((e.clientY - rect.top) / rect.height) * 100
      btn.style.setProperty('--mx', `${x}%`)
      btn.style.setProperty('--my', `${y}%`)
    }
    onMouseMove?.(e)
  }

  const baseStyles =
    'inline-flex items-center justify-center gap-2 rounded-[var(--md-sys-shape-corner)] font-medium focus:outline-none focus:ring-2 focus:ring-[var(--md-sys-color-primary)] focus:ring-offset-1 focus:ring-offset-[var(--md-sys-color-surface)] disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none'

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
      ref={buttonRef}
      className={cn(
        baseStyles,
        sizes[size],
        block && 'w-full',
        !disableAnimation && 'zen-btn',
        !disableAnimation && variant === 'primary' && 'zen-btn-primary',
        variant !== 'ghost' &&
          !disableAnimation &&
          'hover:shadow-md hover:brightness-105',
        className
      )}
      disabled={disabled || loading}
      style={{ ...variants[variant], ...style }}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}
