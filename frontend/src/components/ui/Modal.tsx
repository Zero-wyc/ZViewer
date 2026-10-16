import { useState } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './Button'
import { ModalShell } from './ModalShell'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  className?: string
  /** 在关闭按钮旁显示「网页全屏」按钮(添加影片二级浏览弹窗等大面板使用) */
  fullscreenable?: boolean
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  fullscreenable = false,
}: ModalProps) {
  const [webFullscreen, setWebFullscreen] = useState(false)

  // 关闭即复位全屏态,避免下次打开残留(替代原先监听 open 的 effect)
  const handleClose = () => {
    setWebFullscreen(false)
    onClose()
  }

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      align="center"
      outerClassName={webFullscreen ? 'p-0' : undefined}
      className={cn(
        'flex flex-col p-6',
        // 网页全屏:铺满视口,忽略业务传入的宽度/高度类
        webFullscreen
          ? 'h-full max-h-full w-full max-w-none rounded-none'
          : cn('w-full max-w-md', className)
      )}
      style={{ maxHeight: webFullscreen ? '100vh' : 'calc(100vh - 2rem)' }}
    >
      <div className="flex shrink-0 items-start justify-between">
        {title ? (
          <h3 className="text-lg font-semibold text-[var(--md-sys-color-on-surface)]">
            {title}
          </h3>
        ) : (
          <span />
        )}
        <div className="flex shrink-0 items-center gap-1">
          {fullscreenable && (
            <button
              onClick={() => setWebFullscreen((v) => !v)}
              title={webFullscreen ? '退出网页全屏' : '网页全屏'}
              aria-label={webFullscreen ? '退出网页全屏' : '网页全屏'}
              className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)] hover:scale-110 active:scale-95"
            >
              {webFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            onClick={handleClose}
            className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)] hover:scale-110 active:scale-95"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {/* 内容超出可用高度（小屏）时出滚动条，而不是被裁掉 */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto text-sm text-[var(--md-sys-color-on-surface-variant)]">
        {children}
      </div>
      {footer && (
        <div className="mt-6 flex shrink-0 items-center justify-end gap-3">
          {footer}
        </div>
      )}
    </ModalShell>
  )
}

export interface ConfirmModalProps extends Omit<ModalProps, 'footer'> {
  okText?: string
  cancelText?: string
  onOk?: () => void
  onCancel?: () => void
  confirmLoading?: boolean
}

export function ConfirmModal({
  okText = '确认',
  cancelText = '取消',
  onOk,
  onCancel,
  confirmLoading,
  ...modalProps
}: ConfirmModalProps) {
  return (
    <Modal
      {...modalProps}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onCancel ?? modalProps.onClose}
            disabled={confirmLoading}
          >
            {cancelText}
          </Button>
          <Button
            variant="primary"
            onClick={onOk}
            loading={confirmLoading}
            disabled={confirmLoading}
          >
            {okText}
          </Button>
        </>
      }
    />
  )
}
