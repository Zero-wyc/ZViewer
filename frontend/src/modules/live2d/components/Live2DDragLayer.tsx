import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Check, Move, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui'
import { t } from '@/i18n'
import { clampDragOffset } from '../core/drag'
import type { Live2DRenderer } from '../core/live2d-renderer'
import { getEntry, setLocalDrag } from '../core/scene'

// 「拖拽模式」的交互层：给每个可拖的角色套一个贴合包围盒的可抓取框 + 一条提示条。
//
// 为什么需要独立一层而不是直接在 canvas 上监听：canvas 是
// `pointer-events: none` 的（否则房间的拖拽、双击全屏、视频控件全被吃掉）。
// 这里用和角色同样大小的透明 div 接手势，只有开了拖拽模式才存在，
// 所以平时一点不影响房间的其它交互。
//
// **所有角色都可拖**（2026-11-22）：位置本来就是本机偏好，谁的角色都能按我
// 的屏幕摆。以前只给本人套框，别人的角色只能改大小；现在每个可见角色都有一
// 个框，拖谁就写谁的本机偏移。
//
// 虚线框的位置每帧重算：待机动作、呼吸、眨眼都会改包围盒，写死一次会很快
// 和角色错位。写 style 而不是 setState——60fps 的 React 更新没有必要，而且
// 一个 rAF 循环就能同时喂所有框（每人一个循环是白烧 CPU）。

export interface Live2DDragLayerProps {
  renderer: Live2DRenderer | null
  /** 可拖拽的角色（按可视次序）。空数组时只剩提示条 */
  sids: string[]
  /** 提示条的挂载容器（原生全屏时要进全屏子树） */
  container?: HTMLElement | null
  /** 偏移变化；final=true 表示松手（宿主据此落本机偏好） */
  onDrag: (sid: string, x: number, y: number, final: boolean) => void
  /** 所有角色回到默认站位 */
  onReset: () => void
  onExit: () => void
}

interface Gesture {
  sid: string
  pointerId: number
  startX: number
  startY: number
  baseX: number
  baseY: number
}

export function Live2DDragLayer({
  renderer,
  sids,
  container,
  onDrag,
  onReset,
  onExit,
}: Live2DDragLayerProps) {
  const boxesRef = useRef(new Map<string, HTMLDivElement>())
  const gestureRef = useRef<Gesture | null>(null)
  // 松手时用它补发终值：中间几帧可能正好落在节流窗口里被丢掉了
  const latestRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    let raf = 0
    // 只在数值真的变了时才写 style：静止的模型不产生任何 DOM 写入。
    const last = new Map<string, string>()
    const tick = () => {
      for (const sid of sids) {
        const el = boxesRef.current.get(sid)
        if (!el) continue
        const box = renderer?.boundsOf(sid) ?? null
        const key = box
          ? `${box.x.toFixed(1)},${box.y.toFixed(1)},${box.width.toFixed(1)},${box.height.toFixed(1)}`
          : ''
        if (last.get(sid) === key) continue
        last.set(sid, key)
        el.style.visibility = box ? 'visible' : 'hidden'
        if (box) {
          el.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`
          el.style.width = `${box.width}px`
          el.style.height = `${box.height}px`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [renderer, sids])

  // ESC 退出：拖拽模式下点击空白处不能退出（那会误触），键盘是唯一的
  // 无鼠标退路；提示条上的「完成」是另一条。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  /** 手势收尾：无论正常抬起、取消还是丢捕获，都要把终值交出去。 */
  const finish = (pointerId: number) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== pointerId) return
    gestureRef.current = null
    onDrag(gesture.sid, latestRef.current.x, latestRef.current.y, true)
  }

  const onPointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    sid: string
  ) => {
    // 右键留给菜单，中键留给浏览器的自动滚动
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const entry = getEntry(sid)
    const baseX = entry?.targetDragX ?? 0
    const baseY = entry?.targetDragY ?? 0
    latestRef.current = { x: baseX, y: baseY }
    gestureRef.current = {
      sid,
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
    // 位置是本机偏好，所以只挡「荒谬值」，**不把模型夹回画面里**：用户可以把
    // 角色拖到完全看不见的地方（临时让出画面）。回位靠提示条上的「回到默认」
    // 或右键菜单里的「回到原位」。
    const next = renderer
      ? renderer.clampOffset(rawX, rawY)
      : clampDragOffset(rawX, rawY)
    latestRef.current = next
    // 本地立刻落地（跟手）；位置不上行，也不需要节流
    setLocalDrag(gesture.sid, next.x, next.y)
    onDrag(gesture.sid, next.x, next.y, false)
  }

  return (
    <>
      {sids.map((sid) => (
        <div
          key={sid}
          ref={(el) => {
            if (el) boxesRef.current.set(sid, el)
            else boxesRef.current.delete(sid)
          }}
          role="presentation"
          // 供冒烟/调试脚本定位（和宿主的 data-live2d-host 同一套用途）
          data-live2d-drag={sid}
          onPointerDown={(event) => onPointerDown(event, sid)}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => finish(event.pointerId)}
          onPointerCancel={(event) => finish(event.pointerId)}
          onLostPointerCapture={(event) => finish(event.pointerId)}
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
      ))}
      {createPortal(
        <div
          // 放**顶部**而不是底部中央：角色就站在画面底部，提示条压在
          // 身上正好盖住最需要看清和拖动的部位。
          className="glass-strong fixed top-[84px] left-1/2 z-[120] flex max-w-[calc(100vw-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-full px-3 py-1.5 max-md:top-[72px]"
          style={{
            pointerEvents: 'auto',
            color: 'var(--md-sys-color-on-surface)',
            boxShadow: '0 12px 32px -8px rgba(0, 0, 0, 0.45)',
          }}
        >
          <Move size={14} className="opacity-60" />
          <span className="whitespace-nowrap text-[11px]">
            {t('拖动角色移动')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disableAnimation
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={onReset}
            title={t('所有角色回到默认站位')}
          >
            {t('回到默认')}
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
