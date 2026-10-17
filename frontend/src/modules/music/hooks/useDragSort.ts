import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'

/**
 * 通用拖拽排序（HTML5 DnD）。
 *
 * 从 MusicBilibiliPage 的两组同构 handler（自定义栏目 chip / 分区种类条目）
 * 抽取：两者仅「被拖项 id」与「落位回调」不同。
 *
 * 落位语义：指示线画在目标项前缘（= 插入到它前面），向后拖动时先移除
 * 会使目标左移一位，故目标下标需减一校正（向上拖不变）。
 */
export function useDragSort(onMove: (from: number, to: number) => void) {
  const fromIndexRef = useRef<number | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const handleDragStart = useCallback(
    (index: number, id: string, e: DragEvent) => {
      fromIndexRef.current = index
      setDraggingId(id)
      e.dataTransfer.effectAllowed = 'move'
      // Firefox 需要 setData 才会启动拖拽
      e.dataTransfer.setData('text/plain', id)
    },
    []
  )

  const handleDragOver = useCallback(
    (index: number, id: string, e: DragEvent) => {
      if (fromIndexRef.current === null || fromIndexRef.current === index)
        return
      // 允许 drop；悬停目标高亮指示插入位置
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropTargetId((prev) => (prev === id ? prev : id))
    },
    []
  )

  const handleDrop = useCallback(
    (index: number, e: DragEvent) => {
      e.preventDefault()
      const from = fromIndexRef.current
      if (from !== null && from !== index) {
        onMove(from, from < index ? index - 1 : index)
      }
      fromIndexRef.current = null
      setDraggingId(null)
      setDropTargetId(null)
    },
    [onMove]
  )

  const handleDragEnd = useCallback(() => {
    fromIndexRef.current = null
    setDraggingId(null)
    setDropTargetId(null)
  }, [])

  return {
    draggingId,
    dropTargetId,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  }
}
