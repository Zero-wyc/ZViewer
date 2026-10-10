import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './Button'

const MODAL_ANIMATION_DURATION = 220

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
  const [visible, setVisible] = useState(open)
  const [exiting, setExiting] = useState(false)
  const [webFullscreen, setWebFullscreen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevOpenRef = useRef(open)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setVisible(true)
      setExiting(false)
      // 重新打开恢复非全屏,避免上次关闭前的全屏态残留
      setWebFullscreen(false)
    } else if (!open && prevOpenRef.current) {
      setExiting(true)
      closeTimerRef.current = setTimeout(() => {
        setVisible(false)
        setExiting(false)
      }, MODAL_ANIMATION_DURATION)
    }
    prevOpenRef.current = open

    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
    }
  }, [open])

  // Modal 打开期间锁定 body 滚动，避免滚轮穿透到底层页面
  useEffect(() => {
    if (!visible) return
    const prevOverflow = document.body.style.overflow
    const prevPaddingRight = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    // 补偿滚动条消失后的宽度跳变
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`
    }
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPaddingRight
    }
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible, onClose])

  if (!visible) return null

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 flex items-center justify-center',
        webFullscreen ? 'p-0' : 'p-4'
      )}
      style={{ zIndex: 999, transform: 'translateZ(0)' }}
      // 阻止滚轮事件冒泡到 document，防止触发底层页面滚动
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className={cn(
          'absolute inset-0 bg-black/40',
          exiting ? 'zen-modal-backdrop-exit' : 'zen-modal-backdrop-enter'
        )}
        style={{
          // 蒙层模糊度跟随主题设置（取 glass-blur 的 40%，避免大模糊度时背景过度模糊）
          backdropFilter: 'blur(var(--glass-blur-mask))',
          WebkitBackdropFilter: 'blur(var(--glass-blur-mask))',
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={cn(
          'glass-strong relative z-10 flex flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)] p-6 shadow-lg',
          exiting ? 'zen-modal-content-exit' : 'zen-modal-content-enter',
          // 网页全屏:铺满视口,忽略业务传入的宽度/高度类
          webFullscreen
            ? 'h-full max-h-full w-full max-w-none rounded-none'
            : cn('w-full max-w-md', className)
        )}
        style={{
          maxHeight: webFullscreen ? '100vh' : 'calc(100vh - 2rem)',
          boxShadow:
            '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
        }}
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
              onClick={onClose}
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
      </div>
    </div>,
    document.body
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
