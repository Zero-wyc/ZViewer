/**
 * Zen 浏览器主题编辑器（theme editor）风格的自定义主题面板。
 *
 * ============================ 逻辑模型 ============================
 * 单向数据流：所有 UI 动作 → 唯一的显式 store action，无隐式副作用。
 *
 * Store 状态（三个正交维度，互不纠缠）：
 * - sourceColor    当前主题种子色（纯色，#rrggbb）
 * - customColors   收藏色板（纯存储：只有 add/remove 两种操作，
 *                  绝不会被其他动作隐式改写）
 * - colorIntensity 颜色强度 0-100（种子与深浅基底的 color-mix 比例，
 *                  独立于颜色选择的视觉参数；100 = 纯色）
 *
 * 派生值：
 * - currentHex     sourceColor 的规范化形式
 * - effectiveHex   resolveEffectiveSeed(currentHex, isDark, intensity)
 *                  实际生效色——预览区展示的就是它，与全局主题一致
 * - currentIsCustom 当前色 ∈ customColors，仅用于 🗑 可用态与圆点选中
 *
 * 动作映射（每个控件恰好一个语义）：
 * - 色板圆点 / 预设色   → setSourceColor(hex)（纯切换，零副作用）
 * - [🎲] 随机          → setSourceColor(随机色)
 * - [🎨] / 提示行      → 进入取色页（进入时判定模式：当前色 ∈ 收藏板
 *                        则为「编辑该条目」，否则为「新增收藏」）
 * - 取色页拖动          → setSourceColor（实时预览，所见即所得）
 * - 取色页「保存」      → 编辑模式：updateCustomColor(原色, 新色)（位置
 *                        不变）；新增模式：addCustomColor(当前色)
 * - 取色页「取消」      → setSourceColor(进入前颜色) + 回编辑器页
 * - [🗑] 移除          → 仅当前色已被收藏时可用：removeCustomColor
 *                        (当前色)；只移出收藏板，不改变正在使用的主题色
 * - 强度滑块 / [±5]    → setColorIntensity
 *
 * 取色页草稿的恢复点（restoreHexRef）在「进入取色页」时记录一次，
 * 面板被外部关闭时草稿页状态随 prevOpen 复位逻辑一并复位。
 * ==================================================================
 *
 * 视觉布局对齐 Zen theme editor 五段式：
 * ① 模式切换三圆钮（✨/☀/🌙，aria-pressed；auto 由 ThemeProvider 物化）
 * ② 「点击添加颜色」提示 + 操作行（[+][-] 强度微调 / 🎨 / 🎲 / 🗑）
 *    + 强度滑块（连续 0-100）
 * ③ 预设色板（Zen 官方 10 色）+ 收藏色板，横向滚动
 * ④ 实时预览：波浪线 SVG + 圆形预览框 + hex 标签（均显示实际生效色）
 * 取色页：SV 二维区 + 色相条 + Hex 输入 + 取消/保存。
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
import { Slider } from '@/components/ui/Slider'
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

/** 强度 [±] 微调步长（连续调节由滑块承担） */
const INTENSITY_STEP = 5

/** 预览波浪线 SVG（Zen 编辑器同款 path，viewBox 0 0 100 20） */
const WAVE_PATH = 'M0,10 Q25,0 50,10 T100,10'

/** 深浅模式圆钮定义（✨ = 跟随系统，与 Zen 主题编辑器同构） */
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
  // ===== store 状态（组件内只读派生，所有写入都走显式 action） =====
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

  /** 当前主题种子色（规范化；非法持久化值兜底默认种子） */
  const currentHex = normalizeHexColor(sourceColor) ?? DEFAULT_SEED
  /** 实际生效色（强度混合后）——预览区与全局主题同源同值 */
  const effectiveHex = resolveEffectiveSeed(currentHex, isDark, colorIntensity)
  /** 当前色是否已被收藏（仅控制 🗑 可用态与收藏圆点选中态） */
  const currentIsCustom = customColors.includes(currentHex)

  // ===== 页面状态（本地；面板重开时复位到编辑器页） =====
  const [page, setPage] = useState<'editor' | 'picker'>('editor')
  /** 取色页草稿（HSV），拖动时同步写 store 实现实时预览 */
  const [draft, setDraft] = useState<HsvColor>(FALLBACK_HSV)
  const draftHex = hsvToHex(draft.h, draft.s, draft.v)
  const [hexText, setHexText] = useState(DEFAULT_SEED)
  /** 进入取色页时的颜色（「取消」恢复点） */
  const restoreHexRef = useRef(DEFAULT_SEED)
  /**
   * 取色页模式：非 null = 「编辑已有收藏」（值为被编辑的收藏色），保存时
   * 原位更新该条目（位置不变）；null = 新增收藏。进入取色页时一次性判定。
   */
  const [editingHex, setEditingHex] = useState<string | null>(null)

  // 渲染期状态调整（官方 prop-change 模式）：面板展开瞬间复位到编辑器页，
  // 并清除上一次的取色编辑模式
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) {
      setPage('editor')
      setEditingHex(null)
    }
  }

  // ===== 动作：切换颜色（色板圆点 / 随机色共用的唯一写路径） =====
  const applyColor = useCallback(
    (hex: string) => {
      const normalized = normalizeHexColor(hex)
      if (!normalized) return
      setSourceColor(normalized)
    },
    [setSourceColor]
  )

  /** 随机主题色（舒适区间随机 HSV） */
  const randomColor = useCallback(() => {
    applyColor(
      hsvToHex(
        Math.random() * 360,
        55 + Math.random() * 30,
        42 + Math.random() * 20
      )
    )
  }, [applyColor])

  // ===== 动作：移除当前色（仅当已被收藏时可用，语义唯一） =====
  /** 只把当前色移出收藏板——「移除收藏」不改变正在使用的主题色 */
  const removeCurrent = useCallback(() => {
    if (!currentIsCustom) return
    removeCustomColor(currentHex)
  }, [currentHex, currentIsCustom, removeCustomColor])

  // ===== 动作：取色页 =====
  /** 进入取色页：记录恢复点与模式（当前色是收藏色 → 编辑该条目） */
  const openPicker = useCallback(() => {
    restoreHexRef.current = currentHex
    setEditingHex(currentIsCustom ? currentHex : null)
    setDraft(hexToHsv(currentHex) ?? FALLBACK_HSV)
    setHexText(currentHex)
    setPage('picker')
  }, [currentHex, currentIsCustom])

  /** 取色页统一改色（实时预览写 store；HSV 状态仅驱动取色器自身） */
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

  /**
   * 「保存」：按进入取色页时的模式分流——
   * - 编辑模式（进入时当前色是收藏色）：原位更新该收藏条目（位置不变）；
   *   若新色恰好已是其他收藏条目，则只保留切换结果、不动色板（避免重复）
   * - 新增模式：收藏当前色（重复收藏由 addCustomColor 去重）
   */
  const savePick = useCallback(() => {
    if (editingHex) {
      updateCustomColor(editingHex, draftHex)
    } else {
      addCustomColor(draftHex)
    }
    setPage('editor')
  }, [addCustomColor, draftHex, editingHex, updateCustomColor])

  /** 「取消」：恢复进入前颜色 + 回编辑器页 */
  const cancelPick = useCallback(() => {
    applyColor(restoreHexRef.current)
    setPage('editor')
  }, [applyColor])

  // ===== 动作：强度（滑块连续调节 + [±] 微调） =====
  const adjustIntensity = useCallback(
    (delta: number) => {
      setColorIntensity(colorIntensity + delta)
    },
    [colorIntensity, setColorIntensity]
  )

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
      <div className="flex h-full w-[300px] flex-col overflow-y-auto border-r border-[var(--glass-border)] p-4">
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

            {/* ===== ② 自定义颜色区：提示行 + 操作行 + 强度滑块 ===== */}
            <button
              type="button"
              onClick={openPicker}
              className="mt-4 flex w-full shrink-0 cursor-pointer items-center justify-center rounded-lg py-1 text-sm font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              点击添加颜色
            </button>
            <div className="mt-2 flex shrink-0 items-center justify-center gap-1.5">
              <ActionIconButton
                title={`减弱颜色强度（当前 ${colorIntensity}%）`}
                onClick={() => adjustIntensity(-INTENSITY_STEP)}
                disabled={colorIntensity <= 0}
              >
                <Minus className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton
                title={`增强颜色强度（当前 ${colorIntensity}%）`}
                onClick={() => adjustIntensity(INTENSITY_STEP)}
                disabled={colorIntensity >= 100}
              >
                <Plus className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton title="打开取色器" onClick={openPicker}>
                <Pipette className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton title="随机主题色" onClick={randomColor}>
                <Dices className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton
                title={
                  currentIsCustom
                    ? '从收藏色板移除当前颜色'
                    : '当前颜色未被收藏'
                }
                onClick={removeCurrent}
                disabled={!currentIsCustom}
              >
                <Trash2 className="h-4 w-4" />
              </ActionIconButton>
            </div>
            <div className="mt-2 shrink-0 px-1">
              <Slider
                size="sm"
                label="颜色强度"
                value={colorIntensity}
                min={0}
                max={100}
                step={1}
                valueFormatter={(v) => `${v}%`}
                onChange={setColorIntensity}
              />
            </div>

            {/* ===== ③ 预设色板：Zen 10 色 + 收藏色，‹ › 翻页 ===== */}
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
                    onPick={() => applyColor(preset.color)}
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
                {/* 收藏色板：过滤掉与预设色重合的条目（否则同一颜色出现
                    两个圆点且 React key 重复）；编辑入口/🗑 的判定仍以
                    完整 customColors 为准 */}
                {customColors
                  .filter(
                    (c) =>
                      !EDITOR_PRESET_COLORS.some(
                        (p) => p.color === c.toLowerCase()
                      )
                  )
                  .map((c) => (
                    <SwatchDot
                      key={c}
                      color={c}
                      name="收藏的颜色"
                      active={currentHex === c}
                      onPick={() => applyColor(c)}
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

            {/* ===== ④ 实时预览：波浪线 + 圆形预览框 + hex（实际生效色） ===== */}
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
          /* ===== 取色页：SV 二维区 + 色相条 + Hex + 取消/保存 ===== */
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

            {/* 取消（恢复进入前颜色）/ 保存（收藏当前色） */}
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
                onClick={savePick}
                className="h-9 flex-1 rounded-full text-sm font-medium shadow-sm transition-transform active:scale-[0.98]"
                style={{
                  backgroundColor: draftHex,
                  color: onColorFor(draftHex),
                }}
              >
                {editingHex ? '保存修改' : '收藏并应用'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 操作行圆形图标按钮（强度 ± / 取色器 / 骰子 / 移除） */
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

/** 色板圆点：预设/收藏通用，选中态勾选 */
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
