import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FullscreenOverlayProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function FullscreenOverlay({
  open,
  onClose,
  title,
  children,
  className,
}: FullscreenOverlayProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="fullscreen-overlay fixed inset-0 z-[999]">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="pointer-events-none relative z-10 flex h-full w-full items-center justify-center p-4">
        <div
          className={cn(
            'glass-strong pointer-events-auto flex w-full max-w-4xl flex-col rounded-[var(--md-sys-shape-corner)]',
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
              className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)]"
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
