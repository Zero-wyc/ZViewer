/**
 * Zen 浏览器主题编辑器（theme editor）风格的自定义主题面板：
 * 按 Zen 编辑器的五段式垂直布局 1:1 重写（零延迟反馈，所见即所得）：
 *
 * 1. 模式切换区：✨ 跟随系统 / ☀ 浅色 / 🌙 深色 三个圆钮（aria-pressed，
 *    auto 由 ThemeProvider 监听系统偏好并物化 isDark）
 * 2. 自定义颜色区：「点击添加颜色」提示（点击进入取色页）+ 操作行
 *    [+] [-] 强度调节（±10，0-100）· [🎨] 取色器（进入取色页）
 *    · [🎲] 随机主题色 · [🗑] 移除选中自定义色（ZViewer 扩展）
 * 3. 预设色板：Zen 官方 10 色（白/粉/亮粉/红/橙/金/绿/蓝/紫/黑）+ 自定义
 *    色板，横向滚动圆点，‹ › 翻页
 * 4. 实时预览：波浪线 SVG（stroke = 实际生效色）+ 圆形预览框（当前色）
 *    + hex 标签
 *
 * 颜色强度（colorIntensity，对齐 Zen zen.theme.color-intensity）：种子色
 * 与深浅模式基底中性色的 color-mix 比例，由 ThemeProvider 经
 * resolveEffectiveSeed 合成 Monet 派生色板的实际输入；100 = 纯色。
 *
 * 页 2（取色页）：SV 二维区 + 色相条 + Hex 输入，拖动实时预览（写入
 * sourceColor），取消恢复进入前颜色，「添加颜色」写入自定义色板并回编辑器页。
 *
 * 状态模型：颜色直连 themeStore（无 props 回流，写路径与预设按钮一致）；
 * 页/草稿为组件本地状态，面板重开时经渲染期 prevOpen 检查复位。
 * 面板内联于主题菜单侧栏（滚动容器内不做悬浮弹层，规避双轴裁剪）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Sparkles,
  Sun,
  Moon,
  Plus,
  Minus,
  Dices,
  Check,
  ChevronLeft,
  ChevronRight,
  Pipette,
  Trash2,
} from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'
import {
  DEFAULT_SEED,
  EDITOR_PRESET_COLORS,
  hexToHsv,
  hsvToHex,
  normalizeHexColor,
  resolveEffectiveSeed,
  type HsvColor,
} from '@/lib/themes'
import { hexToRgb, relativeLuminance } from '@/lib/bgContrast'
import { cn } from '@/lib/utils'

/** 取色页 HSV 兜底值 */
const FALLBACK_HSV: HsvColor = { h: 214, s: 90, v: 80 }

/** 面板展开宽度（px），与自定义背景侧面板同级 */
const PANEL_WIDTH = 300

/** 强度调节步长（±/次），与 Zen 编辑器 [+] [-] 按钮同语义 */
const INTENSITY_STEP = 10

/** 预览波浪线 SVG（Zen 编辑器同款 path，viewBox 0 0 100 20） */
const WAVE_PATH = 'M0,10 Q25,0 50,10 T100,10'

/** 深浅模式页签定义（✨ = 跟随系统，与 Zen 主题编辑器同构） */
const MODE_BUTTONS = [
  { value: 'auto', icon: Sparkles, label: '跟随系统' },
  { value: 'light', icon: Sun, label: '浅色' },
  { value: 'dark', icon: Moon, label: '深色' },
] as const

/** 按背景亮度返回可读的文字/指针颜色 */
function onColorFor(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return '#ffffff'
  return relativeLuminance(rgb) > 0.4 ? '#1a1a1c' : '#ffffff'
}

export function CustomColorPanel({
  open,
}: {
  open: boolean
  onClose: () => void
}) {
  const sourceColor = useThemeStore((s) => s.sourceColor)
  const setSourceColor = useThemeStore((s) => s.setSourceColor)
  const mode = useThemeStore((s) => s.mode)
  const setMode = useThemeStore((s) => s.setMode)
  const isDark = useThemeStore((s) => s.isDark)
  const colorIntensity = useThemeStore((s) => s.colorIntensity)
  const setColorIntensity = useThemeStore((s) => s.setColorIntensity)
  const customColors = useThemeStore((s) => s.customColors)
  const addCustomColor = useThemeStore((s) => s.addCustomColor)
  const removeCustomColor = useThemeStore((s) => s.removeCustomColor)
  const updateCustomColor = useThemeStore((s) => s.updateCustomColor)

  /** 当前种子色的规范化形式（非法持久化值兜底默认种子） */
  const currentHex = normalizeHexColor(sourceColor) ?? DEFAULT_SEED
  const currentIsCustom = customColors.includes(currentHex)
  /** 实际生效色：种子经强度与基底混合后的结果（预览与派生同源） */
  const effectiveHex = resolveEffectiveSeed(currentHex, isDark, colorIntensity)

  // ===== 面板页与取色草稿（本地状态；重开面板复位到编辑器页） =====
  const [page, setPage] = useState<'editor' | 'picker'>('editor')
  const [draft, setDraft] = useState<HsvColor>(FALLBACK_HSV)
  const draftHex = hsvToHex(draft.h, draft.s, draft.v)
  const [hexText, setHexText] = useState(DEFAULT_SEED)
  /** 进入取色页前的种子色（取消时恢复） */
  const restoreHexRef = useRef(DEFAULT_SEED)

  // 渲染期状态调整（官方 prop-change 模式）：面板展开瞬间复位到编辑器页
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setPage('editor')
  }

  /** 进入取色页：草稿初始化为 baseHex（缺省当前种子色），记录恢复点 */
  const openPicker = useCallback(
    (baseHex?: string) => {
      const hex = normalizeHexColor(baseHex ?? sourceColor) ?? DEFAULT_SEED
      restoreHexRef.current = hex
      setDraft(hexToHsv(hex) ?? FALLBACK_HSV)
      setHexText(hex)
      setPage('picker')
    },
    [sourceColor]
  )

  /** 取色页统一改色（实时预览：直接写 store，取消时恢复 restoreHexRef） */
  const applyPick = useCallback(
    (h: number, s: number, v: number) => {
      const next: HsvColor = {
        h: ((h % 360) + 360) % 360,
        s: Math.min(100, Math.max(0, s)),
        v: Math.min(100, Math.max(0, v)),
      }
      const hex = hsvToHex(next.h, next.s, next.v)
      setDraft(next)
      setHexText(hex)
      setSourceColor(hex)
    },
    [setSourceColor]
  )

  /** 「添加颜色」：入自定义色板 + 应用 + 回编辑器页 */
  const confirmPick = useCallback(() => {
    addCustomColor(draftHex)
    setSourceColor(draftHex)
    setPage('editor')
  }, [addCustomColor, draftHex, setSourceColor])

  /** 取消取色：恢复进入前颜色 */
  const cancelPick = useCallback(() => {
    setSourceColor(restoreHexRef.current)
    setPage('editor')
  }, [setSourceColor])

  /** 编辑器页改色入口：写 store；若当前色在自定义色板中则原位更新该颜色层 */
  const applySeed = useCallback(
    (hex: string) => {
      const normalized = normalizeHexColor(hex)
      if (!normalized) return
      if (currentIsCustom && normalized !== currentHex) {
        updateCustomColor(currentHex, normalized)
      }
      setSourceColor(normalized)
    },
    [currentIsCustom, currentHex, setSourceColor, updateCustomColor]
  )

  /** 强度调节（[+] [-] 按钮，±10，0-100 夹取；实时生效无需确认） */
  const adjustIntensity = useCallback(
    (delta: number) => {
      setColorIntensity(colorIntensity + delta)
    },
    [colorIntensity, setColorIntensity]
  )

  /** 移除选中的自定义色（当前色不在色板时移除最早一条） */
  const removeSelected = useCallback(() => {
    if (customColors.length === 0) return
    if (currentIsCustom) {
      removeCustomColor(currentHex)
      const rest = customColors.filter((c) => c !== currentHex)
      setSourceColor(rest[rest.length - 1] ?? DEFAULT_SEED)
    } else {
      removeCustomColor(customColors[customColors.length - 1])
    }
  }, [
    customColors,
    currentHex,
    currentIsCustom,
    removeCustomColor,
    setSourceColor,
  ])

  /** 随机主题色（舒适区间随机 HSV，实时应用） */
  const randomSeed = useCallback(() => {
    applySeed(
      hsvToHex(
        Math.random() * 360,
        55 + Math.random() * 30,
        42 + Math.random() * 20
      )
    )
  }, [applySeed])

  // ===== 色板行箭头可用态 =====
  const swatchScrollRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  const updateArrows = useCallback(() => {
    const el = swatchScrollRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }, [])
  const prevColorsKey = customColors.join(',')
  // 色板内容变化后箭头可用态复测（effect 内访问 ref 为合法场景）
  useEffect(updateArrows, [updateArrows, prevColorsKey])

  // ===== 取色页拖动 =====
  const svRef = useRef<HTMLDivElement>(null)
  const applySvPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = svRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const s = ((clientX - rect.left) / rect.width) * 100
      const v = (1 - (clientY - rect.top) / rect.height) * 100
      applyPick(draft.h, s, v)
    },
    [applyPick, draft.h]
  )
  const hueRef = useRef<HTMLDivElement>(null)
  const applyHuePointer = useCallback(
    (clientX: number) => {
      const el = hueRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      applyPick(((clientX - rect.left) / rect.width) * 360, draft.s, draft.v)
    },
    [applyPick, draft.s, draft.v]
  )
  const handleHexText = (raw: string) => {
    setHexText(raw)
    if (/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(raw.trim())) {
      const hsv = hexToHsv(raw)
      if (hsv) applyPick(hsv.h, hsv.s, hsv.v)
    }
  }

  return (
    /* 宽度收起容器：默认 0（收起），open 时 300px 动画展开（对齐自定义
       背景侧面板）；内层固定宽度避免动画期间内容回流挤压 */
    <div
      className="h-full flex-shrink-0 overflow-hidden"
      style={{
        width: open ? PANEL_WIDTH : 0,
        transition: 'width 240ms var(--ease-out-expo)',
        willChange: 'width',
      }}
    >
      <div className="flex h-full w-[300px] flex-col overflow-hidden border-r border-[var(--glass-border)] p-4">
        {page === 'editor' ? (
          <>
            {/* ===== ① 模式切换区：✨ / ☀ / 🌙 三圆钮（aria-pressed） ===== */}
            <div className="flex shrink-0 items-center justify-center gap-3">
              {MODE_BUTTONS.map((btn) => {
                const active = mode === btn.value
                const Icon = btn.icon
                return (
                  <button
                    key={btn.value}
                    type="button"
                    aria-pressed={active}
                    aria-label={btn.label}
                    title={btn.label}
                    onClick={() => setMode(btn.value)}
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-full transition-all',
                      active
                        ? 'scale-105 shadow-sm'
                        : 'opacity-45 hover:scale-105 hover:opacity-85'
                    )}
                    style={{
                      backgroundColor: active
                        ? 'var(--md-sys-color-primary-container)'
                        : 'var(--md-sys-color-surface-container-high)',
                    }}
                  >
                    <Icon
                      className="h-[18px] w-[18px]"
                      style={{
                        color: active
                          ? 'var(--md-sys-color-on-primary-container)'
                          : 'var(--md-sys-color-on-surface)',
                      }}
                    />
                  </button>
                )
              })}
            </div>

            {/* ===== ② 自定义颜色区：「点击添加颜色」提示 + 操作行 ===== */}
            <button
              type="button"
              onClick={() => openPicker()}
              className="mt-4 flex w-full shrink-0 cursor-pointer items-center justify-center rounded-lg py-1 text-sm font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              点击添加颜色
            </button>
            <div className="mt-2 flex shrink-0 items-center justify-center gap-1.5">
              <ActionIconButton
                title={`增强颜色（当前 ${colorIntensity}%）`}
                onClick={() => adjustIntensity(INTENSITY_STEP)}
                disabled={colorIntensity >= 100}
              >
                <Plus className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton
                title={`减弱颜色（当前 ${colorIntensity}%）`}
                onClick={() => adjustIntensity(-INTENSITY_STEP)}
                disabled={colorIntensity <= 0}
              >
                <Minus className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton title="打开取色器" onClick={() => openPicker()}>
                <Pipette className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton title="随机主题色" onClick={randomSeed}>
                <Dices className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton
                title={
                  customColors.length === 0
                    ? '暂无可移除的颜色'
                    : '移除选中的自定义颜色'
                }
                onClick={removeSelected}
                disabled={customColors.length === 0}
              >
                <Trash2 className="h-4 w-4" />
              </ActionIconButton>
              <span
                className="w-10 shrink-0 text-right text-xs tabular-nums"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                aria-label={`颜色强度 ${colorIntensity}%`}
              >
                {colorIntensity}%
              </span>
            </div>

            {/* ===== ③ 预设色板：Zen 10 色 + 自定义色，‹ › 翻页 ===== */}
            <div className="mt-3 flex shrink-0 items-center gap-0.5">
              <ArrowButton
                dir={-1}
                disabled={!canLeft}
                onClick={() =>
                  swatchScrollRef.current?.scrollBy({
                    left: -120,
                    behavior: 'smooth',
                  })
                }
              />
              <div
                ref={swatchScrollRef}
                onScroll={updateArrows}
                className="hide-scrollbar flex flex-1 items-center gap-2.5 overflow-x-auto px-1 py-1"
              >
                {EDITOR_PRESET_COLORS.map((preset) => (
                  <SwatchDot
                    key={preset.color}
                    color={preset.color}
                    name={preset.name}
                    active={currentHex === preset.color.toLowerCase()}
                    onPick={() => applySeed(preset.color)}
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
                {customColors.map((c) => (
                  <SwatchDot
                    key={c}
                    color={c}
                    name="自定义颜色"
                    active={currentHex === c}
                    onPick={() => applySeed(c)}
                  />
                ))}
              </div>
              <ArrowButton
                dir={1}
                disabled={!canRight}
                onClick={() =>
                  swatchScrollRef.current?.scrollBy({
                    left: 120,
                    behavior: 'smooth',
                  })
                }
              />
            </div>

            {/* ===== ④ 实时预览：波浪线（生效色描边）+ 圆形预览框 + hex ===== */}
            <div className="mt-5 flex shrink-0 flex-col items-center">
              <svg
                viewBox="0 0 100 20"
                preserveAspectRatio="none"
                className="block h-10 w-full"
                aria-hidden="true"
              >
                <path
                  d={WAVE_PATH}
                  fill="none"
                  stroke={effectiveHex}
                  strokeWidth={2}
                  strokeLinecap="round"
                  style={{ transition: 'stroke 0.3s ease' }}
                />
              </svg>
              <span
                className="mt-4 block h-14 w-14 rounded-full transition-colors"
                style={{
                  backgroundColor: effectiveHex,
                  border: '2px solid var(--md-sys-color-outline-variant)',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
                }}
                aria-hidden="true"
              />
              <span
                className="mt-2 text-xs tabular-nums"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                {currentHex}
                {colorIntensity < 100 && (
                  <span className="ml-1 opacity-70">
                    · 强度 {colorIntensity}%
                  </span>
                )}
              </span>
            </div>
          </>
        ) : (
          /* ===== 取色页：SV 二维区 + 色相条 + Hex + 取消/添加 ===== */
          <>
            <div
              ref={svRef}
              className="relative h-48 w-full shrink-0 cursor-crosshair select-none overflow-hidden rounded-xl"
              style={{
                backgroundColor: hsvToHex(draft.h, 100, 100),
                backgroundImage:
                  'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))',
                touchAction: 'none',
              }}
              role="slider"
              aria-label="饱和度与明度"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                applySvPointer(e.clientX, e.clientY)
              }}
              onPointerMove={(e) => {
                if (
                  e.buttons === 0 ||
                  !e.currentTarget.hasPointerCapture(e.pointerId)
                )
                  return
                applySvPointer(e.clientX, e.clientY)
              }}
            >
              <span
                className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
                style={{
                  left: `${draft.s}%`,
                  top: `${100 - draft.v}%`,
                  backgroundColor: draftHex,
                  borderColor: '#ffffff',
                }}
                aria-hidden="true"
              />
            </div>

            <div
              ref={hueRef}
              className="relative mt-3 h-3 w-full shrink-0 cursor-pointer select-none rounded-full"
              style={{
                background:
                  'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
                touchAction: 'none',
              }}
              role="slider"
              aria-label="色相"
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={Math.round(draft.h)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                applyHuePointer(e.clientX)
              }}
              onPointerMove={(e) => {
                if (
                  e.buttons === 0 ||
                  !e.currentTarget.hasPointerCapture(e.pointerId)
                )
                  return
                applyHuePointer(e.clientX)
              }}
            >
              <span
                className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
                style={{
                  left: `${(draft.h / 360) * 100}%`,
                  backgroundColor: hsvToHex(draft.h, 100, 100),
                  borderColor: '#ffffff',
                }}
                aria-hidden="true"
              />
            </div>

            {/* 当前色预览 + Hex 输入 */}
            <div className="mt-3 flex items-center gap-2">
              <span
                className="h-8 w-8 shrink-0 rounded-full border"
                style={{
                  backgroundColor: draftHex,
                  borderColor: 'var(--md-sys-color-outline)',
                }}
                aria-hidden="true"
              />
              <input
                type="text"
                value={hexText}
                onChange={(e) => handleHexText(e.target.value)}
                spellCheck={false}
                aria-label="Hex 颜色值"
                className="h-8 w-full min-w-0 flex-1 rounded-md px-2 text-xs tabular-nums outline-none"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                  color: 'var(--md-sys-color-on-surface)',
                  border: '1px solid var(--md-sys-color-outline-variant)',
                }}
              />
            </div>

            {/* 取消 / 添加颜色 */}
            <div className="mt-4 flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={cancelPick}
                className="h-9 flex-1 rounded-full text-sm font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmPick}
                className="h-9 flex-1 rounded-full text-sm font-medium shadow-sm transition-transform active:scale-[0.98]"
                style={{
                  backgroundColor: draftHex,
                  color: onColorFor(draftHex),
                }}
              >
                添加颜色
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 操作行圆形图标按钮（强度 +/- / 取色器 / 骰子 / 移除） */
function ActionIconButton({
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

/** 色板圆点：预设/自定义通用，选中态勾选 */
function SwatchDot({
  color,
  name,
  active,
  onPick,
}: {
  color: string
  name: string
  active: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={name}
      aria-label={name}
      aria-pressed={active}
      className="relative h-7 w-7 shrink-0 rounded-full transition-transform hover:scale-110 active:scale-95"
      style={{
        backgroundColor: color,
        // 选中：面板底色垫开一圈 + primary 描边；未选中：细灰描边防过浅
        boxShadow: active
          ? '0 0 0 2px var(--md-sys-color-surface-container), 0 0 0 3.5px var(--md-sys-color-primary)'
          : 'inset 0 0 0 0.5px rgba(128,128,128,0.45)',
      }}
    >
      {active && (
        <Check
          className="absolute inset-0 m-auto h-4 w-4"
          style={{ color: onColorFor(color) }}
        />
      )}
    </button>
  )
}
