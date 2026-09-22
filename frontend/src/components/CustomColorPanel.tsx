/**
 * Zen 浏览器风格的高级自定义主题色侧栏面板（UI 1:1 对齐 Zen theme creator）：
 *
 * 页 1（色板页，默认）：
 * - 模式页签：跟随系统 ✨ / 浅色 ☀ / 深色 🌙（auto 由 ThemeProvider 监听
 *   系统偏好并物化 isDark）
 * - 预览区：点状纹理底；无自定义颜色时居中「点击添加颜色」，点击或 ＋
 *   进入取色页；已有颜色则显示颜色层条（点击应用该颜色）
 * - 操作行：＋ 添加颜色 / － 移除选中颜色 / 骰子 随机主题色
 * - 色板行：‹ › 箭头翻页，预设色 + 自定义色圆点，点击应用
 * - 波形条（色相 0-360°，正弦波）+ 旋钮（明度 0-100%，-135°~+135° 表盘）：
 *   实时调整当前主题色；若当前色在自定义色板中则原位更新该颜色层
 *
 * 页 2（取色页）：SV 二维区 + 色相条 + Hex 输入，拖动实时预览（写入
 * sourceColor），取消恢复进入前颜色，「添加颜色」写入自定义色板并回到色板页。
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
} from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'
import {
  DEFAULT_SEED,
  PRESET_SEEDS,
  hexToHsv,
  hsvToHex,
  normalizeHexColor,
  type HsvColor,
} from '@/lib/themes'
import { hexToRgb, relativeLuminance } from '@/lib/bgContrast'
import { cn } from '@/lib/utils'

/** 取色页 HSV 兜底值 */
const FALLBACK_HSV: HsvColor = { h: 214, s: 90, v: 80 }

/** 面板展开宽度（px），与自定义背景侧面板同级 */
const PANEL_WIDTH = 300

/** 波形条 SVG 参数（viewBox 固定，横向随容器微缩放） */
const WAVE_W = 180
const WAVE_H = 40
const WAVE_MID = 20
const WAVE_AMP = 8.5
const WAVE_LEN = 46
/** 旋钮可用角度：-135°~+135°（0° 朝上），映射明度 0-100% */
const DIAL_RANGE_DEG = 270

/** 正弦波形 path（3px 折线，视觉平滑） */
function buildWavePath(): string {
  const parts: string[] = []
  for (let x = 0; x <= WAVE_W; x += 3) {
    const y = WAVE_MID + WAVE_AMP * Math.sin((x / WAVE_LEN) * Math.PI * 2)
    parts.push(`${x === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(2)}`)
  }
  return parts.join(' ')
}
const WAVE_PATH = buildWavePath()

/** 深浅模式页签定义（✨ = 跟随系统，与 Zen 主题页签同构） */
const MODE_TABS = [
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
  const customColors = useThemeStore((s) => s.customColors)
  const addCustomColor = useThemeStore((s) => s.addCustomColor)
  const removeCustomColor = useThemeStore((s) => s.removeCustomColor)
  const updateCustomColor = useThemeStore((s) => s.updateCustomColor)

  /** 当前种子色的规范化形式（非法持久化值兜底默认种子） */
  const currentHex = normalizeHexColor(sourceColor) ?? DEFAULT_SEED
  const currentHsv = hexToHsv(currentHex) ?? FALLBACK_HSV
  const currentIsCustom = customColors.includes(currentHex)

  // ===== 面板页与取色草稿（本地状态；重开面板复位到色板页） =====
  const [page, setPage] = useState<'palette' | 'picker'>('palette')
  const [draft, setDraft] = useState<HsvColor>(FALLBACK_HSV)
  const draftHex = hsvToHex(draft.h, draft.s, draft.v)
  const [hexText, setHexText] = useState(DEFAULT_SEED)
  /** 进入取色页前的种子色（取消时恢复） */
  const restoreHexRef = useRef(DEFAULT_SEED)

  // 渲染期状态调整（官方 prop-change 模式）：面板展开瞬间复位到色板页
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setPage('palette')
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

  /** 「添加颜色」：入自定义色板 + 应用 + 回色板页 */
  const confirmPick = useCallback(() => {
    addCustomColor(draftHex)
    setSourceColor(draftHex)
    setPage('palette')
  }, [addCustomColor, draftHex, setSourceColor])

  /** 取消取色：恢复进入前颜色 */
  const cancelPick = useCallback(() => {
    setSourceColor(restoreHexRef.current)
    setPage('palette')
  }, [setSourceColor])

  /** 色板页改色入口：写 store；若当前色在自定义色板中则原位更新该颜色层 */
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

  // ===== 波形条（色相）拖动 =====
  const waveRef = useRef<HTMLDivElement>(null)
  const applyWavePointer = useCallback(
    (clientX: number) => {
      const el = waveRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const hue =
        Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * 360
      applySeed(hsvToHex(hue, currentHsv.s, currentHsv.v))
    },
    [applySeed, currentHsv.s, currentHsv.v]
  )

  // ===== 旋钮（明度）拖动 =====
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
      applySeed(hsvToHex(currentHsv.h, currentHsv.s, ratio * 100))
    },
    [applySeed, currentHsv.h, currentHsv.s]
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
        {page === 'palette' ? (
          <>
            {/* ===== 模式页签（跟随系统/浅色/深色） ===== */}
            <div
              className="mx-auto flex w-fit shrink-0 items-center gap-0.5 rounded-full p-1"
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
                        : 'opacity-50 transition-opacity hover:opacity-90'
                    )}
                    style={
                      active
                        ? {
                            backgroundColor:
                              'var(--md-sys-color-surface-container-highest)',
                          }
                        : undefined
                    }
                  >
                    <Icon
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                    />
                  </button>
                )
              })}
            </div>

            {/* ===== 预览区：点状纹理底（空态文案 / 颜色层条） ===== */}
            <div
              className="relative mt-3 w-full shrink-0 overflow-hidden rounded-xl"
              style={{
                height: 176,
                backgroundColor: 'var(--md-sys-color-surface-container)',
                backgroundImage: `radial-gradient(${'var(--md-sys-color-outline-variant)'} 1px, transparent 1px)`,
                backgroundSize: '10px 10px',
              }}
            >
              {customColors.length === 0 ? (
                <button
                  type="button"
                  onClick={() => openPicker()}
                  className="absolute inset-0 flex w-full cursor-pointer items-center justify-center"
                  title="点击添加颜色"
                >
                  <span
                    className="text-sm font-medium"
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  >
                    点击添加颜色
                  </span>
                </button>
              ) : (
                <div className="absolute inset-0 flex flex-col gap-1.5 overflow-y-auto p-3">
                  {customColors.map((c) => {
                    const active = currentHex === c
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => applySeed(c)}
                        className={cn(
                          'relative flex h-9 w-full shrink-0 items-center rounded-lg px-3 text-left transition-transform active:scale-[0.98]'
                        )}
                        style={{
                          backgroundColor: c,
                          // 选中描边：外圈用面板底色垫开、再一圈按条色明度取
                          // 反差色，保证亮/暗条在面板上都清晰可见
                          boxShadow: active
                            ? `0 0 0 2px var(--md-sys-color-surface-container), 0 0 0 3.5px ${onColorFor(c)}`
                            : 'inset 0 0 0 0.5px rgba(128,128,128,0.4)',
                        }}
                        title={active ? '当前主题色' : '应用该颜色'}
                      >
                        {active && (
                          <Check
                            className="h-4 w-4"
                            style={{ color: onColorFor(c) }}
                          />
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* ===== 操作行：＋ 添加 / － 移除 / 骰子 随机 ===== */}
            <div className="mt-3 flex shrink-0 items-center justify-center gap-2">
              <ActionIconButton title="添加颜色" onClick={() => openPicker()}>
                <Plus className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton
                title={
                  customColors.length === 0
                    ? '暂无可移除的颜色'
                    : '移除选中颜色'
                }
                onClick={removeSelected}
                disabled={customColors.length === 0}
              >
                <Minus className="h-4 w-4" />
              </ActionIconButton>
              <ActionIconButton title="随机主题色" onClick={randomSeed}>
                <Dices className="h-4 w-4" />
              </ActionIconButton>
            </div>

            {/* ===== 色板行：预设 + 自定义，‹ › 翻页 ===== */}
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
                {PRESET_SEEDS.map((seed) => (
                  <SwatchDot
                    key={seed.id}
                    color={seed.color}
                    name={seed.name}
                    active={currentHex === seed.color.toLowerCase()}
                    onPick={() => applySeed(seed.color)}
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

            {/* ===== 波形条（色相）+ 旋钮（明度） ===== */}
            <div className="mt-4 flex shrink-0 items-center gap-3">
              <div
                ref={waveRef}
                className="touch-slider relative min-w-0 flex-1 cursor-pointer select-none"
                title={`色相 ${Math.round(currentHsv.h)}°`}
                role="slider"
                aria-label="色相"
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={Math.round(currentHsv.h)}
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
              >
                <svg
                  viewBox={`0 0 ${WAVE_W} ${WAVE_H}`}
                  preserveAspectRatio="none"
                  className="block h-10 w-full"
                  aria-hidden="true"
                >
                  <path
                    d={WAVE_PATH}
                    fill="none"
                    stroke="var(--md-sys-color-on-surface-variant)"
                    strokeWidth={5}
                    strokeLinecap="round"
                    opacity={0.45}
                  />
                </svg>
                {/* 拖动把手：白色圆点（Zen 同款），按色相比例水平定位 */}
                <span
                  className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md"
                  style={{
                    left: `${(currentHsv.h / 360) * 100}%`,
                    backgroundColor: '#f2f2f2',
                  }}
                  aria-hidden="true"
                />
              </div>

              {/* 旋钮：刻度点环 + 盘面 + 指针，明度 0-100% */}
              <div
                ref={dialRef}
                className="touch-slider relative h-14 w-14 shrink-0 cursor-pointer select-none"
                title={`明度 ${Math.round(currentHsv.v)}%`}
                role="slider"
                aria-label="明度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(currentHsv.v)}
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
              >
                <svg
                  viewBox="0 0 56 56"
                  className="block h-full w-full"
                  aria-hidden="true"
                >
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
                  <circle
                    cx="28"
                    cy="28"
                    r="17"
                    fill="var(--md-sys-color-surface-container-high)"
                    stroke="var(--md-sys-color-outline-variant)"
                    strokeWidth="0.5"
                  />
                  <g
                    transform={`rotate(${
                      -135 + (currentHsv.v / 100) * DIAL_RANGE_DEG
                    } 28 28)`}
                  >
                    <line
                      x1="28"
                      y1="14"
                      x2="28"
                      y2="7"
                      stroke="var(--md-sys-color-on-surface)"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </g>
                </svg>
              </div>
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

/** 操作行圆形图标按钮（＋ / － / 骰子） */
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
