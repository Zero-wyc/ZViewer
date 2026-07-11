import { useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './Button'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  return open ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={cn(
          'glass-strong relative z-10 w-full max-w-md rounded-[var(--md-sys-shape-corner)] p-6 shadow-lg',
          className
        )}
        style={{
          boxShadow: '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
        }}
      >
        <div className="flex items-start justify-between">
          {title ? (
            <h3 className="text-lg font-semibold text-[var(--md-sys-color-on-surface)]">
              {title}
            </h3>
          ) : (
            <span />
          )}
          <button
            onClick={onClose}
            className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 text-sm text-[var(--md-sys-color-on-surface-variant)]">
          {children}
        </div>
        {footer && (
          <div className="mt-6 flex items-center justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  ) : null
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
