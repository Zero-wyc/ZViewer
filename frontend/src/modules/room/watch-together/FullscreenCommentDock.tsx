/**
 * 一起看全屏评论区侧边栏。
 *
 * 全屏播放时,鼠标移到屏幕右缘 → 右侧滑出毛玻璃评论区侧边栏
 * (UI 对标一起听的 MusicSideDock,但不带右缘竖线把手)。
 * 渲染为 .zart-stage 的直接子节点,原生全屏(stage 进入 top layer)
 * 与网页全屏两条路径下均可见。
 *
 * 交互:
 * - 仅响应鼠标(pointerType === 'mouse'),触屏不触发,避免误滑;
 * - 指针进入右缘触发区 → 立即展开;
 * - 离开触发区(且不在侧边栏内)320ms 后自动收起;
 * - 指针在侧边栏内移动时保持展开。
 *
 * 由 WatchTogetherCore 在全屏状态(isFullscreen / isWebFullscreen)下挂载,
 * 退出全屏即卸载,评论 socket 监听随之释放。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { CommentPanel } from '@/components/CommentPanel'
import { cn } from '@/lib/utils'

/** 右缘触发区宽度(px):指针进入 stage 右缘该区域即展开侧边栏 */
const EDGE_WIDTH_PX = 24
/** 指针离开触发区/侧边栏后的收起延迟:覆盖「触发区 → 面板」之间的空隙移动 */
const DOCK_CLOSE_DELAY_MS = 320

interface FullscreenCommentDockProps {
  socket: Socket | null
  roomId: string
  stageRef: React.RefObject<HTMLDivElement | null>
}

export function FullscreenCommentDock({
  socket,
  roomId,
  stageRef,
}: FullscreenCommentDockProps) {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(
      () => setOpen(false),
      DOCK_CLOSE_DELAY_MS
    )
  }, [clearCloseTimer])

  // 右缘触发:监听 stage 上的指针移动(原生全屏时 stage 即全屏元素,
  // getBoundingClientRect 与视口一致;网页全屏时 stage 铺满视口,同样成立)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const handlePointerMove = (e: PointerEvent) => {
      // 触屏不触发(触摸拖动进度条/切弹幕时手指靠近右缘不应弹侧栏)
      if (e.pointerType !== 'mouse') return
      // 指针在侧边栏内:保持展开,不参与边缘判定
      if (
        e.target instanceof Element &&
        e.target.closest('[data-fullscreen-comment-dock]')
      ) {
        clearCloseTimer()
        return
      }
      const rect = stage.getBoundingClientRect()
      if (e.clientX >= rect.right - EDGE_WIDTH_PX) {
        clearCloseTimer()
        setOpen(true)
      } else {
        scheduleClose()
      }
    }

    const handlePointerLeave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      scheduleClose()
    }

    stage.addEventListener('pointermove', handlePointerMove)
    stage.addEventListener('pointerleave', handlePointerLeave)
    return () => {
      stage.removeEventListener('pointermove', handlePointerMove)
      stage.removeEventListener('pointerleave', handlePointerLeave)
      clearCloseTimer()
    }
  }, [stageRef, clearCloseTimer, scheduleClose])

  return (
    <aside
      data-fullscreen-comment-dock
      aria-hidden={!open}
      onMouseEnter={clearCloseTimer}
      onMouseLeave={scheduleClose}
      className={cn(
        'lt-blur-surface absolute right-2 top-1/2 z-[85] flex w-[344px] max-w-[calc(100%-1rem)] -translate-y-1/2 flex-col overflow-hidden',
        'rounded-[var(--md-sys-shape-corner)] transition-all duration-300',
        open
          ? 'pointer-events-auto translate-x-0 opacity-100'
          : 'pointer-events-none translate-x-6 opacity-0'
      )}
      style={{
        height: 'min(640px, calc(100% - 96px))',
        backgroundColor:
          'color-mix(in srgb, var(--md-sys-color-surface-container) 55%, transparent)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        border:
          '1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 60%, transparent)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
      }}
    >
      {/* 评论区:side-dock-body 作用域让内嵌 glass-card 去白底只留分隔描边
          (与一起听 MusicSideDock 内嵌面板观感一致);弹幕开关保留(一起看有弹幕层) */}
      <div className="side-dock-body flex min-h-0 flex-1 flex-col p-2">
        <CommentPanel socket={socket} roomId={roomId} commentsOnly />
      </div>
    </aside>
  )
}
