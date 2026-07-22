import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { forwardRef } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  label: string
  value: string | number
}

export interface SelectProps {
  label?: string
  error?: string
  options: SelectOption[]
  onChange?: (value: string) => void
  /** 当前选中值 */
  value?: string | number
  /** 占位文本 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 尺寸：md 默认，sm 紧凑（用于视频控制栏等空间受限场景） */
  size?: 'sm' | 'md'
  className?: string
  /** 透传到 trigger 按钮上的 ARIA 属性 */
  'aria-label'?: string
}

/**
 * 自定义下拉选择器（圆角玻璃态 + Check 图标），替代原生 <select>。
 * 保持与旧版 Select 兼容的 API（label/options/value/onChange/disabled/className）。
 *
 * 定位说明：
 * - menu 通过 createPortal 渲染到 document.body，使用 position: fixed
 * - 使用 getBoundingClientRect() 获取触发按钮相对视口的坐标
 * - 菜单打开后会持续通过 requestAnimationFrame 跟踪触发按钮位置，
 *   修正卡片 hover 动画、列表滚动、页面滚动等造成的错位
 * - 检测到触发按钮完全离开视口时自动关闭菜单，避免菜单悬空
 * - 关闭时立即 setOpen(false)，但保留 closing 状态让 menu 播放退出动画
 *   这样能避免多个 Select 同时打开导致的状态混乱
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      label,
      error,
      options,
      onChange,
      value,
      placeholder = '请选择',
      disabled = false,
      size = 'md',
      className,
      ...rest
    },
    ref
  ) => {
    const [open, setOpen] = useState(false)
    const [closing, setClosing] = useState(false)
    const [position, setPosition] = useState<{
      top: number
      left: number
      width: number
    } | null>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const rafRef = useRef<number | null>(null)
    const lastRectRef = useRef<DOMRect | null>(null)

    const selectedLabel = useMemo(() => {
      const found = options.find((opt) => String(opt.value) === String(value))
      return found?.label ?? placeholder
    }, [options, value, placeholder])

    /**
     * 计算下拉菜单位置。
     * - 基于触发按钮的 getBoundingClientRect()（视口坐标）
     * - 测量实际 menu 高度，而不是硬编码 288px
     * - 向下空间不足时优先向上展开
     * - 触发器完全离开视口时返回 null，外部可据此关闭菜单
     */
    const computePosition = useCallback((): {
      top: number
      left: number
      width: number
      outOfView: boolean
    } | null => {
      if (!triggerRef.current) return null
      const rect = triggerRef.current.getBoundingClientRect()
      lastRectRef.current = rect

      // 触发器完全离开视口：视为不可见，建议关闭菜单
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        return { top: 0, left: 0, width: 0, outOfView: true }
      }

      const menuEl = menuRef.current
      // menu 尚未渲染时先按最大高度估算，渲染后再用实际高度
      const menuHeight = menuEl
        ? Math.min(menuEl.scrollHeight, 288)
        : Math.min(options.length * 36 + 12, 288)
      const gap = 6
      const margin = 8

      const spaceBelow = window.innerHeight - rect.bottom - margin
      const spaceAbove = rect.top - margin
      const expandUpward = spaceBelow < menuHeight && spaceAbove > spaceBelow

      const top = expandUpward
        ? Math.max(margin, rect.top - menuHeight - gap)
        : rect.bottom + gap

      return {
        top,
        left: rect.left,
        width: rect.width,
        outOfView: false,
      }
    }, [options.length])

    const closeMenu = useCallback(() => {
      if (!open && !closing) return
      // 立即 setOpen(false)，避免与其他 Select 的 open 状态冲突
      // 保留 closing 状态让 menu 播放退出动画
      setOpen(false)
      setClosing(true)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      setTimeout(() => {
        setClosing(false)
        setPosition(null)
        lastRectRef.current = null
      }, 160)
    }, [open, closing])

    // 打开菜单后持续跟踪触发按钮位置，修正 hover/滚动导致的错位
    useEffect(() => {
      if (!open) return

      let frameCount = 0
      const track = () => {
        frameCount++
        // 每 3 帧（约 50ms@60fps）更新一次，避免过度重排
        if (frameCount % 3 === 0) {
          const next = computePosition()
          if (next?.outOfView) {
            closeMenu()
            return
          }
          if (next) {
            setPosition((prev) => {
              if (
                prev &&
                Math.abs(prev.top - next.top) < 1 &&
                Math.abs(prev.left - next.left) < 1 &&
                Math.abs(prev.width - next.width) < 1
              ) {
                return prev
              }
              return {
                top: next.top,
                left: next.left,
                width: next.width,
              }
            })
          }
        }
        rafRef.current = requestAnimationFrame(track)
      }

      // 首次打开时延迟一帧计算，等待 hover/进入动画稳定
      rafRef.current = requestAnimationFrame(() => {
        const first = computePosition()
        if (first?.outOfView) {
          closeMenu()
          return
        }
        if (first) {
          setPosition({
            top: first.top,
            left: first.left,
            width: first.width,
          })
        }
        rafRef.current = requestAnimationFrame(track)
      })

      const onResizeOrScroll = () => {
        const next = computePosition()
        if (next?.outOfView) {
          closeMenu()
          return
        }
        if (next) {
          setPosition({
            top: next.top,
            left: next.left,
            width: next.width,
          })
        }
      }

      window.addEventListener('resize', onResizeOrScroll)
      window.addEventListener('scroll', onResizeOrScroll, true)

      return () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = null
        }
        window.removeEventListener('resize', onResizeOrScroll)
        window.removeEventListener('scroll', onResizeOrScroll, true)
      }
    }, [open, computePosition, closeMenu])

    useEffect(() => {
      if (!open) return
      const handleClick = (e: MouseEvent) => {
        const target = e.target as Node
        if (
          triggerRef.current?.contains(target) ||
          menuRef.current?.contains(target)
        ) {
          return
        }
        closeMenu()
      }
      window.addEventListener('mousedown', handleClick)
      return () => window.removeEventListener('mousedown', handleClick)
    }, [open, closeMenu])

    const handleSelect = (opt: SelectOption) => {
      onChange?.(String(opt.value))
      closeMenu()
    }

    const isSm = size === 'sm'
    const triggerClasses = cn(
      'zen-input-glow w-full flex items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)] disabled:cursor-not-allowed disabled:bg-[var(--md-sys-color-surface-container)] disabled:opacity-60',
      'transition-all duration-200',
      'hover:border-[var(--md-sys-color-primary)] hover:shadow-sm',
      isSm ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm',
      error &&
        'border-[var(--md-sys-color-error)] focus:border-[var(--md-sys-color-error)] focus:ring-[var(--md-sys-color-error)]'
    )

    // menu 渲染条件：open 或 closing 期间都渲染，让退出动画能播放
    const showMenu = (open || closing) && position

    return (
      <div className={cn('w-full text-left', className)}>
        {label && (
          <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
            {label}
          </label>
        )}
        <div className="relative">
          <button
            ref={(node) => {
              triggerRef.current = node
              if (typeof ref === 'function') ref(node)
              else if (ref) ref.current = node
            }}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (open || closing) {
                closeMenu()
              } else {
                setOpen(true)
                setClosing(false)
              }
            }}
            className={triggerClasses}
            aria-label={rest['aria-label']}
            aria-haspopup="listbox"
            aria-expanded={open}
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronDown
              className={cn(
                'shrink-0 text-[var(--md-sys-color-on-surface-variant)] transition-transform duration-200',
                isSm ? 'h-3.5 w-3.5' : 'h-4 w-4',
                open && !closing && 'rotate-180'
              )}
            />
          </button>
        </div>
        {error && (
          <p className="mt-1 text-xs text-[var(--md-sys-color-error)]">
            {error}
          </p>
        )}

        {showMenu &&
          createPortal(
            <div
              ref={menuRef}
              className={cn(
                'glass-strong fixed max-h-72 overflow-auto rounded-[var(--md-sys-shape-corner)] p-1.5 shadow-lg',
                closing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
              )}
              style={{
                top: `${position!.top}px`,
                left: `${position!.left}px`,
                width: `${position!.width}px`,
                zIndex: 1000,
                boxShadow:
                  '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
              }}
            >
              {options.map((opt) => {
                const active = String(opt.value) === String(value)
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => handleSelect(opt)}
                    className={cn(
                      'zen-dropdown-item flex w-full items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-left text-sm transition-all',
                      active
                        ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                        : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                    )}
                    style={{ '--item-delay': '0ms' } as React.CSSProperties}
                  >
                    <span className="truncate">{opt.label}</span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                )
              })}
            </div>,
            document.body
          )}
      </div>
    )
  }
)

Select.displayName = 'Select'
