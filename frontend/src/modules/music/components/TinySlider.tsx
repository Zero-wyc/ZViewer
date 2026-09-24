import { useRef } from 'react'

/** 极简滑轨（设置弹窗内嵌）：pointer 拖动即时回调，touch-slider 防触屏滚动 */
export function TinySlider({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  const applyFromClientX = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const snapped = Math.round((min + ratio * (max - min)) / step) * step
    onChange(Math.min(max, Math.max(min, Number(snapped.toFixed(2)))))
  }
  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      className="touch-slider relative h-6 cursor-pointer"
      onPointerDown={(e) => {
        e.preventDefault()
        applyFromClientX(e.clientX)
        const move = (ev: PointerEvent) => applyFromClientX(ev.clientX)
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/20" />
      <div
        className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)]"
        style={{ left: `${pct}%` }}
      />
    </div>
  )
}
