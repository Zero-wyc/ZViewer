import { cn } from '@/lib/utils'

/** 图标方块色调（对应 Material 3 container 配色） */
export type SectionHeaderTone = 'primary' | 'secondary' | 'tertiary' | 'error'

const toneStyles: Record<SectionHeaderTone, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--md-sys-color-primary-container)',
    color: 'var(--md-sys-color-on-primary-container)',
  },
  secondary: {
    backgroundColor: 'var(--md-sys-color-secondary-container)',
    color: 'var(--md-sys-color-on-secondary-container)',
  },
  tertiary: {
    backgroundColor: 'var(--md-sys-color-tertiary-container)',
    color: 'var(--md-sys-color-on-tertiary-container)',
  },
  error: {
    backgroundColor: 'var(--md-sys-color-error-container)',
    color: 'var(--md-sys-color-on-error-container)',
  },
}

export interface SectionHeaderProps {
  /** 图标（lucide 等，建议 h-4 w-4） */
  icon: React.ReactNode
  /** 主标题 */
  title: React.ReactNode
  /** 副标题（小号说明文字，位于主标题下方） */
  subtitle?: React.ReactNode
  /** 右侧附加内容（操作按钮、关闭按钮等，自动靠右） */
  extra?: React.ReactNode
  tone?: SectionHeaderTone
  /** 外层容器类名（如 mb-3 控制与下方内容的间距） */
  className?: string
  titleClassName?: string
  subtitleClassName?: string
}

/**
 * 「图标方块 + 标题(+副标题)(+右侧操作)」区块头。
 * 统一此前散落在 10+ 个文件中的手写标题栏结构。
 */
export function SectionHeader({
  icon,
  title,
  subtitle,
  extra,
  tone = 'primary',
  className,
  titleClassName,
  subtitleClassName,
}: SectionHeaderProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
        style={toneStyles[tone]}
      >
        {icon}
      </div>
      <div className="flex min-w-0 flex-col">
        <span
          className={cn(
            'text-sm font-medium text-[var(--md-sys-color-on-surface)]',
            titleClassName
          )}
        >
          {title}
        </span>
        {subtitle !== undefined && subtitle !== null && (
          <span
            className={cn(
              'text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]',
              subtitleClassName
            )}
          >
            {subtitle}
          </span>
        )}
      </div>
      {extra && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{extra}</div>
      )}
    </div>
  )
}
