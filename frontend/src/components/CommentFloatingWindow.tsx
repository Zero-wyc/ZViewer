import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { GripHorizontal, Pin, PinOff, X } from 'lucide-react'
import { CommentPanel } from '@/components/CommentPanel'
import { useSocket } from '@/hooks/useSocket'
import {
  COMMENT_FLOAT_MIN_HEIGHT,
  COMMENT_FLOAT_MIN_WIDTH,
  useCommentFloatingStore,
  type CommentFloatRect,
} from '@/store/commentFloatingStore'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

/**
 * 评论悬浮窗（应用内无边框小窗）。
 *
 * 由 CommentPanel 右下角「在悬浮窗打开评论区」触发；替代原来的 window.open
 * 浏览器小窗：不脱离主界面、复用同一个 socket 连接，想看画面时不会丢焦点。
 *
 * 能力：
 * - 拖动标题栏移动，右下角可缩放；位置尺寸记入 localStorage
 * - 背景透明度滑杆（0.3~1），标题栏与内嵌卡片一起变透明，能透出画面
 * - 置顶/取消置顶：置顶时压过语音（z-65）与一起听（z-60）浮层
 */
interface DragState {
  rect: CommentFloatRect
  startX: number
  startY: number
  mode: 'move' | 'resize'
}

function defaultRect(): CommentFloatRect {
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  const w = Math.min(380, Math.max(COMMENT_FLOAT_MIN_WIDTH, vw - 32))
  const h = Math.min(560, Math.max(COMMENT_FLOAT_MIN_HEIGHT, vh - 140))
  return { x: Math.max(8, vw - w - 24), y: 88, w, h }
}

function clampRect(rect: CommentFloatRect): CommentFloatRect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(COMMENT_FLOAT_MIN_WIDTH, Math.min(rect.w, vw - 16))
  const h = Math.max(COMMENT_FLOAT_MIN_HEIGHT, Math.min(rect.h, vh - 16))
  // 至少留 80px 标题栏在视口内，避免拖出屏幕后抓不回来
  const x = Math.min(Math.max(rect.x, 8 - w + 120), vw - 120)
  const y = Math.min(Math.max(rect.y, 0), vh - 48)
  return {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  }
}

export function CommentFloatingWindow() {
  const roomId = useCommentFloatingStore((s) => s.roomId)
  const opacity = useCommentFloatingStore((s) => s.opacity)
  const pinned = useCommentFloatingStore((s) => s.pinned)
  const storedRect = useCommentFloatingStore((s) => s.rect)
  const close = useCommentFloatingStore((s) => s.close)
  const setOpacity = useCommentFloatingStore((s) => s.setOpacity)
  const togglePinned = useCommentFloatingStore((s) => s.togglePinned)
  const setRect = useCommentFloatingStore((s) => s.setRect)

  const location = useLocation()
  const { socket } = useSocket()

  // 位置尺寸按房间派生：切房间时直接用记忆值（没有则默认右侧）重新夹取，
  // 不靠 effect 重置——渲染期 if 分支里的 setState 会触发额外的级联渲染。
  const [placement, setPlacement] = useState<{
    room: string | null
    rect: CommentFloatRect
  }>(() => ({ room: roomId, rect: storedRect ?? defaultRect() }))
  const rect =
    placement.room === roomId
      ? placement.rect
      : clampRect(storedRect ?? defaultRect())
  const dragRef = useRef<DragState | null>(null)
  const rectRef = useRef(rect)

  useEffect(() => {
    rectRef.current = rect
  }, [rect])

  // 离开房间就关掉：评论面板的 socket 订阅按房间工作，留着会串台
  useEffect(() => {
    if (!roomId) return
    const matched = /^\/room\/([^/]+)/.exec(location.pathname)
    const currentRoom = matched?.[1] ?? null
    if (currentRoom !== roomId) close()
  }, [location.pathname, roomId, close])

  const handlePointerDown = useCallback(
    (mode: 'move' | 'resize') => (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      dragRef.current = {
        rect: rectRef.current,
        startX: event.clientX,
        startY: event.clientY,
        mode,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    []
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      const next: CommentFloatRect =
        drag.mode === 'move'
          ? { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }
          : { ...drag.rect, w: drag.rect.w + dx, h: drag.rect.h + dy }
      setPlacement({ room: roomId, rect: clampRect(next) })
    },
    [roomId]
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!dragRef.current) return
      dragRef.current = null
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // 指针已释放
      }
      setRect(rectRef.current)
    },
    [setRect]
  )

  const panelBackground = useMemo(
    () =>
      `color-mix(in srgb, var(--md-sys-color-surface) ${Math.round(opacity * 100)}%, transparent)`,
    [opacity]
  )

  if (!roomId) return null

  return (
    <div
      data-comment-float="window"
      className={cn(
        'fixed flex flex-col overflow-hidden rounded-xl border shadow-2xl',
        pinned ? 'z-[120]' : 'z-[62]'
      )}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        backgroundColor: panelBackground,
        borderColor: 'var(--md-sys-color-outline-variant)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        // 内嵌卡片跟随窗口透明度（CommentPanel 用 var(--glass-bg)）
        ['--glass-bg' as string]: panelBackground,
        color: 'var(--md-sys-color-on-surface)',
      }}
    >
      <div
        className="flex h-9 shrink-0 cursor-move select-none items-center gap-1.5 border-b px-2"
        style={{
          borderColor: 'var(--md-sys-color-outline-variant)',
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
        }}
        onPointerDown={handlePointerDown('move')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <GripHorizontal className="h-4 w-4 shrink-0 opacity-50" />
        <span className="text-xs font-medium">{t('评论区')}</span>
        <span className="truncate text-[10px] opacity-50">{roomId}</span>
        <div
          className="ml-auto flex items-center gap-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            type="range"
            min={30}
            max={100}
            step={1}
            value={Math.round(opacity * 100)}
            title={t('背景透明度')}
            aria-label={t('背景透明度')}
            onChange={(e) => setOpacity(Number(e.target.value) / 100)}
            className="h-1 w-16 cursor-pointer"
            style={{ accentColor: 'var(--md-sys-color-primary)' }}
          />
          <button
            type="button"
            title={pinned ? t('取消置顶') : t('置顶')}
            aria-label={pinned ? t('取消置顶') : t('置顶')}
            aria-pressed={pinned}
            onClick={togglePinned}
            className={cn(
              'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
              pinned
                ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                : 'hover:bg-[var(--md-sys-color-surface-container-high)]'
            )}
          >
            {pinned ? (
              <Pin className="h-3.5 w-3.5" />
            ) : (
              <PinOff className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            title={t('关闭')}
            aria-label={t('关闭')}
            onClick={close}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
        <CommentPanel
          socket={socket}
          roomId={roomId}
          commentsOnly
          allowDanmaku={false}
          floating
        />
      </div>

      <div
        role="presentation"
        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
        onPointerDown={handlePointerDown('resize')}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          background:
            'linear-gradient(135deg, transparent 50%, var(--md-sys-color-outline-variant) 50%)',
          borderBottomRightRadius: 'inherit',
        }}
      />
    </div>
  )
}
