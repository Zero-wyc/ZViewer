import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Check, Move, RotateCcw, ScanFace } from 'lucide-react'
import { Button } from '@/components/ui'
import { t } from '@/i18n'
import { clampDragOffset } from '../core/drag'
import {
  normalizeCrop,
  type CropRange,
  type Live2DRenderer,
} from '../core/live2d-renderer'
import { getEntry, setLocalDrag } from '../core/scene'

// 「拖拽模式」的交互层：一个贴合角色**可见区域**的可抓取框 + 上下两条裁剪
// 把手 + 一条常驻提示条。
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
  /** 偏移变化；final=true 表示松手（宿主据此落本机偏好） */
  onDrag: (x: number, y: number, final: boolean) => void
  /** 显示区域变化（比例，0 顶 1 底）；final=true 表示松手 */
  onCrop: (crop: CropRange, final: boolean) => void
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

interface CropGesture {
  pointerId: number
  edge: 'top' | 'bottom'
  startY: number
  /** 起始裁剪比例 */
  base: CropRange
  /** 起始时完整包围盒的像素高度：位移换算成比例的分母 */
  height: number
  /** 当前值，松手时补发一次终值 */
  latest: CropRange
}

/** 一键「半身像」：裁到腰部附近。不同模型腰线不同，用户还能再微调。 */
const BUST_CROP: CropRange = { top: 0, bottom: 0.55 }

export function Live2DDragLayer({
  renderer,
  sid,
  container,
  onDrag,
  onCrop,
  onReset,
  onExit,
}: Live2DDragLayerProps) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const topHandleRef = useRef<HTMLDivElement | null>(null)
  const bottomHandleRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const cropGestureRef = useRef<CropGesture | null>(null)
  // 松手时用它补发终值：中间几帧可能正好落在节流窗口里被丢掉了
  const latestRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    let raf = 0
    let lastKey = ''
    const tick = () => {
      const visible = renderer?.boundsOf(sid) ?? null
      const raw = renderer?.rawBoundsOf(sid) ?? null
      const key = visible
        ? `${visible.x.toFixed(1)},${visible.y.toFixed(1)},${visible.width.toFixed(1)},${visible.height.toFixed(1)}`
        : ''
      if (key !== lastKey) {
        lastKey = key
        for (const el of [
          boxRef.current,
          ghostRef.current,
          topHandleRef.current,
          bottomHandleRef.current,
        ]) {
          if (el) el.style.visibility = visible ? 'visible' : 'hidden'
        }
        if (visible) {
          const box = boxRef.current
          if (box) {
            box.style.transform = `translate3d(${visible.x}px, ${visible.y}px, 0)`
            box.style.width = `${visible.width}px`
            box.style.height = `${visible.height}px`
          }
          // 完整包围盒：虚线，提示"本来有多大、裁掉了多少"
          const ghost = ghostRef.current
          if (ghost && raw) {
            const cropped =
              Math.abs(raw.y - visible.y) > 0.5 ||
              Math.abs(raw.height - visible.height) > 0.5
            ghost.style.visibility = cropped ? 'visible' : 'hidden'
            ghost.style.transform = `translate3d(${raw.x}px, ${raw.y}px, 0)`
            ghost.style.width = `${raw.width}px`
            ghost.style.height = `${raw.height}px`
          }
          const top = topHandleRef.current
          if (top) {
            top.style.transform = `translate3d(${visible.x}px, ${visible.y - 7}px, 0)`
            top.style.width = `${visible.width}px`
          }
          const bottom = bottomHandleRef.current
          if (bottom) {
            bottom.style.transform = `translate3d(${visible.x}px, ${visible.y + visible.height - 5}px, 0)`
            bottom.style.width = `${visible.width}px`
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
    // 位置是本机偏好，所以只挡「荒谬值」，**不把模型夹回画面里**：用户可以把
    // 角色拖到完全看不见的地方（临时让出画面）。回位靠提示条上的「回到原位」
    // 或角色设置里的「重置模型位置」。
    const next = renderer
      ? renderer.clampOffset(rawX, rawY)
      : clampDragOffset(rawX, rawY)
    latestRef.current = next
    // 本地立刻落地（跟手）；位置不再上行，也不需要节流
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

  // ---- 裁剪把手 ----
  //
  // 位移按**完整包围盒的高度**换算成比例，而不是按可见高度：可见高度会随着
  // 拖动实时变小，用它做分母会让手越拖越灵敏（拖到一半时同样的 10px 变成
  // 两倍的比例），手感是"突然飞出去"。
  const startCrop = (
    event: React.PointerEvent<HTMLDivElement>,
    edge: 'top' | 'bottom'
  ) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const raw = renderer?.rawBoundsOf(sid)
    const base = renderer?.cropOf(sid) ?? { top: 0, bottom: 1 }
    if (!raw) return
    cropGestureRef.current = {
      pointerId: event.pointerId,
      edge,
      startY: event.clientY,
      base,
      height: Math.max(1, raw.height),
      latest: base,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = cropGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const delta = (event.clientY - gesture.startY) / gesture.height
    const next =
      gesture.edge === 'bottom'
        ? normalizeCrop({
            top: gesture.base.top,
            bottom: gesture.base.bottom + delta,
          })
        : normalizeCrop({
            top: gesture.base.top + delta,
            bottom: gesture.base.bottom,
          })
    gesture.latest = next
    onCrop(next, false)
  }

  const finishCrop = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = cropGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    cropGestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onCrop(gesture.latest, true)
  }

  return (
    <>
      {/* 完整包围盒（被裁掉的部分）：只做参考，不接手势 */}
      <div
        ref={ghostRef}
        role="presentation"
        className="absolute left-0 top-0"
        style={{
          pointerEvents: 'none',
          visibility: 'hidden',
          border:
            '1px dashed color-mix(in srgb, var(--md-sys-color-primary) 45%, transparent)',
          borderRadius: 12,
          opacity: 0.55,
        }}
      />
      {/* 可见区域：拖动移动角色 */}
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
      {/* 上边缘：拖动裁掉上部 */}
      <div
        ref={topHandleRef}
        role="presentation"
        onPointerDown={(event) => startCrop(event, 'top')}
        onPointerMove={moveCrop}
        onPointerUp={finishCrop}
        onPointerCancel={finishCrop}
        onLostPointerCapture={() => {
          cropGestureRef.current = null
        }}
        className="absolute left-0 top-0 flex h-3 cursor-ns-resize touch-none items-center justify-center"
        style={{ pointerEvents: 'auto', visibility: 'hidden' }}
      >
        <span
          className="h-1 w-10 rounded-full"
          style={{ background: 'var(--md-sys-color-primary)' }}
        />
      </div>
      {/* 下边缘：拖动裁掉下部（"只显示上半身"就是把它往上拖） */}
      <div
        ref={bottomHandleRef}
        role="presentation"
        onPointerDown={(event) => startCrop(event, 'bottom')}
        onPointerMove={moveCrop}
        onPointerUp={finishCrop}
        onPointerCancel={finishCrop}
        onLostPointerCapture={() => {
          cropGestureRef.current = null
        }}
        className="absolute left-0 top-0 flex h-3 cursor-ns-resize touch-none items-center justify-center"
        style={{ pointerEvents: 'auto', visibility: 'hidden' }}
      >
        <span
          className="h-1 w-10 rounded-full"
          style={{ background: 'var(--md-sys-color-primary)' }}
        />
      </div>
      {createPortal(
        <div
          // 放**顶部**而不是原来的底部中央：角色就站在画面底部，提示条压在
          // 身上正好盖住下把手——那是最需要看清和拖动的部位。
          className="glass-strong fixed top-[84px] left-1/2 z-[120] flex max-w-[calc(100vw-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-full px-3 py-1.5 max-md:top-[72px]"
          style={{
            pointerEvents: 'auto',
            color: 'var(--md-sys-color-on-surface)',
            boxShadow: '0 12px 32px -8px rgba(0, 0, 0, 0.45)',
          }}
        >
          <Move size={14} className="opacity-60" />
          <span className="whitespace-nowrap text-[11px]">
            {t('拖动角色移动 · 拖上下边缘裁剪显示区域')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disableAnimation
            icon={<ScanFace className="h-3.5 w-3.5" />}
            onClick={() => onCrop(BUST_CROP, true)}
          >
            {t('半身像')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disableAnimation
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={onReset}
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
