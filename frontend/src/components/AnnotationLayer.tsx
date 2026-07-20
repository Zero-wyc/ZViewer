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
  tool?: AnnotationTool
  color?: string
  width?: number
  onToolChange?: (tool: AnnotationTool) => void
  onColorChange?: (color: string) => void
  onWidthChange?: (width: number) => void
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
  const [textInput, setTextInput] = useState<TextInputState>({
    visible: false,
    x: 0,
    y: 0,
    value: '',
  })

  const renderStroke = useCallback(
    (stroke: AnnotationStroke) => {
      const canvas = canvasRef.current
      const ctx = ctxRef.current
      if (!canvas || !ctx) return

      const canvasWidth = canvas.clientWidth
      const canvasHeight = canvas.clientHeight
      if (!canvasWidth || !canvasHeight) return

      ctx.save()
      if (stroke.type === 'erase') {
        ctx.globalCompositeOperation = 'destination-out'
        ctx.strokeStyle = 'rgba(0,0,0,1)'
      } else {
        ctx.globalCompositeOperation = 'source-over'
        ctx.strokeStyle = stroke.color ?? color
        ctx.fillStyle = stroke.color ?? color
      }
      ctx.lineWidth =
        (stroke.width ?? width) * (stroke.type === 'erase' ? 3 : 1)

      if (stroke.type === 'text' && stroke.text) {
        const fontSize = Math.max(14, (stroke.width ?? width) * 5)
        ctx.font = `${fontSize}px sans-serif`
        ctx.fillText(
          stroke.text,
          (stroke.x ?? 0) * canvasWidth,
          (stroke.y ?? 0) * canvasHeight
        )
      } else if (stroke.points && stroke.points.length > 1) {
        ctx.beginPath()
        stroke.points.forEach((point, index) => {
          const x = point.x * canvasWidth
          const y = point.y * canvasHeight
          if (index === 0) {
            ctx.moveTo(x, y)
          } else {
            ctx.lineTo(x, y)
          }
        })
        ctx.stroke()
      }
      ctx.restore()
    },
    [color, width]
  )

  const drawStroke = useCallback(
    (stroke: AnnotationStroke) => {
      strokesRef.current.push(stroke)
      renderStroke(stroke)
    },
    [renderStroke]
  )

  const drawStrokeRef = useRef(drawStroke)
  useEffect(() => {
    drawStrokeRef.current = drawStroke
  }, [drawStroke])

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const rect = container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.floor(rect.width * dpr)) {
      canvas.width = Math.floor(rect.width * dpr)
      canvas.height = Math.floor(rect.height * dpr)
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(dpr, dpr)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctxRef.current = ctx
        strokesRef.current.forEach((stroke) => renderStroke(stroke))
      }
    }
  }, [renderStroke])

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

  useEffect(() => {
    if (!socket) return

    const handleStroke = (data: {
      stroke: AnnotationStroke
      senderId?: string
    }) => {
      // 忽略自己发送的 stroke，避免重复绘制
      if (data.senderId && data.senderId === socket.id) return
      drawStrokeRef.current(data.stroke)
    }

    const handleClear = () => {
      const canvas = canvasRef.current
      const ctx = ctxRef.current
      if (!canvas || !ctx) return
      strokesRef.current = []
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    }

    socket.on('annotation-stroke', handleStroke)
    socket.on('clear-annotations', handleClear)

    return () => {
      socket.off('annotation-stroke', handleStroke)
      socket.off('clear-annotations', handleClear)
    }
  }, [socket])

  useImperativeHandle(ref, () => ({
    clear: () => {
      const canvas = canvasRef.current
      const ctx = ctxRef.current
      if (!canvas || !ctx) return
      strokesRef.current = []
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    },
  }))

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
    if (readOnly || !canvasRef.current) return
    e.preventDefault()
    const canvas = canvasRef.current
    canvas.setPointerCapture(e.pointerId)

    if (tool === 'text') {
      setTextInput({
        visible: true,
        x: e.clientX - canvas.getBoundingClientRect().left,
        y: e.clientY - canvas.getBoundingClientRect().top,
        value: '',
      })
      return
    }

    drawingRef.current = true
    const point = getNormalizedPoint(e.clientX, e.clientY)
    currentPointsRef.current = [point]

    const ctx = ctxRef.current
    if (!ctx) return
    ctx.save()
    if (tool === 'erase') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = 'rgba(0,0,0,1)'
      ctx.lineWidth = width * 3
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = color
      ctx.lineWidth = width
    }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(point.x * canvas.clientWidth, point.y * canvas.clientHeight)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || !drawingRef.current || tool === 'text') return
    e.preventDefault()
    const point = getNormalizedPoint(e.clientX, e.clientY)
    currentPointsRef.current.push(point)

    const canvas = canvasRef.current
    const ctx = ctxRef.current
    if (!canvas || !ctx) return
    ctx.lineTo(point.x * canvas.clientWidth, point.y * canvas.clientHeight)
    ctx.stroke()
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || !drawingRef.current || tool === 'text') return
    e.preventDefault()
    drawingRef.current = false
    const ctx = ctxRef.current
    if (ctx) ctx.restore()

    if (currentPointsRef.current.length > 1) {
      emitStroke({
        id: generateId(),
        type: tool,
        points: currentPointsRef.current,
        color,
        width,
      })
    }
    currentPointsRef.current = []
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
      color,
      width,
    }

    drawStroke(stroke)
    emitStroke(stroke)
    setTextInput({ visible: false, x: 0, y: 0, value: '' })
  }

  const cursor =
    readOnly || tool === 'text'
      ? 'default'
      : tool === 'erase'
        ? 'cell'
        : 'crosshair'

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 ${className ?? ''}`}
      style={{ pointerEvents: readOnly ? 'none' : 'auto' }}
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
            placeholder="输入文字"
            className="w-32"
          />
          <Button size="sm" variant="primary" onClick={handleTextSubmit}>
            确定
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
      <Text className="mb-2 font-medium">批注工具</Text>
      <Space wrap className="justify-start" size="sm">
        <Button
          variant={tool === 'pen' ? 'primary' : 'secondary'}
          size="sm"
          icon={<Pencil className="h-4 w-4" />}
          onClick={() => onToolChange('pen')}
        >
          画笔
        </Button>
        <Button
          variant={tool === 'text' ? 'primary' : 'secondary'}
          size="sm"
          icon={<Type className="h-4 w-4" />}
          onClick={() => onToolChange('text')}
        >
          文字
        </Button>
        <Button
          variant={tool === 'erase' ? 'primary' : 'secondary'}
          size="sm"
          icon={<Eraser className="h-4 w-4" />}
          onClick={() => onToolChange('erase')}
        >
          橡皮擦
        </Button>
      </Space>
      <div className="mt-3">
        <Text type="secondary" className="mb-1 text-xs">
          颜色
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
              aria-label={`选择颜色 ${c}`}
            />
          ))}
        </Space>
      </div>
      <div className="mt-3">
        <Text type="secondary" className="mb-1 text-xs">
          粗细
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
          清空所有批注
        </Button>
      )}
    </div>
  )
}
