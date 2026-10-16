import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface LoadingLineProps {
  /** 加载文案，默认「加载中…」 */
  text?: React.ReactNode
  /** 外层容器类名（默认 h-20 垂直居中，可覆盖） */
  className?: string
  spinnerClassName?: string
}

/**
 * 行内轻量加载占位（Loader2 旋转 + 文案）。
 * 替代各页面手写的 `<Loader2 className="animate-spin" /> 加载中…` 块。
 * 视觉更重的场景请使用 ui/Spinner。
 */
export function LoadingLine({
  text = '加载中…',
  className,
  spinnerClassName,
}: LoadingLineProps) {
  return (
    <div
      className={cn(
        'flex h-20 items-center justify-center gap-2 text-xs text-[var(--md-sys-color-on-surface-variant)]',
        className
      )}
    >
      <Loader2
        className={cn('h-4 w-4 shrink-0 animate-spin', spinnerClassName)}
      />
      {text}
    </div>
  )
}
