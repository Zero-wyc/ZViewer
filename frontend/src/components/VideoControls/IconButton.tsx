import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import './controls.css'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标节点（lucide 等），尺寸由 .vc-icon-btn 自动缩放 */
  icon: ReactNode
  /** 无障碍标签，同时作为 tooltip 显示 */
  label?: string
  /** 选中态：高亮背景 */
  active?: boolean
  /** 视觉变体：ghost 透明底、tonal 半透明底、primary 主色底 */
  variant?: 'ghost' | 'tonal' | 'primary'
  /**
   * 尺寸：默认 md（cqw 随容器缩放），紧凑场景用 sm；
   * bar 为固定尺寸（h-7 w-7 md:h-8 md:w-8），用于无容器查询上下文的
   * 播放器覆盖控制栏（如一起看底部控制条）
   */
  size?: 'sm' | 'md' | 'bar'
  /** 点击时阻止事件冒泡（播放器覆盖层防误触底层，如暂停/全屏） */
  stopPropagation?: boolean
}

/**
 * 视频控制栏统一的方形图标按钮。
 * - 尺寸通过 CSS 容器查询单位（cqw）随父容器宽度自由缩放；
 * - 取代原先各控制栏各自实现的原始 <button>，消除重复代码。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon,
      label,
      active,
      variant = 'ghost',
      size = 'md',
      stopPropagation = false,
      className,
      title,
      onClick,
      ...props
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        type="button"
        title={title ?? label}
        aria-label={label}
        aria-pressed={active}
        onClick={
          stopPropagation
            ? (e) => {
                e.stopPropagation()
                onClick?.(e)
              }
            : onClick
        }
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-lg',
          'outline-none transition-all duration-200',
          'text-[var(--md-sys-color-on-surface)]',
          'focus-visible:ring-2 focus-visible:ring-[var(--md-sys-color-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--md-sys-color-surface)]',
          'hover:bg-[var(--md-sys-color-surface-container-highest)]',
          'active:scale-95',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
          // bar:固定尺寸(不依赖容器查询上下文)
          size === 'bar' && 'h-7 w-7 md:h-8 md:w-8',
          size !== 'bar' && 'vc-icon-btn',
          size === 'sm' && 'vc-icon-btn-sm',
          // 悬停位移仅 cqw 缩放变体启用(固定尺寸覆盖层不做位移,避免叠层抖动)
          size !== 'bar' && 'hover:-translate-y-0.5 hover:shadow-sm',
          size !== 'bar' &&
            'disabled:hover:translate-y-0 disabled:hover:shadow-none',
          variant === 'tonal' &&
            'bg-[var(--md-sys-color-surface-container-high)] hover:bg-[var(--md-sys-color-surface-container-highest)]',
          variant === 'primary' &&
            'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] hover:bg-[var(--md-sys-color-primary)] hover:text-[var(--md-sys-color-on-primary)]',
          active &&
            'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]',
          className
        )}
        {...props}
      >
        {icon}
      </button>
    )
  }
)
