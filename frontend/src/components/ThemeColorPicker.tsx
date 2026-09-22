/**
 * Zen 浏览器风格的高级主题色选择器（参考 Zen theme creator UI）。
 *
 * 布局（自上而下）：
 * - 模式页签：跟随系统 ✨ / 浅色 ☀ / 深色 🌙（auto 由 ThemeProvider 监听
 *   系统偏好并物化 isDark）
 * - 预览区：点状纹理底 + 当前主题迷你界面 Mock（种子色/深浅变化实时重绘），
 *   点击整区唤起系统取色器添加自定义颜色
 * - 操作行：+ 添加自定义颜色 / − 移除选中的自定义颜色 / 调色盘 随机主题色
 * - 色板行：预设色 + 自定义色横向滚动，左右箭头翻页，右键自定义色可移除
 * - 波形条：正弦波彩虹渐变 = 色相 0-360°，拖动按通道改写（保持饱和度/明度）
 * - 旋钮：饱和度 0-100%，-135°~+135° 表盘式拖动，盘面实时着色
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles,
  Sun,
  Moon,
  Plus,
  Minus,
  Palette,
  Check,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'
import {
  DEFAULT_SEED,
  PRESET_SEEDS,
  hexToHsl,
  hslToHex,
  normalizeHexColor,
} from '@/lib/themes'
import { generateMonetTheme } from '@/lib/monet'
import { hexToRgb, relativeLuminance } from '@/lib/bgContrast'
import { cn } from '@/lib/utils'

/** 波形条 SVG 视图尺寸与正弦参数（preserveAspectRatio none 下仅横向微缩放） */
const WAVE_W = 180
const WAVE_H = 44
const WAVE_MID = 22
const WAVE_AMP = 9
const WAVE_LEN = 56
/** 旋钮可用角度范围：-135° ~ +135°（0° 朝上），映射饱和度 0-100% */
const DIAL_RANGE_DEG = 270

/** 生成正弦波形 path（3px 步长折线，视觉平滑） */
function buildWavePath(): string {
  const parts: string[] = []
  for (let x = 0; x <= WAVE_W; x += 3) {
    const y = WAVE_MID + WAVE_AMP * Math.sin((x / WAVE_LEN) * Math.PI * 2)
    parts.push(`${x === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(2)}`)
  }
  return parts.join(' ')
}
const WAVE_PATH = buildWavePath()

/** 彩虹渐变色标（0°..360°，每 30° 一档） */
const HUE_STOPS = Array.from({ length: 13 }, (_, i) => i * 30)

/** 深浅模式页签定义（Sparkles = 跟随系统，与 Zen 主题页签同构） */
const MODE_TABS = [
  { value: 'auto', icon: Sparkles, label: '跟随系统' },
  { value: 'light', icon: Sun, label: '浅色' },
  { value: 'dark', icon: Moon, label: '深色' },
] as const

/** 按背景色亮度返回可读的文字色（勾选图标/旋钮指针用） */
function onColorFor(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return '#ffffff'
  return relativeLuminance(rgb) > 0.4 ? '#1a1a1c' : '#ffffff'
}

export function ThemeColorPicker() {
  const sourceColor = useThemeStore((s) => s.sourceColor)
  const setSourceColor = useThemeStore((s) => s.setSourceColor)
  const isDark = useThemeStore((s) => s.isDark)
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  const customColors = useThemeStore((s) => s.customColors)
  const addCustomColor = useThemeStore((s) => s.addCustomColor)
  const removeCustomColor = useThemeStore((s) => s.removeCustomColor)

  /** 规范化种子色（非法输入兜底默认色，供 input[type=color]/HSL 计算用） */
  const normalizedSource = normalizeHexColor(sourceColor) ?? DEFAULT_SEED
  const hsl = hexToHsl(normalizedSource) ?? { h: 214, s: 100, l: 40 }

  /** 预览 Mock 的实时 scheme（种子色或深浅变化即重绘） */
  const scheme = useMemo(() => {
    try {
      return generateMonetTheme(normalizedSource, isDark)
    } catch {
      return {}
    }
  }, [normalizedSource, isDark])
  const v = useCallback(
    (key: string, fallback: string) => scheme[key] ?? fallback,
    [scheme]
  )

  const colorInputRef = useRef<HTMLInputElement>(null)
  const openColorInput = useCallback(() => {
    colorInputRef.current?.click()
  }, [])

  /** 系统取色器回调：入色板 + 立即应用 */
  const handleColorInput = useCallback(
    (raw: string) => {
      const hex = normalizeHexColor(raw)
      if (!hex) return
      addCustomColor(hex)
      setSourceColor(hex)
    },
    [addCustomColor, setSourceColor]
  )
  const handleColorInputEvent = useCallback(
    (e: React.SyntheticEvent<HTMLInputElement>) => {
      handleColorInput(e.currentTarget.value)
    },
    [handleColorInput]
  )

  const isCustom = customColors.includes(normalizedSource)

  /** 移除当前选中的自定义色（被移除色正被使用时回落默认种子） */
  const removeSelected = useCallback(() => {
    if (!isCustom) return
    removeCustomColor(normalizedSource)
    setSourceColor(DEFAULT_SEED)
  }, [isCustom, normalizedSource, removeCustomColor, setSourceColor])

  /** 随机主题色：舒适区间内的随机 HSL（不写入色板，试色用） */
  const randomSeed = useCallback(() => {
    setSourceColor(
      hslToHex(
        Math.random() * 360,
        55 + Math.random() * 30,
        42 + Math.random() * 20
      )
    )
  }, [setSourceColor])

  // ===== 波形条（色相）：指针拖动按 x 位置映射 0-360° =====
  const waveRef = useRef<HTMLDivElement>(null)
  const applyWavePointer = useCallback(
    (clientX: number) => {
      const el = waveRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      setSourceColor(hslToHex(ratio * 360, hsl.s, hsl.l))
    },
    [setSourceColor, hsl.s, hsl.l]
  )

  // ===== 旋钮（饱和度）：指针相对盘心的角度映射 0-100% =====
  const dialRef = useRef<HTMLDivElement>(null)
  const applyDialPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = dialRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const dx = clientX - (rect.left + rect.width / 2)
      const dy = clientY - (rect.top + rect.height / 2)
      let angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90
      if (angle > 180) angle -= 360
      const ratio = Math.min(
        1,
        Math.max(0, (angle + DIAL_RANGE_DEG / 2) / DIAL_RANGE_DEG)
      )
      setSourceColor(hslToHex(hsl.h, ratio * 100, hsl.l))
    },
    [setSourceColor, hsl.h, hsl.l]
  )

  /** 指针相对盘心的角度映射饱和度（0-100%） */

  // ===== 色板行箭头可用态（滚动位置跟踪） =====
  const swatchScrollRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  const updateArrows = useCallback(() => {
    const el = swatchScrollRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [])
  useLayoutEffect(updateArrows, [updateArrows, customColors.length])

  const scrollSwatches = (dir: number) => {
    swatchScrollRef.current?.scrollBy({ left: dir * 120, behavior: 'smooth' })
  }

  const knobAngle = -135 + (hsl.s / 100) * DIAL_RANGE_DEG

  return (
    <div className="zen-dropdown-item space-y-3 pb-1">
      {/* ===== 模式页签（跟随系统/浅色/深色） ===== */}
      <div
        className="mx-auto flex w-fit items-center gap-0.5 rounded-full p-1"
        style={{
          backgroundColor: 'var(--md-sys-color-surface-container-high)',
        }}
        role="tablist"
        aria-label="深浅模式"
      >
        {MODE_TABS.map((tab) => {
          const active = mode === tab.value
          const Icon = tab.icon
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.label}
              aria-label={tab.label}
              onClick={() => setMode(tab.value)}
              className={cn(
                'flex h-8 w-10 items-center justify-center rounded-full transition-colors',
                active
                  ? 'shadow-sm'
                  : 'opacity-55 transition-opacity hover:opacity-90'
              )}
              style={
                active
                  ? {
                      backgroundColor: v(
                        '--md-sys-color-primary-container',
                        'var(--md-sys-color-surface-container-highest)'
                      ),
                      color: v(
                        '--md-sys-color-on-primary-container',
                        'inherit'
                      ),
                    }
                  : { color: 'var(--md-sys-color-on-surface)' }
              }
            >
              <Icon className="h-4 w-4" />
            </button>
          )
        })}
      </div>

      {/* ===== 预览区：点状纹理底 + 当前主题 Mock（点击添加颜色） ===== */}
      <button
        type="button"
        onClick={openColorInput}
        title="点击添加颜色"
        className="block w-full cursor-pointer overflow-hidden rounded-[var(--md-sys-shape-corner)] p-4 text-center transition-transform active:scale-[0.99]"
        style={{
          backgroundColor: v('--md-sys-color-surface-container', '#e5e7eb'),
          backgroundImage: `radial-gradient(${v('--md-sys-color-outline-variant', '#c4c7cc')} 1px, transparent 1px)`,
          backgroundSize: '10px 10px',
        }}
      >
        {/* 迷你界面 Mock：主色圆点/标题条/按钮胶囊/进度条，全部走实时 scheme */}
        <span className="mx-auto block w-full max-w-[200px] rounded-xl p-3 text-left shadow-md">
          <span className="flex items-center gap-2.5">
            <span
              className="block h-7 w-7 shrink-0 rounded-full"
              style={{
                backgroundColor: v('--md-sys-color-primary', '#0066cc'),
              }}
            />
            <span className="block min-w-0 flex-1">
              <span
                className="block h-2 w-3/4 rounded-full"
                style={{
                  backgroundColor: v('--md-sys-color-on-surface', '#1a1c1e'),
                  opacity: 0.85,
                }}
              />
              <span
                className="mt-1.5 block h-1.5 w-1/2 rounded-full"
                style={{
                  backgroundColor: v(
                    '--md-sys-color-on-surface-variant',
                    '#43474e'
                  ),
                }}
              />
            </span>
          </span>
          <span className="mt-3 flex gap-1.5">
            <span
              className="rounded-full px-2.5 py-1 text-[10px] font-medium leading-none"
              style={{
                backgroundColor: v('--md-sys-color-primary', '#0066cc'),
                color: v('--md-sys-color-on-primary', '#ffffff'),
              }}
            >
              播放
            </span>
            <span
              className="rounded-full px-2.5 py-1 text-[10px] font-medium leading-none"
              style={{
                backgroundColor: v(
                  '--md-sys-color-secondary-container',
                  '#dce3f5'
                ),
                color: v('--md-sys-color-on-secondary-container', '#101c3a'),
              }}
            >
              收藏
            </span>
            <span
              className="rounded-full px-2.5 py-1 text-[10px] font-medium leading-none"
              style={{
                backgroundColor: v(
                  '--md-sys-color-primary-container',
                  '#d1e4ff'
                ),
                color: v('--md-sys-color-on-primary-container', '#001d36'),
              }}
            >
              队列
            </span>
          </span>
          <span
            className="mt-3 block h-1.5 rounded-full"
            style={{
              backgroundColor: v('--md-sys-color-outline-variant', '#c4c7cc'),
            }}
          >
            <span
              className="block h-full w-2/3 rounded-full"
              style={{
                backgroundColor: v('--md-sys-color-primary', '#0066cc'),
              }}
            />
          </span>
        </span>
        <span
          className="mt-2 block text-[11px] font-medium"
          style={{ color: v('--md-sys-color-on-surface-variant', '#43474e') }}
        >
          点击添加颜色
        </span>
      </button>
      <input
        ref={colorInputRef}
        type="color"
        value={normalizedSource}
        onChange={handleColorInputEvent}
        onInput={handleColorInputEvent}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* ===== 操作行：添加 / 移除 / 随机 ===== */}
      <div className="flex items-center justify-center gap-2">
        <ToolButton title="添加自定义颜色" onClick={openColorInput}>
          <Plus className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          title={isCustom ? '从色板移除当前颜色' : '仅自定义颜色可移除'}
          onClick={removeSelected}
          disabled={!isCustom}
        >
          <Minus className="h-4 w-4" />
        </ToolButton>
        <ToolButton title="随机主题色" onClick={randomSeed}>
          <Palette className="h-4 w-4" />
        </ToolButton>
      </div>

      {/* ===== 色板行：预设 + 自定义，横向滚动 + 左右翻页箭头 ===== */}
      <div className="flex items-center gap-0.5">
        <ArrowButton
          dir={-1}
          disabled={!canLeft}
          onClick={() => scrollSwatches(-1)}
        />
        <div
          ref={swatchScrollRef}
          onScroll={updateArrows}
          className="hide-scrollbar flex flex-1 items-center gap-2 overflow-x-auto px-1 py-1"
        >
          {PRESET_SEEDS.map((seed) => (
            <SwatchDot
              key={seed.id}
              color={seed.color}
              name={seed.name}
              active={normalizedSource === seed.color.toLowerCase()}
              onPick={() => setSourceColor(seed.color)}
              v={v}
            />
          ))}
          {customColors.length > 0 && (
            <span
              className="h-5 w-px shrink-0"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-outline) 45%, transparent)',
              }}
              aria-hidden="true"
            />
          )}
          {customColors.map((color) => (
            <SwatchDot
              key={color}
              color={color}
              name="自定义颜色（右键移除）"
              active={normalizedSource === color}
              onPick={() => setSourceColor(color)}
              onRemove={() => {
                removeCustomColor(color)
                if (normalizedSource === color) setSourceColor(DEFAULT_SEED)
              }}
              v={v}
            />
          ))}
        </div>
        <ArrowButton
          dir={1}
          disabled={!canRight}
          onClick={() => scrollSwatches(1)}
        />
      </div>

      {/* ===== 波形条（色相）+ 旋钮（饱和度） ===== */}
      <div className="flex items-center gap-3">
        <div
          ref={waveRef}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            applyWavePointer(e.clientX)
          }}
          onPointerMove={(e) => {
            if (
              e.buttons === 0 ||
              !e.currentTarget.hasPointerCapture(e.pointerId)
            )
              return
            applyWavePointer(e.clientX)
          }}
          className="touch-slider relative min-w-0 flex-1 cursor-pointer select-none"
          title={`色相 ${Math.round(hsl.h)}°`}
          role="slider"
          aria-label="色相"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsl.h)}
        >
          <svg
            viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
            preserveAspectRatio="none"
            className="block h-11 w-full"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="tcp-hue-wave" x1="0" y1="0" x2="1" y2="0">
                {HUE_STOPS.map((h) => (
                  <stop
                    key={h}
                    offset={`${(h / 360) * 100}%`}
                    stopColor={hslToHex(h, 70, 55)}
                  />
                ))}
              </linearGradient>
            </defs>
            <path
              d={WAVE_PATH}
              fill="none"
              stroke="url(#tcp-hue-wave)"
              strokeWidth={5}
              strokeLinecap="round"
              opacity={0.72}
            />
          </svg>
          {/* 拖动把手：位于波形中线上，按色相比例水平定位 */}
          <span
            className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-sm"
            style={{
              left: `${(hsl.h / 360) * 100}%`,
              backgroundColor: normalizedSource,
              borderColor: v('--md-sys-color-surface', '#ffffff'),
            }}
            aria-hidden="true"
          />
        </div>

        <div
          ref={dialRef}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            applyDialPointer(e.clientX, e.clientY)
          }}
          onPointerMove={(e) => {
            if (
              e.buttons === 0 ||
              !e.currentTarget.hasPointerCapture(e.pointerId)
            )
              return
            applyDialPointer(e.clientX, e.clientY)
          }}
          className="touch-slider relative h-14 w-14 shrink-0 cursor-pointer select-none"
          title={`饱和度 ${Math.round(hsl.s)}%`}
          role="slider"
          aria-label="饱和度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsl.s)}
        >
          <svg
            viewBox="0 0 56 56"
            className="block h-full w-full"
            aria-hidden="true"
          >
            {/* 刻度点环 */}
            <circle
              cx="28"
              cy="28"
              r="26"
              fill="none"
              stroke="var(--md-sys-color-outline)"
              strokeWidth="1.5"
              strokeDasharray="1.2 4.9"
              opacity="0.8"
            />
            {/* 盘面 = 当前种子色实时着色 */}
            <circle
              cx="28"
              cy="28"
              r="18"
              fill={normalizedSource}
              stroke="var(--md-sys-color-outline-variant)"
              strokeWidth="0.5"
            />
            {/* 旋钮指针：-135°(0%) ~ +135°(100%) */}
            <g transform={`rotate(${knobAngle} 28 28)`}>
              <line
                x1="28"
                y1="13"
                x2="28"
                y2="6"
                stroke={onColorFor(normalizedSource)}
                strokeWidth="2"
                strokeLinecap="round"
              />
            </g>
          </svg>
        </div>
      </div>
    </div>
  )
}

/** 操作行圆形图标按钮（+ / − / 调色盘） */
function ToolButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-35'
          : 'hover:bg-[var(--md-sys-color-surface-container-highest)] active:scale-90'
      )}
      style={{ color: 'var(--md-sys-color-on-surface)' }}
    >
      {children}
    </button>
  )
}

/** 色板行翻页箭头 */
function ArrowButton({
  dir,
  disabled,
  onClick,
}: {
  dir: -1 | 1
  disabled: boolean
  onClick: () => void
}) {
  const Icon = dir === -1 ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={dir === -1 ? '向左滚动' : '向右滚动'}
      aria-label={dir === -1 ? '向左滚动色板' : '向右滚动色板'}
      className={cn(
        'flex h-7 w-5 shrink-0 items-center justify-center transition-opacity',
        disabled ? 'opacity-25' : 'opacity-60 hover:opacity-100'
      )}
      style={{ color: 'var(--md-sys-color-on-surface)' }}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

/** 色板圆点：预设/自定义通用，选中态勾选，自定义支持右键移除 */
function SwatchDot({
  color,
  name,
  active,
  onPick,
  onRemove,
  v,
}: {
  color: string
  name: string
  active: boolean
  onPick: () => void
  onRemove?: () => void
  v: (key: string, fallback: string) => string
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      onContextMenu={
        onRemove
          ? (e) => {
              e.preventDefault()
              onRemove()
            }
          : undefined
      }
      title={name}
      aria-label={name}
      aria-pressed={active}
      className="relative h-7 w-7 shrink-0 rounded-full border transition-transform hover:scale-110 active:scale-95"
      style={{
        backgroundColor: color,
        borderColor: active
          ? v('--md-sys-color-primary', 'var(--md-sys-color-outline)')
          : 'var(--md-sys-color-outline)',
      }}
    >
      {active && (
        <Check
          className="absolute inset-0 m-auto h-4 w-4 drop-shadow"
          style={{ color: onColorFor(color) }}
        />
      )}
    </button>
  )
}
