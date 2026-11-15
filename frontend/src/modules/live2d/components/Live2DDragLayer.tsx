import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Check, Move, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui'
import { t } from '@/i18n'
import { clampDragOffset } from '../core/drag'
import type { Live2DRenderer } from '../core/live2d-renderer'
import { getEntry, setLocalDrag } from '../core/scene'

// 「拖拽模式」的交互层：一个贴合角色包围盒的可抓取区域 + 一条常驻提示条。
//
// 为什么需要独立一层而不是直接在 canvas 上监听：canvas 是
// `pointer-events: none` 的（否则房间的拖拽、双击全屏、视频控件全被吃掉）。
// 这里用一个和角色同样大小的透明 div 接手势，只有开了拖拽模式才存在，
// 所以平时一点不影响房间的其它交互。
//
// 虚线框的位置每帧重算：待机动作、呼吸、眨眼都会改包围盒，写死一次会很快
// 和角色错位。写 style 而不是 setState——60fps 的 React 更新没有必要。

export interface Live2DDragLayerProps {
  renderer: Live2DRenderer | null
  /** 本人 socket id（只能拖自己） */
  sid: string
  /** 提示条的挂载容器（原生全屏时要进全屏子树） */
  container?: HTMLElement | null
  /** 偏移变化；final=true 表示松手，必须发 */
  onDrag: (x: number, y: number, final: boolean) => void
  onReset: () => void
  onExit: () => void
}

interface Gesture {
  pointerId: number
  startX: number
  startY: number
  baseX: number
  baseY: number
}

export function Live2DDragLayer({
  renderer,
  sid,
  container,
  onDrag,
  onReset,
  onExit,
}: Live2DDragLayerProps) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  // 松手时用它补发终值：中间几帧可能正好落在节流窗口里被丢掉了
  const latestRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    let raf = 0
    let lastKey = ''
    const tick = () => {
      const el = boxRef.current
      if (el) {
        const box = renderer?.boundsOf(sid) ?? null
        const key = box
          ? `${box.x.toFixed(1)},${box.y.toFixed(1)},${box.width.toFixed(1)},${box.height.toFixed(1)}`
          : ''
        if (key !== lastKey) {
          lastKey = key
          if (box) {
            el.style.visibility = 'visible'
            el.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`
            el.style.width = `${box.width}px`
            el.style.height = `${box.height}px`
          } else {
            // 模型没加载出来（或刚被换掉）：框缩起来，提示条还在，能退出
            el.style.visibility = 'hidden'
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [renderer, sid])

  // ESC 退出：拖拽模式下点击空白处不能退出（那会误触），键盘是唯一的
  // 无鼠标退路；提示条上的「完成」是另一条。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // 右键留给菜单，中键留给浏览器的自动滚动
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const entry = getEntry(sid)
    const baseX = entry?.targetDragX ?? 0
    const baseY = entry?.targetDragY ?? 0
    latestRef.current = { x: baseX, y: baseY }
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX,
      baseY,
    }
    // 捕获指针：手指出框、鼠标划出屏幕都不该中断拖拽
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    // 视口尺寸优先取渲染器的：画布铺满整屏，但它才是位置换算的真口径，
    // 窗口刚变过而 innerWidth 还没跟上时两边会差一两帧。
    const view = renderer?.viewport() ?? {
      width: window.innerWidth,
      height: window.innerHeight,
    }
    const rawX =
      gesture.baseX + (event.clientX - gesture.startX) / Math.max(1, view.width)
    const rawY =
      gesture.baseY +
      (event.clientY - gesture.startY) / Math.max(1, view.height)
    // 边界按**模型包围盒**算（渲染器知道真实尺寸）：只按视口比例限位的话，
    // 高个子模型会被推出画面，只剩一个头。
    const next = renderer
      ? renderer.clampOffset(sid, rawX, rawY)
      : clampDragOffset(rawX, rawY)
    latestRef.current = next
    // 本地立刻落地（跟手），网络由宿主按节流发
    setLocalDrag(sid, next.x, next.y)
    onDrag(next.x, next.y, false)
  }

  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onDrag(latestRef.current.x, latestRef.current.y, true)
  }

  return (
    <>
      <div
        ref={boxRef}
        role="presentation"
        // 供冒烟/调试脚本定位（和宿主的 data-live2d-host 同一套用途）
        data-live2d-drag=""
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={() => {
          gestureRef.current = null
        }}
        className="absolute left-0 top-0 cursor-grab touch-none active:cursor-grabbing"
        style={{
          pointerEvents: 'auto',
          visibility: 'hidden',
          border: '1px dashed var(--md-sys-color-primary)',
          borderRadius: 12,
          background:
            'color-mix(in srgb, var(--md-sys-color-primary) 7%, transparent)',
        }}
      />
      {createPortal(
        <div
          className="glass-strong fixed bottom-[84px] left-1/2 z-[120] flex max-w-[calc(100vw-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-full px-3 py-1.5"
          style={{
            pointerEvents: 'auto',
            color: 'var(--md-sys-color-on-surface)',
            boxShadow: '0 12px 32px -8px rgba(0, 0, 0, 0.45)',
          }}
        >
          <Move size={14} className="opacity-60" />
          <span className="whitespace-nowrap text-[11px]">
            {t('拖动角色调整位置')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disableAnimation
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={onReset}
          >
            {t('回到原位')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disableAnimation
            icon={<Check className="h-3.5 w-3.5" />}
            onClick={onExit}
          >
            {t('完成')}
          </Button>
        </div>,
        container ?? document.body
      )}
    </>
  )
}
