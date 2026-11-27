import { cn } from '@/lib/utils'
import './panel.css'

// 设置面板里的分组卡片。
//
// 这个面板的信息密度本来就高（模型、外观、表情、动捕四类东西），以前全靠
// 12px 的大写小标题 + 空白来分组，滚动起来像一张没分行的表单。改成卡片之后
// 每组是一块实色底，边界由底色本身给出——不加描边、不加阴影、不加图标，
// 一眼能看出"这几项是一伙的"就够了。
//
// 底色用 on-surface 的百分比而不是 surface-container：弹窗本身是毛玻璃，
// 主题容器色盖上去会变成死板的一块；按 on-surface 调透明度会跟着主题明暗
// 自动"下沉"（浅色变灰、深色变亮），和玻璃底始终有层级差。具体比例见
// panel.css（深色需要更高，否则边界会糊掉）。

export interface PanelProps {
  title?: React.ReactNode
  /** 标题右侧的操作按钮（上传、导入等），自动靠右 */
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function Panel({ title, action, children, className }: PanelProps) {
  const hasHeader = Boolean(title || action)
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
          {action && (
            <div className="ml-auto flex items-center gap-1.5">{action}</div>
          )}
        </header>
      )}
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}
