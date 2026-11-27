import { cn } from '@/lib/utils'
import './panel.css'

// 设置面板里的分组卡片。
//
// 这个面板的信息密度本来就高（模型、外观、表情、动捕四类东西），以前全靠
// 12px 的大写小标题 + 空白来分组，滚动起来像一张没分行的表单。改成卡片之后
// 每组是一块实色底，边界由底色本身给出——不加描边、不加阴影、不加图标，
// 一眼能看出"这几项是一伙的"就够了。
//
// 底色用 on-surface 的 4% 而不是 surface-container：弹窗本身是毛玻璃，
// 主题容器色盖上去会变成死板的一块；4% 会跟着主题明暗自动"下沉"（浅色变灰、
// 深色变亮），和玻璃底始终有层级差。

export interface PanelProps {
  title?: React.ReactNode
  /** 标题右侧的补充说明（例如「仅本机」）：短到能塞进标题一行 */
  hint?: React.ReactNode
  /** 标题右侧的操作按钮（上传、导入等），自动靠右 */
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function Panel({
  title,
  hint,
  action,
  children,
  className,
}: PanelProps) {
  const hasHeader = Boolean(title || hint || action)
  return (
    <section
      className={cn(
        'l2d-panel rounded-[var(--md-sys-shape-corner)] p-3',
        className
      )}
    >
      {hasHeader && (
        <header className="mb-3 flex min-h-6 items-center gap-2">
          {title && (
            <h4 className="text-xs font-medium text-[var(--md-sys-color-on-surface)]">
              {title}
            </h4>
          )}
          {hint && (
            <span className="text-[10px] text-[var(--md-sys-color-on-surface-variant)] opacity-60">
              {hint}
            </span>
          )}
          {action && (
            <div className="ml-auto flex items-center gap-1.5">{action}</div>
          )}
        </header>
      )}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}
