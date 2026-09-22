/**
 * 自研网页取色面板（替代系统原生取色器）：
 * - SV 二维区：横轴饱和度、纵轴明度（上层白→透明、下层黑→透明、底层为
 *   当前色相全饱和全明度色），拖动圆点实时改色
 * - 色相条：0-360° 彩虹渐变横条，拖动改色相（保持 S/V）
 * - Hex 输入：完整 3/6 位 hex 即时应用
 * 全部改动实时经 onPick 上报（Material You 即时重生成全站色板）。
 * 面板内联展开于主题菜单侧栏——侧栏是 overflow 滚动容器，悬浮弹层会被
 * 连带 x 轴裁剪（见 MEMORY.md 双轴裁剪教训），故不做 fixed/absolute 弹出。
 */
import { useCallback, useRef, useState } from 'react'
import { hexToHsv, hsvToHex, normalizeHexColor } from '@/lib/themes'

interface CustomColorPanelProps {
  /** 当前种子色（#rrggbb） */
  color: string
  /** 任一控件改色回调（实时应用） */
  onPick: (hex: string) => void
}

export function CustomColorPanel({ color, onPick }: CustomColorPanelProps) {
  /** 草稿 HSV：拖动期本地驱动，与父级 prop 以最终 hex 对齐——拖动产生的
   *  改色使 prop 追平草稿（不回同步）；外部改色（预设/Hex）则重置草稿 */
  const [draft, setDraft] = useState(
    () => hexToHsv(color) ?? { h: 214, s: 90, v: 80 }
  )
  const draftHex = hsvToHex(draft.h, draft.s, draft.v)

  // Hex 输入文本（跟随外部改色；用户正在输入时由 color 未变而不被打断）
  const [hexText, setHexText] = useState(color)

  // 外部改色同步（render 期状态调整，官方 prop-change 模式——避免 effect
  // 内同步 setState 的级联渲染）：拖动自身产生的改色会追平 prop，跳过
  const [prevColor, setPrevColor] = useState(color)
  if (prevColor !== color) {
    setPrevColor(color)
    if (color.toLowerCase() !== draftHex.toLowerCase()) {
      setDraft((prev) => hexToHsv(color) ?? prev)
    }
    setHexText(color)
  }

  /** 统一改色入口：夹取 + 更新草稿 + 实时上报 */
  const apply = useCallback(
    (h: number, s: number, v: number) => {
      const next = {
        h: ((h % 360) + 360) % 360,
        s: Math.min(100, Math.max(0, s)),
        v: Math.min(100, Math.max(0, v)),
      }
      setDraft(next)
      onPick(hsvToHex(next.h, next.s, next.v))
    },
    [onPick]
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

  // ===== Hex 输入（完整 3/6 位 hex 即时应用；非法输入仅暂存不应用） =====
  const handleHexText = (raw: string) => {
    setHexText(raw)
    if (/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(raw.trim())) {
      const hex = normalizeHexColor(raw)
      if (hex) onPick(hex)
    }
  }

  return (
    <div
      className="space-y-2.5 rounded-[var(--md-sys-shape-corner)] p-2.5"
      style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
    >
      {/* SV 二维区：饱和度(横) × 明度(纵)，底层为当前色相的纯色 */}
      <div
        ref={svRef}
        className="relative h-32 w-full cursor-crosshair select-none overflow-hidden rounded-lg"
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
        className="relative h-3 w-full cursor-pointer select-none rounded-full"
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
      <div className="flex items-center gap-2">
        <span
          className="h-7 w-7 shrink-0 rounded-full border"
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
          className="h-7 w-full min-w-0 flex-1 rounded-md px-2 text-xs tabular-nums outline-none"
          style={{
            backgroundColor: 'var(--md-sys-color-surface-container-high)',
            color: 'var(--md-sys-color-on-surface)',
            border: '1px solid var(--md-sys-color-outline-variant)',
          }}
        />
      </div>
    </div>
  )
}
