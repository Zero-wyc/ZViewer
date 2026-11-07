import { useRef, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export interface SegmentedToggleOption {
  value: string
  label: string
}

export interface SegmentedToggleProps {
  options: SegmentedToggleOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

export function SegmentedToggle({
  options,
  value,
  onChange,
  disabled = false,
  className,
}: SegmentedToggleProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [indicatorStyle, setIndicatorStyle] = useState<{
    left: number
    width: number
  }>({
    left: 0,
    width: 0,
  })

  // 选项内容签名：调用方几乎都直接写数组字面量，引用每次都变；用内容做
  // 依赖，只有真的换了选项才重新测量。
  const signature = options
    .map((o) => `${o.value}\u0000${o.label}`)
    .join('\u0001')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const activeIndex = options.findIndex((o) => o.value === value)
    if (activeIndex < 0) return
    const buttons = container.querySelectorAll('button[data-segment]')
    const activeBtn = buttons[activeIndex] as HTMLElement | undefined
    if (!activeBtn) return

    const measure = () => {
      const left = activeBtn.offsetLeft
      const width = activeBtn.offsetWidth
      // 只在位置真的变了才 setState。
      //
      // 调用方通常直接写 `options={MODE_ORDER.map(...)}`，每次渲染都是新数组，
      // 这个 effect 就会每渲染必跑一次；不比较值的话每次 setState 又触发下一轮
      // 渲染，直接把自己送进 "Maximum update depth exceeded"。
      setIndicatorStyle((prev) =>
        prev.left === left && prev.width === width ? prev : { left, width }
      )
    }

    measure()

    // 按钮宽度会因为「与依赖无关」的原因变化：切界面语言后 label 从中文 key
    // 换成译文（`value` 与 `signature` 都没变，effect 不会重跑）、字体异步加载、
    // 容器被压缩。不重新量的话滑块会停在旧宽度上，首次切语言就能看到错位。
    // 所以直接盯住每个分段的实际尺寸，任何一个变了就重量一次。
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    buttons.forEach((btn) => observer.observe(btn))
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用内容签名代替 options 引用
  }, [value, signature])

  return (
    <div
      ref={containerRef}
      className={cn(
        'glass-strong relative flex items-center gap-1 rounded-full p-1 shadow-lg',
        'border border-[var(--md-sys-color-outline)] ring-1 ring-[var(--md-sys-color-outline-variant)]/40',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
      role="group"
      aria-disabled={disabled}
    >
      {/* 滑动指示器（带光晕） */}
      <div
        className="absolute top-1 bottom-1 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0,0,1)] shadow-md ring-1 ring-[var(--md-sys-color-outline-variant)]"
        style={{
          left: indicatorStyle.left,
          width: indicatorStyle.width,
          backgroundColor: 'var(--md-sys-color-primary)',
          boxShadow:
            '0 2px 8px -1px color-mix(in srgb, var(--md-sys-color-primary) 40%, transparent), 0 0 12px color-mix(in srgb, var(--md-sys-color-primary) 30%, transparent)',
        }}
      />

      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            data-segment={option.value}
            onClick={() => onChange(option.value)}
            disabled={disabled || isActive}
            aria-pressed={isActive}
            className={cn(
              'relative z-10 rounded-full px-4 py-1.5 text-xs font-medium transition-all duration-300',
              isActive
                ? 'text-[var(--md-sys-color-on-primary)]'
                : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)]/50 hover:scale-105'
            )}
          >
            {t(option.label)}
          </button>
        )
      })}
    </div>
  )
}
