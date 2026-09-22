/**
 * 自定义主题色侧栏面板（替代系统原生取色器，交互对齐自定义背景侧面板）：
 * - 挂在主题菜单 portal 内、主侧栏左侧，宽度 0↔300px 动画展开
 * - 直连 themeStore（无 props 回流同步）：拖动/输入实时 setSourceColor，
 *   Material You 即时重生成全站色板
 * - 内容：SV 二维区（横=饱和度/纵=明度）+ 色相条 + Hex 输入 + 恢复默认
 *
 * 状态模型（杜绝选择不生效）：本地 HSV 草稿 + lastAppliedHex 哨兵——
 * apply 发出的改色先记哨兵再写 store，渲染期 store 值 ≠ 哨兵即判定为
 * 外部改色（预设点击/重开面板），草稿重置为 store 当前值；拖动自身的
 * 回流则与哨兵一致，草稿不被打断。
 */
import { useCallback, useRef, useState } from 'react'
import { Palette, X } from 'lucide-react'
import { useThemeStore } from '@/store/themeStore'
import {
  DEFAULT_SEED,
  hexToHsv,
  hsvToHex,
  normalizeHexColor,
} from '@/lib/themes'

/** 面板展开宽度（px），与自定义背景侧面板同级 */
const PANEL_WIDTH = 300

const FALLBACK_HSV = { h: 214, s: 90, v: 80 }

export function CustomColorPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const sourceColor = useThemeStore((s) => s.sourceColor)
  const setSourceColor = useThemeStore((s) => s.setSourceColor)

  /** 本地 HSV 草稿（拖动期权威值，避免逐事件 hex→hsv 抖动） */
  const [draft, setDraft] = useState(
    () => hexToHsv(sourceColor) ?? FALLBACK_HSV
  )
  const draftHex = hsvToHex(draft.h, draft.s, draft.v)
  /** Hex 输入文本 */
  const [hexText, setHexText] = useState(sourceColor)
  /** 哨兵：最近一次由本面板写入 store 的 hex（小写）；区分内外改色。
   *  用 state 而非 ref——渲染期需要读取比对（react-hooks/refs 禁止
   *  render 期访问 ref），且它与 draft/hexText 同批更新无时序问题 */
  const [lastAppliedHex, setLastAppliedHex] = useState(
    sourceColor.toLowerCase()
  )

  /** 草稿重置为 store 当前值（外部改色/重开面板时） */
  const resetDraftFromStore = (hex: string) => {
    setLastAppliedHex(hex.toLowerCase())
    setDraft(hexToHsv(hex) ?? FALLBACK_HSV)
    setHexText(hex)
  }

  // 渲染期状态调整（官方 prop-change 模式，规避 effect 内同步 setState）：
  // ① 面板展开瞬间从 store 重建草稿；② store 值 ≠ 哨兵 = 外部改色
  const [prevOpen, setPrevOpen] = useState(open)
  const [prevSource, setPrevSource] = useState(sourceColor)
  if (prevOpen !== open || prevSource !== sourceColor) {
    setPrevOpen(open)
    setPrevSource(sourceColor)
    if (open && sourceColor.toLowerCase() !== lastAppliedHex) {
      resetDraftFromStore(normalizeHexColor(sourceColor) ?? DEFAULT_SEED)
    }
  }

  /** 统一改色入口：夹取 → 记哨兵 → 更新草稿 → 写 store（实时生效） */
  const apply = useCallback(
    (h: number, s: number, v: number) => {
      const next = {
        h: ((h % 360) + 360) % 360,
        s: Math.min(100, Math.max(0, s)),
        v: Math.min(100, Math.max(0, v)),
      }
      const hex = hsvToHex(next.h, next.s, next.v)
      setLastAppliedHex(hex)
      setDraft(next)
      setHexText(hex)
      setSourceColor(hex)
    },
    [setSourceColor]
  )

  // ===== SV 二维区拖动 =====
  const svRef = useRef<HTMLDivElement>(null)
  const applySvPointer = useCallback(
    (clientX: number, clientY: number) => {
      const el = svRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const s = ((clientX - rect.left) / rect.width) * 100
      const v = (1 - (clientY - rect.top) / rect.height) * 100
      apply(draft.h, s, v)
    },
    [apply, draft.h]
  )

  // ===== 色相条拖动 =====
  const hueRef = useRef<HTMLDivElement>(null)
  const applyHuePointer = useCallback(
    (clientX: number) => {
      const el = hueRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      apply(((clientX - rect.left) / rect.width) * 360, draft.s, draft.v)
    },
    [apply, draft.s, draft.v]
  )

  // ===== Hex 输入（完整 3/6 位 hex 即时应用；非法输入仅暂存） =====
  const handleHexText = (raw: string) => {
    setHexText(raw)
    const hex = normalizeHexColor(raw)
    if (hex) {
      setLastAppliedHex(hex)
      setDraft(hexToHsv(hex) ?? FALLBACK_HSV)
      setSourceColor(hex)
    }
  }

  return (
    <div
      className="h-full flex-shrink-0 overflow-hidden"
      style={{
        width: open ? PANEL_WIDTH : 0,
        transition: 'width 240ms var(--ease-out-expo)',
        willChange: 'width',
      }}
    >
      <div className="flex h-full flex-col overflow-hidden border-r border-[var(--glass-border)] p-4">
        {/* 标题栏 */}
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <div className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
            <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
              自定义主题色
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="收起"
            aria-label="收起自定义主题色面板"
            className="rounded-full p-1.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* SV 二维区：饱和度(横) × 明度(纵)，底层为当前色相纯色 */}
        <div
          ref={svRef}
          className="relative h-44 w-full flex-shrink-0 cursor-crosshair select-none overflow-hidden rounded-lg"
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

        {/* 色相条 */}
        <div
          ref={hueRef}
          className="relative mt-3 h-3 w-full flex-shrink-0 cursor-pointer select-none rounded-full"
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

        {/* 恢复默认 */}
        <button
          type="button"
          onClick={() => {
            resetDraftFromStore(DEFAULT_SEED)
            setSourceColor(DEFAULT_SEED)
          }}
          className="mt-3 w-full rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-xs font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          恢复默认主题色
        </button>

        <p
          className="mt-2 text-[11px] leading-relaxed"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          拖动取色实时生效，主题色会自动生成整套深浅配色。
        </p>
      </div>
    </div>
  )
}
