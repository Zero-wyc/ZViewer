import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Check, ChevronRight } from 'lucide-react'
import { Button } from './Button'
import { cn } from '@/lib/utils'

export interface RequestNotificationItem {
  /** 唯一标识，用于 React key 与状态管理 */
  id: string
  /** 通知标题，如「跳转申请」「暂停申请」「观看请求」 */
  title: string
  /** 通知正文（ReactNode 允许高亮用户名/时间等关键字） */
  content: React.ReactNode
  /** 同意按钮文本，默认「同意」 */
  okText?: string
  /** 拒绝按钮文本，默认「拒绝」 */
  cancelText?: string
  /** 同意回调 */
  onOk?: () => void
  /** 拒绝回调 */
  onCancel?: () => void
  /**
   * 自动关闭延时（毫秒），0 表示不自动关闭。
   * 默认 8000ms 后自动按拒绝处理（避免长时间堆积）。
   */
  autoCloseMs?: number
}

export interface RequestNotificationProps {
  /** 当前展示的通知列表（通常同时只展示 1-3 条） */
  items: RequestNotificationItem[]
  /** 通知被关闭（手动 X 或自动超时）时的统一回调，参数为对应 item.id */
  onClose: (id: string) => void
}

/**
 * 房主端右下角申请通知组件。
 *
 * 替代原 ConfirmModal 居中弹窗：观众申请（加入/跳转/暂停）从播放器右下角
 * 滑入显示，不遮挡正在观看的内容。多条通知垂直堆叠，最新一条在底部。
 *
 * - 自动超时：默认 8s 后自动按「拒绝」处理（避免遗漏堆积）
 * - 手动关闭：右上角 X 按钮等同于「拒绝」
 * - ESC 关闭最新一条
 * - 同意/拒绝后通知立即消失
 */
export function RequestNotification({
  items,
  onClose,
}: RequestNotificationProps) {
  // ESC 关闭最新一条（仅当有通知时）
  useEffect(() => {
    if (items.length === 0) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 关闭最后一条（数组末尾为最新）
        const latest = items[items.length - 1]
        if (latest) {
          latest.onCancel?.()
          onClose(latest.id)
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [items, onClose])

  if (items.length === 0) return null

  return createPortal(
    <div
      className="fixed bottom-4 right-4 z-[300] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      style={{ pointerEvents: 'none', perspective: '800px' }}
    >
      {items.map((item) => (
        <NotificationCard key={item.id} item={item} onClose={onClose} />
      ))}
    </div>,
    document.body
  )
}

interface NotificationCardProps {
  item: RequestNotificationItem
  onClose: (id: string) => void
}

function NotificationCard({ item, onClose }: NotificationCardProps) {
  const [leaving, setLeaving] = useState(false)
  const { autoCloseMs = 8000 } = item

  // 统一处理同意/拒绝/关闭：先播放淡出动画，再触发 onClose
  const handleAction = useCallback(
    (accepted: boolean) => {
      if (leaving) return
      setLeaving(true)
      if (accepted) {
        item.onOk?.()
      } else {
        item.onCancel?.()
      }
      // 等待动画结束后再从列表中移除
      setTimeout(() => onClose(item.id), 380)
    },
    [leaving, item, onClose]
  )

  // 自动关闭：到时按拒绝处理
  useEffect(() => {
    if (autoCloseMs <= 0) return
    const timer = setTimeout(() => {
      handleAction(false)
    }, autoCloseMs)
    return () => clearTimeout(timer)
  }, [autoCloseMs, handleAction])

  return (
    <div
      className={cn(
        'glass-strong pointer-events-auto overflow-hidden rounded-[var(--md-sys-shape-corner)] border border-[var(--glass-border)] shadow-lg',
        leaving ? 'zen-notification-exit' : 'zen-notification-enter'
      )}
      style={{
        boxShadow:
          '0 12px 32px -8px color-mix(in srgb, var(--md-sys-color-shadow) 45%, transparent), 0 0 0 1px color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
        transformStyle: 'preserve-3d',
      }}
      role="dialog"
      aria-live="polite"
    >
      {/* 顶部自动关闭进度条 */}
      {autoCloseMs > 0 && (
        <div className="relative h-0.5 w-full overflow-hidden bg-[var(--md-sys-color-surface-container-highest)]">
          <div
            className="absolute left-0 top-0 h-full bg-[var(--md-sys-color-primary)]"
            style={{
              animation: `request-notification-shrink ${autoCloseMs}ms linear forwards`,
              boxShadow:
                '0 0 6px color-mix(in srgb, var(--md-sys-color-primary) 50%, transparent)',
            }}
          />
        </div>
      )}

      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: 'var(--md-sys-color-primary)' }}
            />
            <span
              className="text-xs font-semibold"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            >
              {item.title}
            </span>
          </div>
          <button
            type="button"
            onClick={() => handleAction(false)}
            aria-label="关闭"
            className="rounded-[var(--md-sys-radius-small)] p-0.5 text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)] hover:scale-110 active:scale-95"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div
          className="mt-1.5 text-xs leading-relaxed"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          {item.content}
        </div>

        <div className="mt-2.5 flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            onClick={() => handleAction(false)}
          >
            {item.cancelText ?? '拒绝'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            icon={<Check className="h-3 w-3" />}
            onClick={() => handleAction(true)}
          >
            {item.okText ?? '同意'}
          </Button>
        </div>
      </div>

      <style>{`
        @keyframes request-notification-shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
      `}</style>
    </div>
  )
}
