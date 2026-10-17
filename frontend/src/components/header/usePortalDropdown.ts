import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/** 下拉菜单 fixed 定位坐标：右边缘与触发按钮对齐，顶部在按钮下方 */
export interface DropdownPosition {
  top: number
  right: number
}

interface UsePortalDropdownOptions {
  /** 菜单与按钮的垂直间距（px），默认 8 */
  offset?: number
  /** 关闭动画时长（ms），默认 200 —— 与 zen-dropdown-exit 的时长一致 */
  closeDelayMs?: number
}

export interface PortalDropdown {
  /** 触发按钮 ref（外部点击判定 + 定位基准） */
  buttonRef: RefObject<HTMLButtonElement>
  /** 菜单容器 ref（portal 到 body，脱离 DOM 祖先关系，需单独判定） */
  menuRef: RefObject<HTMLDivElement>
  open: boolean
  /** 正在播放关闭动画（open 仍为 true，菜单尚未卸载） */
  closing: boolean
  /** 菜单 fixed 坐标；关闭动画结束后复位为 null */
  position: DropdownPosition | null
  /** 打开（同时取消未完成的关闭动画） */
  show: () => void
  /** 播放 200ms 收起动画后再关闭 */
  hide: () => void
  /** 立即关闭并卸载（点击菜单项后直接收起，不走动画） */
  hideNow: () => void
}

/**
 * 顶栏下拉菜单（主题菜单 / 账户菜单）的公共行为。
 *
 * 抽出前两份实现逐字相同：按钮 rect 算 fixed 坐标、resize/scroll 重算、
 * mousedown 外部点击收起（按钮与 portal 菜单都算内部）、200ms 关闭动画后
 * 才卸载。差异只有菜单内容本身，因此统一到本 hook，菜单内容各自成组件。
 *
 * 动画约定：`hide()` 只置 `closing=true`，`open` 保持 true 让菜单继续挂载，
 * 200ms 后一并复位 `open`/`closing`/`position`；渲染侧用
 * `closing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'` 选动画类。
 */
export function usePortalDropdown({
  offset = 8,
  closeDelayMs = 200,
}: UsePortalDropdownOptions = {}): PortalDropdown {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [position, setPosition] = useState<DropdownPosition | null>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const computePosition = useCallback(() => {
    const btn = buttonRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    setPosition({
      top: rect.bottom + offset,
      right: window.innerWidth - rect.right,
    })
  }, [offset])

  const show = useCallback(() => {
    clearCloseTimer()
    setOpen(true)
    setClosing(false)
  }, [clearCloseTimer])

  const hide = useCallback(() => {
    setClosing(true)
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      setOpen(false)
      setClosing(false)
      setPosition(null)
    }, closeDelayMs)
  }, [closeDelayMs])

  const hideNow = useCallback(() => {
    clearCloseTimer()
    setOpen(false)
    setClosing(false)
    setPosition(null)
  }, [clearCloseTimer])

  // 打开时计算位置，并跟随 resize / scroll 保持与按钮对齐
  useEffect(() => {
    if (!open) return
    computePosition()
    window.addEventListener('resize', computePosition)
    window.addEventListener('scroll', computePosition, true)
    return () => {
      window.removeEventListener('resize', computePosition)
      window.removeEventListener('scroll', computePosition, true)
    }
  }, [open, computePosition])

  // 外部点击收起：按钮与菜单（portal 渲染，脱离 DOM 祖先关系）都不算外部
  useEffect(() => {
    if (!open) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        buttonRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return
      }
      hide()
    }
    window.addEventListener('mousedown', handleMouseDown)
    return () => window.removeEventListener('mousedown', handleMouseDown)
  }, [open, hide])

  // 卸载时清掉未完成的关闭定时器
  useEffect(() => clearCloseTimer, [clearCloseTimer])

  return {
    buttonRef,
    menuRef,
    open,
    closing,
    position,
    show,
    hide,
    hideNow,
  }
}
