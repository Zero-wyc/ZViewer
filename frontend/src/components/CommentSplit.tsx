import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'
import { useHorizontalSwipeGuard } from '@/hooks/useHorizontalSwipeGuard'
import {
  COMMENT_SPLIT_ANIMATION_MS,
  COMMENT_SPLIT_DEFAULT_RATIO,
  clampRatio,
  type CommentSplitOrientation,
} from '@/hooks/useCommentSplit'
import { useThemeStore } from '@/store/themeStore'
import { useFullscreenOverlayStore } from '@/store/fullscreenOverlayStore'

/** 中缝拖拽把手宽度（0.375rem = 6px，与下方 class 保持一致） */
const SPLIT_HANDLE_SIZE = '0.375rem'

/** 系统级「减少动态效果」偏好 */
function prefersReducedMotion(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

interface CommentSplitProps {
  /** 是否启用分屏（全屏 + 用户已打开评论区） */
  active: boolean
  /** 横屏左右分屏 / 竖屏上下分屏 */
  orientation: CommentSplitOrientation
  /** 评论区占比 0~1 */
  ratio: number
  onRatioChange: (ratio: number) => void
  /** 评论内容（关闭动画结束后卸载） */
  comment: ReactNode
  /** 评论区无障碍名称 */
  commentLabel?: string
  /** 分屏打开时点击画面区域：由调用方收起评论区 */
  onVideoClickClose?: () => void
  /** 播放器区域内容 */
  children: ReactNode
}

/**
 * 全屏播放器的分屏外壳：左侧/上方是播放器，右侧/下方是评论区。
 * 中缝可拖拽调整比例，双击回到默认 50%。
 */
export function CommentSplit({
  active,
  orientation,
  ratio,
  onRatioChange,
  comment,
  commentLabel,
  onVideoClickClose,
  children,
}: CommentSplitProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLDivElement | null>(null)
  const splitRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startPos: number; startRatio: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const setCommentPane = useFullscreenOverlayStore((s) => s.setCommentPane)
  const reducedMotion = useThemeStore((s) => s.reducedMotion)
  const animate = !reducedMotion && !prefersReducedMotion()

  // 开合动画：paneMounted 控制 DOM 去留，paneShown 控制尺寸 0 ↔ 占比。
  // 关闭时先播完动画再卸载（卸载会释放评论区的 socket 监听）。
  const [paneMounted, setPaneMounted] = useState(active)
  const [paneShown, setPaneShown] = useState(active)

  // 评论区里的横滑不允许被浏览器当成「快进 / 快退」（见 hook 顶部注释）。
  // 评论区挂载后再挂监听，卸载时自动释放。
  useHorizontalSwipeGuard(paneRef, paneMounted)

  // 打开：先以 0 尺寸挂载评论区，下一轮 effect（DOM 已提交）再切到目标尺寸。
  useEffect(() => {
    if (!active || paneMounted) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 分屏开关由外部全屏/按钮状态驱动
    setPaneMounted(true)
  }, [active, paneMounted])

  useEffect(() => {
    if (!active || !paneMounted || paneShown) return
    if (!animate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 同上
      setPaneShown(true)
      return
    }
    // 切目标值之前同步读一次样式/布局：确保浏览器已经按「0 尺寸」算过样式，
    // width/height 过渡才会触发。以前用双层 rAF 等一帧绘制，手机上（全屏切换、
    // 视频解码占主线程）帧可能被合并，动画就会时有时无；强制布局与帧时序无关。
    void splitRef.current?.offsetWidth
    setPaneShown(true)
  }, [active, animate, paneMounted, paneShown])

  // 关闭：先退回 0 尺寸，动画结束后卸载（卸载会释放评论区的 socket 监听）。
  useEffect(() => {
    if (active || !paneMounted) return undefined
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 同上
    if (paneShown) setPaneShown(false)
    if (!animate) {
      setPaneMounted(false)
      return undefined
    }
    const timer = window.setTimeout(
      () => setPaneMounted(false),
      COMMENT_SPLIT_ANIMATION_MS
    )
    return () => window.clearTimeout(timer)
  }, [active, animate, paneMounted, paneShown])

  // 把评论区实际占位（横屏=宽、竖屏=高）上报给全屏浮层系统：语音 / 一起听
  // 浮球据此让开评论区，继续贴在画面边框上（详见 fullscreenOverlayStore）。
  // 开合动画期间也会持续上报，浮球跟着评论区一起滑动。
  useEffect(() => {
    if (!paneMounted) {
      setCommentPane(null, 0)
      return
    }
    const el = paneRef.current
    if (!el) return
    const publish = () => {
      setCommentPane(
        orientation,
        orientation === 'side' ? el.offsetWidth : el.offsetHeight
      )
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(el)
    return () => {
      observer.disconnect()
      setCommentPane(null, 0)
    }
  }, [paneMounted, orientation, setCommentPane])

  // 分屏打开时点击画面区域收起评论区：控制栏（.vc-container）等交互元素除外。
  // 用原生捕获阶段监听并拦截，避免同一次点击又被播放器当成「播放/暂停」。
  useEffect(() => {
    const el = videoRef.current
    if (!el || !active || !onVideoClickClose) return undefined
    const handleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('.vc-container, [data-split-ignore-click]')) return
      event.preventDefault()
      event.stopPropagation()
      onVideoClickClose()
    }
    el.addEventListener('click', handleClick, true)
    return () => el.removeEventListener('click', handleClick, true)
  }, [active, onVideoClickClose])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      event.preventDefault()
      dragRef.current = {
        startPos: orientation === 'side' ? event.clientX : event.clientY,
        startRatio: ratio,
      }
      setDragging(true)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // 指针捕获失败时仍可用 move 事件（鼠标场景）
      }
    },
    [orientation, ratio]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const rect = containerRef.current?.getBoundingClientRect()
      if (!drag || !rect) return
      if (orientation === 'side') {
        if (rect.width <= 0) return
        const delta = (event.clientX - drag.startPos) / rect.width
        onRatioChange(clampRatio(drag.startRatio - delta))
      } else {
        if (rect.height <= 0) return
        const delta = (event.clientY - drag.startPos) / rect.height
        onRatioChange(clampRatio(drag.startRatio - delta))
      }
    },
    [orientation, onRatioChange]
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = null
      setDragging(false)
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // 指针已释放时忽略
      }
    },
    []
  )

  const ratioPercent = `${(ratio * 100).toFixed(4)}%`
  const splitStyle: CSSProperties =
    orientation === 'side'
      ? {
          width: paneShown
            ? `calc(${ratioPercent} + ${SPLIT_HANDLE_SIZE})`
            : '0px',
          height: '100%',
          transition: animate
            ? `width ${COMMENT_SPLIT_ANIMATION_MS}ms ease`
            : undefined,
        }
      : {
          height: paneShown
            ? `calc(${ratioPercent} + ${SPLIT_HANDLE_SIZE})`
            : '0px',
          width: '100%',
          transition: animate
            ? `height ${COMMENT_SPLIT_ANIMATION_MS}ms ease`
            : undefined,
        }

  return (
    <div
      ref={containerRef}
      data-comment-split
      className={cn(
        'relative flex h-full w-full min-h-0 min-w-0 overflow-hidden',
        orientation === 'side' ? 'flex-row' : 'flex-col'
      )}
    >
      <div
        ref={videoRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {children}
      </div>

      {paneMounted && (
        <div
          ref={splitRef}
          className={cn(
            'relative flex shrink-0 overflow-hidden',
            orientation === 'side' ? 'flex-row' : 'flex-col'
          )}
          style={splitStyle}
        >
          {/* 中缝拖拽把手 */}
          <div
            role="separator"
            aria-orientation={
              orientation === 'side' ? 'vertical' : 'horizontal'
            }
            aria-label={commentLabel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onDoubleClick={() => onRatioChange(COMMENT_SPLIT_DEFAULT_RATIO)}
            className={cn(
              'group relative z-30 flex shrink-0 touch-none select-none items-center justify-center',
              'bg-black/50 transition-colors hover:bg-[var(--md-sys-color-primary)]/50',
              orientation === 'side'
                ? 'w-1.5 cursor-col-resize'
                : 'h-1.5 cursor-row-resize',
              dragging && 'bg-[var(--md-sys-color-primary)]'
            )}
          >
            <span
              className={cn(
                'rounded-full bg-white/60 transition-colors group-hover:bg-white',
                orientation === 'side' ? 'h-8 w-0.5' : 'h-0.5 w-8'
              )}
            />
          </div>

          {/* 评论区 */}
          <div
            ref={paneRef}
            aria-label={commentLabel}
            data-comment-split-pane
            className="relative min-h-0 min-w-0 flex-1 touch-pan-y overflow-hidden overscroll-x-contain bg-[var(--md-sys-color-surface)]"
          >
            <div
              className="flex h-full min-h-0 flex-col p-2"
              style={{
                opacity: paneShown ? 1 : 0,
                transition: animate ? 'opacity 160ms ease' : undefined,
              }}
            >
              {comment}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
