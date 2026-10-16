import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

const ANIMATION_DURATION = 220

export interface ModalShellProps {
  open: boolean
  onClose: () => void
  /** 垂直对齐:center 居中(常规弹窗,默认)/ top 距顶 80px(工具型 Popup) */
  align?: 'center' | 'top'
  /** 遮罩浓度:normal 40%(常规弹窗,默认)/ light 20%(工具型 Popup) */
  backdrop?: 'normal' | 'light'
  /** 进出场动画(zen-modal-*);轻量工具 Popup 可关闭 */
  animate?: boolean
  /** ESC 关闭,默认开启 */
  closeOnEsc?: boolean
  /** 打开期间锁定 body 滚动,默认开启 */
  lockBodyScroll?: boolean
  /** 最外层定位容器附加类名(如覆盖默认 padding) */
  outerClassName?: string
  /** 面板容器附加类名(布局/宽度/内边距等) */
  className?: string
  /** 面板容器内联样式(可覆盖默认 boxShadow) */
  style?: React.CSSProperties
  children?: React.ReactNode
}

/**
 * 弹窗外壳原语:Portal + 遮罩 + 玻璃面板容器 + 进出场动画/ESC/滚动锁。
 *
 * 统一此前散落的弹窗结构:
 * - ui/Modal(标题/内容/页脚结构化弹窗)内部也基于本组件;
 * - 工具型 Popup(B站下载、添加服务器目录等)直接用本组件承载自由布局。
 */
export function ModalShell({
  open,
  onClose,
  align = 'center',
  backdrop = 'normal',
  animate = true,
  closeOnEsc = true,
  lockBodyScroll = true,
  outerClassName,
  className,
  style,
  children,
}: ModalShellProps) {
  const [visible, setVisible] = useState(open)
  const [exiting, setExiting] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevOpenRef = useRef(open)

  // 入场/退场动画状态同步(受控 open → visible/exiting),与 ui/Modal 原实现一致;
  // React Compiler 严格规则对动画时序场景误报,参照 BilibiliDownloadModal 先例豁免。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setVisible(true)
      setExiting(false)
    } else if (!open && prevOpenRef.current) {
      if (animate) {
        setExiting(true)
        closeTimerRef.current = setTimeout(() => {
          setVisible(false)
          setExiting(false)
        }, ANIMATION_DURATION)
      } else {
        setVisible(false)
      }
    }
    prevOpenRef.current = open

    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
    }
  }, [open, animate])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 打开期间锁定 body 滚动，避免滚轮穿透到底层页面
  useEffect(() => {
    if (!visible || !lockBodyScroll) return
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
  }, [visible, lockBodyScroll])

  useEffect(() => {
    if (!visible || !closeOnEsc) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible, closeOnEsc, onClose])

  if (!visible) return null

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 flex justify-center',
        align === 'top' ? 'items-start px-4' : 'items-center p-4',
        outerClassName
      )}
      style={{
        zIndex: 999,
        transform: 'translateZ(0)',
        ...(align === 'top' ? { paddingTop: '80px' } : {}),
      }}
      // 阻止滚轮事件冒泡到 document，防止触发底层页面滚动
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className={cn(
          'absolute inset-0',
          backdrop === 'light' ? 'bg-black/20' : 'bg-black/40',
          animate
            ? exiting
              ? 'zen-modal-backdrop-exit'
              : 'zen-modal-backdrop-enter'
            : undefined
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
          'glass-strong relative z-10 overflow-hidden rounded-[var(--md-sys-shape-corner)] shadow-lg',
          animate &&
            (exiting ? 'zen-modal-content-exit' : 'zen-modal-content-enter'),
          className
        )}
        style={{
          boxShadow:
            '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
          ...style,
        }}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}
