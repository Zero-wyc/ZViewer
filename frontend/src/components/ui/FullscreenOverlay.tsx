import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 退出动画时长(与 Modal 一致,超时后卸载) */
const OVERLAY_ANIMATION_DURATION = 220

export interface FullscreenOverlayProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  className?: string
}

/**
 * 全屏覆盖弹层(Kazumi / ani-subs 番剧源、B站搜索等大面板容器)。
 *
 * 进出场过渡动画与 Modal(openlist 浏览目录等二级 UI)完全一致:
 * - 进入:内容上浮 + 缩放(zen-modal-content-enter,0.3s ease-out-expo),蒙层淡入;
 * - 退出:内容上移淡出(zen-modal-content-exit,0.18s ease-soft),蒙层淡出,
 *   动画播完(220ms)后才真正卸载;
 * - ESC 仅在可见期间生效。
 */
export function FullscreenOverlay({
  open,
  onClose,
  title,
  children,
  className,
}: FullscreenOverlayProps) {
  const [visible, setVisible] = useState(open)
  const [exiting, setExiting] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevOpenRef = useRef(open)

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setVisible(true)
      setExiting(false)
    } else if (!open && prevOpenRef.current) {
      setExiting(true)
      closeTimerRef.current = setTimeout(() => {
        setVisible(false)
        setExiting(false)
      }, OVERLAY_ANIMATION_DURATION)
    }
    prevOpenRef.current = open

    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
    }
  }, [open])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible, onClose])

  if (!visible || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-[999]">
      <div
        className={cn(
          'absolute inset-0 bg-black/40',
          exiting ? 'zen-modal-backdrop-exit' : 'zen-modal-backdrop-enter'
        )}
        style={{
          // 蒙层模糊度跟随主题设置（取 glass-blur 的 40%，与 Modal 保持一致）
          backdropFilter: 'blur(var(--glass-blur-mask))',
          WebkitBackdropFilter: 'blur(var(--glass-blur-mask))',
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="pointer-events-none relative z-10 flex h-full w-full items-center justify-center p-4">
        <div
          className={cn(
            'glass-strong pointer-events-auto flex w-full max-w-4xl flex-col rounded-[var(--md-sys-shape-corner)]',
            exiting ? 'zen-modal-content-exit' : 'zen-modal-content-enter',
            className
          )}
          style={{
            maxHeight: '90vh',
            boxShadow:
              '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
          }}
        >
          <div className="flex items-start justify-between px-6 pt-6">
            {title ? (
              <h3 className="text-lg font-semibold text-[var(--md-sys-color-on-surface)]">
                {title}
              </h3>
            ) : (
              <span />
            )}
            <button
              onClick={onClose}
              className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">{children}</div>
        </div>
      </div>
    </div>,
    document.body
  )
}
