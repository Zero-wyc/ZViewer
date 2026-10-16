import { cn } from '@/lib/utils'
import { Text } from './Typography'

export interface EmptyStateProps {
  /** 可选图标（lucide 组件元素，建议 h-8 w-8） */
  icon?: React.ReactNode
  /** 空状态文案 */
  text: React.ReactNode
  /**
   * inline：简单内联占位（py-6 居中文本，适合列表/表格内）
   * centered：垂直水平撑满居中（适合面板/容器内），需 icon 搭配更佳
   */
  variant?: 'inline' | 'centered'
  className?: string
}

/**
 * 统一空状态占位。替代各页面手写的「暂无数据」块。
 */
export function EmptyState({
  icon,
  text,
  variant = 'inline',
  className,
}: EmptyStateProps) {
  if (variant === 'centered') {
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center gap-2 text-center',
          className
        )}
      >
        {icon && (
          <div
            className="opacity-40"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          >
            {icon}
          </div>
        )}
        <Text type="secondary" className="text-sm">
          {text}
        </Text>
      </div>
    )
  }

  return (
    <div className={cn('py-6 text-center', className)}>
      {icon && (
        <div
          className="mb-1 flex justify-center opacity-40"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          {icon}
        </div>
      )}
      <Text type="secondary" className="text-sm">
        {text}
      </Text>
    </div>
  )
}
