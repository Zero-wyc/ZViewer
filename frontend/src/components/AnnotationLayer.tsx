import {
  useEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react'
import { Pencil, Type, Eraser, Trash2, Minus, Palette } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Space } from '@/components/ui/Space'
import { Text } from '@/components/ui/Typography'
import type { Socket } from 'socket.io-client'
import { t } from '@/i18n'

export type AnnotationTool = 'pen' | 'text' | 'erase'

export interface AnnotationStroke {
  id: string
  type: AnnotationTool
  points?: { x: number; y: number }[]
  text?: string
  color?: string
  width?: number
  x?: number
  y?: number
}

interface AnnotationLayerProps {
  socket: Socket | null
  roomId: string
  readOnly?: boolean
  /** 是否激活批注模式（接收指针事件）。readOnly 模式忽略此值 */
  active?: boolean
  tool?: AnnotationTool
  color?: string
  width?: number
  className?: string
}

interface TextInputState {
  visible: boolean
  x: number
  y: number
  value: string
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const COLORS = [
  '#f76f53',
  '#3b82f6',
  '#22c55e',
  '#eab308',
  '#a855f7',
  '#000000',
]

export const AnnotationLayer = forwardRef<
  { clear: () => void },
  AnnotationLayerProps
>(function AnnotationLayer(
  {
    socket,
    roomId,
    readOnly = false,
    active = true,
    tool = 'pen',
    color = '#f76f53',
    width = 3,
    className,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const drawingRef = useRef(false)
  const currentPointsRef = useRef<{ x: number; y: number }[]>([])
  const strokesRef = useRef<AnnotationStroke[]>([])

  // 用 ref 保存最新的 tool/color/width，避免 pointer 事件处理器闭包陈旧
  const toolRef = useRef(tool)
  const colorRef = useRef(color)
  const widthRef = useRef(width)
  useEffect(() => {
    toolRef.current = tool
  }, [tool])
  useEffect(() => {
    colorRef.current = color
  }, [color])
  useEffect(() => {
    widthRef.current = width
  }, [width])

  const [textInput, setTextInput] = useState<TextInputState>({
    visible: false,
    x: 0,
    y: 0,
    value: '',
  })

  // ---- 核心绘制 ----

  /**
   * 在当前 canvas 上绘制单条笔画。
   * 使用归一化坐标 (0~1) × canvas CSS 尺寸，DPR 缩放由 ctx.scale 处理。
   */
  const renderStroke = useCallback((stroke: AnnotationStroke) => {
    const canvas = canvasRef.current
    const ctx = ctxRef.current
    if (!canvas || !ctx) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return

    ctx.save()
    if (stroke.type === 'erase') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.lineWidth = (stroke.width ?? 3) * 3
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = stroke.color ?? '#f76f53'
      ctx.fillStyle = stroke.color ?? '#f76f53'
      ctx.lineWidth = stroke.width ?? 3
    }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    if (stroke.type === 'text' && stroke.text) {
      const fontSize = Math.max(14, (stroke.width ?? 3) * 5)
      ctx.font = `${fontSize}px sans-serif`
      ctx.fillText(stroke.text, (stroke.x ?? 0) * w, (stroke.y ?? 0) * h)
    } else if (stroke.points && stroke.points.length > 1) {
      ctx.beginPath()
      stroke.points.forEach((p, i) => {
        const px = p.x * w
        const py = p.y * h
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
    } else if (stroke.points && stroke.points.length === 1) {
      // 单点：画一个小圆点
      const p = stroke.points[0]
      ctx.beginPath()
      ctx.arc(p.x * w, p.y * h, ctx.lineWidth / 2, 0, Math.PI * 2)
      ctx.fillStyle = ctx.strokeStyle
      ctx.fill()
    }
    ctx.restore()
  }, [])

  /**
   * 全量重绘：清空 canvas → 按 strokesRef 顺序逐条绘制。
   * erase 笔画依赖 destination-out，必须保持绘制顺序。
   */
  const redrawAll = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = ctxRef.current
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    strokesRef.current.forEach((s) => renderStroke(s))
  }, [renderStroke])

  /**
   * 添加笔画到本地存储并绘制。
   */
  const addStroke = useCallback(
    (stroke: AnnotationStroke) => {
      strokesRef.current.push(stroke)
      renderStroke(stroke)
    },
    [renderStroke]
  )

  // 用 ref 保存 addStroke 最新引用，供 socket 回调使用
  const addStrokeRef = useRef(addStroke)
  useEffect(() => {
    addStrokeRef.current = addStroke
  }, [addStroke])

  // ---- Canvas 尺寸管理 ----

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const rect = container.getBoundingClientRect()
    if (!rect.width || !rect.height) return

    const dpr = window.devicePixelRatio || 1
    const targetW = Math.floor(rect.width * dpr)
    const targetH = Math.floor(rect.height * dpr)

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW
      canvas.height = targetH
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(dpr, dpr)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctxRef.current = ctx
      }
    }
    // 无论是否改变尺寸，都重绘一次确保内容正确
    redrawAll()
  }, [redrawAll])

  useEffect(() => {
    resizeCanvas()
    const observer = new ResizeObserver(resizeCanvas)
    if (containerRef.current) {
      observer.observe(containerRef.current)
    }
    window.addEventListener('resize', resizeCanvas)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [resizeCanvas])

  // ---- Socket 同步 ----

  useEffect(() => {
    if (!socket) return

    const handleStroke = (data: {
      stroke: AnnotationStroke
      senderId?: string
    }) => {
      // 忽略自己发送的 stroke，避免重复绘制
      if (data.senderId && data.senderId === socket.id) return
      addStrokeRef.current(data.stroke)
    }

    const handleClear = () => {
      strokesRef.current = []
      const canvas = canvasRef.current
      const ctx = ctxRef.current
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    }

    socket.on('annotation-stroke', handleStroke)
    socket.on('clear-annotations', handleClear)

    return () => {
      socket.off('annotation-stroke', handleStroke)
      socket.off('clear-annotations', handleClear)
    }
  }, [socket])

  // ---- 对外暴露 clear ----

  useImperativeHandle(ref, () => ({
    clear: () => {
      strokesRef.current = []
      const canvas = canvasRef.current
      const ctx = ctxRef.current
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    },
  }))

  // ---- 指针事件 ----

  const getNormalizedPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    }
  }

  const emitStroke = (stroke: AnnotationStroke) => {
    socket?.emit('annotation-stroke', { roomId, stroke })
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || !active) return
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setPointerCapture(e.pointerId)

    const currentTool = toolRef.current

    if (currentTool === 'text') {
      const rect = canvas.getBoundingClientRect()
      setTextInput({
        visible: true,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        value: '',
      })
      return
    }

    drawingRef.current = true
    const point = getNormalizedPoint(e.clientX, e.clientY)
    currentPointsRef.current = [point]
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || !active || !drawingRef.current) return
    e.preventDefault()
    const currentTool = toolRef.current
    if (currentTool === 'text') return

    const point = getNormalizedPoint(e.clientX, e.clientY)
    currentPointsRef.current.push(point)

    // 实时预览：直接在 canvas 上画线段
    const canvas = canvasRef.current
    const ctx = ctxRef.current
    if (!canvas || !ctx) return

    const w = canvas.clientWidth
    const h = canvas.clientHeight

    ctx.save()
    if (currentTool === 'erase') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.lineWidth = widthRef.current * 3
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = colorRef.current
      ctx.lineWidth = widthRef.current
    }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const pts = currentPointsRef.current
    if (pts.length >= 2) {
      const prev = pts[pts.length - 2]
      const curr = pts[pts.length - 1]
      ctx.beginPath()
      ctx.moveTo(prev.x * w, prev.y * h)
      ctx.lineTo(curr.x * w, curr.y * h)
      ctx.stroke()
    }
    ctx.restore()
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || !active || !drawingRef.current) return
    e.preventDefault()
    drawingRef.current = false

    const currentTool = toolRef.current
    const pts = currentPointsRef.current
    currentPointsRef.current = []

    if (pts.length === 0) return

    const stroke: AnnotationStroke = {
      id: generateId(),
      type: currentTool,
      points: pts,
      color: colorRef.current,
      width: widthRef.current,
    }

    // 关键：本地存储 + 发送给其他客户端
    addStroke(stroke)
    emitStroke(stroke)
  }

  const handleTextSubmit = () => {
    const value = textInput.value.trim()
    if (!value) {
      setTextInput((prev) => ({ ...prev, visible: false, value: '' }))
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const normalized = {
      x: textInput.x / canvas.clientWidth,
      y: textInput.y / canvas.clientHeight,
    }

    const stroke: AnnotationStroke = {
      id: generateId(),
      type: 'text',
      text: value,
      x: normalized.x,
      y: normalized.y,
      color: colorRef.current,
      width: widthRef.current,
    }

    addStroke(stroke)
    emitStroke(stroke)
    setTextInput({ visible: false, x: 0, y: 0, value: '' })
  }

  const cursor =
    readOnly || !active
      ? 'default'
      : tool === 'text'
        ? 'text'
        : tool === 'erase'
          ? 'cell'
          : 'crosshair'

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 z-10 ${className ?? ''}`}
      style={{ pointerEvents: readOnly || !active ? 'none' : 'auto' }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 touch-none"
        style={{ cursor, opacity: 0.95 }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      {textInput.visible && (
        <div
          className="absolute z-20 flex items-center gap-1 rounded-lg border border-slate-300 bg-white p-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
          style={{ left: textInput.x, top: textInput.y }}
        >
          <Input
            autoFocus
            size="sm"
            value={textInput.value}
            onChange={(e) =>
              setTextInput((prev) => ({ ...prev, value: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleTextSubmit()
              if (e.key === 'Escape') {
                setTextInput({ visible: false, x: 0, y: 0, value: '' })
              }
            }}
            placeholder={t('输入文字')}
            className="w-32"
          />
          <Button size="sm" variant="primary" onClick={handleTextSubmit}>
            {t('确定')}
          </Button>
        </div>
      )}
    </div>
  )
})

interface AnnotationToolbarProps {
  tool: AnnotationTool
  color: string
  width: number
  onToolChange: (tool: AnnotationTool) => void
  onColorChange: (color: string) => void
  onWidthChange: (width: number) => void
  onClear?: () => void
  canClear?: boolean
}

export function AnnotationToolbar({
  tool,
  color,
  width,
  onToolChange,
  onColorChange,
  onWidthChange,
  onClear,
  canClear,
}: AnnotationToolbarProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white/80 p-3 dark:border-slate-700 dark:bg-slate-800/80">
      <Text className="mb-2 font-medium">{t('批注工具')}</Text>
      <Space wrap className="justify-start" size="sm">
        <Button
          variant={tool === 'pen' ? 'primary' : 'secondary'}
          size="sm"
          icon={<Pencil className="h-4 w-4" />}
          onClick={() => onToolChange('pen')}
        >
          {t('画笔')}
        </Button>
        <Button
          variant={tool === 'text' ? 'primary' : 'secondary'}
          size="sm"
          icon={<Type className="h-4 w-4" />}
          onClick={() => onToolChange('text')}
        >
          {t('文字')}
        </Button>
        <Button
          variant={tool === 'erase' ? 'primary' : 'secondary'}
          size="sm"
          icon={<Eraser className="h-4 w-4" />}
          onClick={() => onToolChange('erase')}
        >
          {t('橡皮擦')}
        </Button>
      </Space>
      <div className="mt-3">
        <Text type="secondary" className="mb-1 text-xs">
          {t('颜色')}
        </Text>
        <Space wrap size="sm">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onColorChange(c)}
              className="h-6 w-6 rounded-full border border-slate-300 focus:outline-none focus:ring-2 focus:ring-offset-1"
              style={{
                backgroundColor: c,
                boxShadow:
                  color === c
                    ? '0 0 0 2px var(--md-sys-color-primary)'
                    : 'none',
              }}
              aria-label={t('选择颜色 {{c}}', { c })}
            />
          ))}
        </Space>
      </div>
      <div className="mt-3">
        <Text type="secondary" className="mb-1 text-xs">
          {t('粗细')}
        </Text>
        <Space align="center" size="sm" className="w-full">
          <Minus className="h-3 w-3 text-slate-400" />
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={width}
            onChange={(e) => onWidthChange(Number(e.target.value))}
            className="flex-1"
          />
          <Palette className="h-3 w-3 text-slate-400" />
          <Text className="w-6 text-xs">{width}</Text>
        </Space>
      </div>
      {canClear && onClear && (
        <Button
          variant="danger"
          size="sm"
          block
          className="mt-3"
          icon={<Trash2 className="h-4 w-4" />}
          onClick={onClear}
        >
          {t('清空所有批注')}
        </Button>
      )}
    </div>
  )
}
