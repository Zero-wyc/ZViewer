import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CommentPanel } from '@/components/CommentPanel'
import { useHorizontalSwipeGuard } from '@/hooks/useHorizontalSwipeGuard'
import { useSocket } from '@/hooks/useSocket'
import { t } from '@/i18n'

interface CommentListSheetProps {
  open: boolean
  roomId: string
  onClose: () => void
}

/**
 * 手机竖屏大评论列表。
 *
 * 投屏页在窄屏下评论卡片只有一小块，看不全历史评论。这里给出「像点歌列表
 * 一样」的大面板：半屏悬浮卡片，内含完整评论面板（列表 + 发送 + 自动滚动
 * 开关），点击遮罩或右上角关闭。
 */
export function CommentListSheet({
  open,
  roomId,
  onClose,
}: CommentListSheetProps) {
  const { socket } = useSocket()
  const panelRef = useRef<HTMLDivElement | null>(null)
  // 双状态做进/退场动画：mounted 控制 DOM 是否存在，visible 控制过渡目标值。
  // 关闭时先播退场动画再卸载，避免面板「啪」一下消失。
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(false)

  // 面板里的横滑不能被浏览器当成「快进 / 快退」
  useHorizontalSwipeGuard(panelRef, open)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  // 打开：立刻挂载（此时仍是初始样式）
  useEffect(() => {
    if (!open || mounted) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 面板显隐由外部按钮状态驱动
    setMounted(true)
  }, [open, mounted])

  // 挂载提交后再切过渡目标值；切换前强制读一次布局，保证「初始样式」已被计算，
  // 过渡才会触发。原先用双层 rAF 等一帧绘制，手机上帧被合并时动画会偶发不播。
  useEffect(() => {
    if (!open || !mounted || visible) return
    void panelRef.current?.offsetHeight
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 同上
    setVisible(true)
  }, [open, mounted, visible])

  // 关闭：先退回初始样式，等过渡结束（200ms + 余量）再卸载
  useEffect(() => {
    if (open) return undefined
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 关闭动画需要在 open 变化后同步退回初始样式再卸载
    setVisible(false)
    const timer = window.setTimeout(() => setMounted(false), 240)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!mounted) return null

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-[140] flex items-center justify-center bg-black/45 p-3 transition-opacity duration-200 ease-out',
        visible ? 'opacity-100' : 'opacity-0'
      )}
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        data-comment-sheet="panel"
        onClick={(event) => event.stopPropagation()}
        className={cn(
          'glass-strong flex h-[min(80dvh,640px)] w-[min(92vw,480px)] touch-pan-y flex-col overflow-hidden overscroll-x-contain rounded-2xl shadow-2xl transition-all duration-200 ease-out',
          visible
            ? 'translate-y-0 scale-100 opacity-100'
            : 'translate-y-3 scale-95 opacity-0'
        )}
        style={{ color: 'var(--md-sys-color-on-surface)' }}
      >
        <div
          className="flex h-10 shrink-0 items-center gap-2 border-b px-3"
          style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
        >
          <span className="text-sm font-medium">{t('评论区')}</span>
          <span className="truncate text-[11px] opacity-50">{roomId}</span>
          <button
            type="button"
            title={t('关闭')}
            aria-label={t('关闭')}
            onClick={onClose}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <CommentPanel
            socket={socket}
            roomId={roomId}
            commentsOnly
            allowDanmaku={false}
            floating
          />
        </div>
      </div>
    </div>,
    document.body
  )
}
