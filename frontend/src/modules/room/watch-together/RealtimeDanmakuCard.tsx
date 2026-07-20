import { useMemo, useEffect, useRef, useState } from 'react'
import { Text } from '@/components/ui/Typography'
import { useDanmakuStore } from '@/store/danmakuStore'
import { useRoomStore } from '@/store/roomStore'
import { cn } from '@/lib/utils'

const WINDOW_SIZE = 5 // 秒，用于当前时间高亮范围

interface RealtimeDanmakuItem {
  id: string
  content: string
  time: number
  actualTime: number
  trackLabel: string
  mode: number
  color: number
}

function getDanmakuTypeLabel(
  mode: number,
  color: number
): { label: string; variant: 'default' | 'primary' | 'warning' | 'success' } {
  if (mode === 5) return { label: '顶部', variant: 'primary' }
  if (mode === 4) return { label: '底部', variant: 'primary' }
  if (color !== 16777215) return { label: '彩色', variant: 'warning' }
  return { label: '滚动', variant: 'default' }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const AUTO_SCROLL_RESUME_MS = 2000

export function RealtimeDanmakuCard() {
  const tracks = useDanmakuStore((state) => state.tracks)
  const currentTime = useRoomStore((state) => state.watchTogether.currentTime)
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [isUserScrolling, setIsUserScrolling] = useState(false)
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleScroll = () => {
    setIsUserScrolling(true)
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current)
    }
    resumeTimerRef.current = setTimeout(() => {
      setIsUserScrolling(false)
    }, AUTO_SCROLL_RESUME_MS)
  }

  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current)
      }
    }
  }, [])

  const allDanmaku = useMemo<RealtimeDanmakuItem[]>(() => {
    const list: RealtimeDanmakuItem[] = []

    tracks.forEach((track) => {
      track.items.forEach((item) => {
        list.push({
          id: `${track.trackId}-${item.id}`,
          content: item.content,
          time: item.time,
          actualTime: item.time + track.offset,
          trackLabel: track.label,
          mode: item.mode ?? 1,
          color: item.color ?? 16777215,
        })
      })
    })

    return list.sort((a, b) => a.actualTime - b.actualTime)
  }, [tracks])

  const activeIndex = useMemo(() => {
    if (allDanmaku.length === 0) return -1

    let best = 0
    let bestDiff = Math.abs(allDanmaku[0].actualTime - currentTime)

    for (let i = 1; i < allDanmaku.length; i++) {
      const diff = Math.abs(allDanmaku[i].actualTime - currentTime)
      if (diff < bestDiff) {
        best = i
        bestDiff = diff
      }
    }

    return best
  }, [allDanmaku, currentTime])

  useEffect(() => {
    if (activeIndex < 0 || isUserScrolling) return

    const activeItem = allDanmaku[activeIndex]
    if (!activeItem) return

    const el = itemRefs.current.get(activeItem.id)
    const list = listRef.current
    if (!el || !list) return

    // 仅在 listRef 内部滚动，避免 scrollIntoView 冒泡到外层
    // overflow-y-auto 容器（如 RoomLayout 根容器）导致整个页面跳动、
    // 视频元素被推出视口从而引发黑屏与布局错位。
    // 同时用 rAF 延迟一帧，确保切换 tab 时 listRef 已完成布局测量。
    const alignIntoList = () => {
      const listRect = list.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      // 防御性：tab 切换瞬间 list 可能尚未完成布局（高度为 0），
      // 此时 getBoundingClientRect 返回的 rect 无意义，跳过避免错误滚动
      if (listRect.height <= 0 || elRect.height <= 0) return
      // 顶部超出：向上滚动让 el 顶部对齐 list 顶部（留 4px 边距）
      if (elRect.top < listRect.top) {
        list.scrollTop -= listRect.top - elRect.top - 4
      } else if (elRect.bottom > listRect.bottom) {
        // 底部超出：向下滚动让 el 底部对齐 list 底部
        list.scrollTop += elRect.bottom - listRect.bottom + 4
      }
    }

    const rafId = requestAnimationFrame(alignIntoList)
    return () => cancelAnimationFrame(rafId)
  }, [allDanmaku, activeIndex, isUserScrolling])

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col gap-2 rounded-[var(--md-sys-shape-corner)] border p-2"
      style={{
        backgroundColor: 'var(--md-sys-color-surface-container)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      <div className="flex items-center justify-between">
        <Text className="text-xs font-medium">实时弹幕</Text>
        <Text type="secondary" className="text-[10px]">
          全部弹幕（高亮当前 ±{WINDOW_SIZE}s）
        </Text>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-[var(--md-sys-shape-corner)] border p-1.5"
        style={{
          backgroundColor: 'var(--md-sys-color-surface-container-high)',
          borderColor: 'var(--md-sys-color-outline-variant)',
        }}
      >
        {allDanmaku.length === 0 ? (
          <Text type="secondary" className="text-center text-xs">
            暂无弹幕
          </Text>
        ) : (
          <div className="flex flex-col gap-0.5">
            {allDanmaku.map((item) => {
              const type = getDanmakuTypeLabel(item.mode, item.color)
              const isHighlighted =
                Math.abs(item.actualTime - currentTime) <= WINDOW_SIZE

              return (
                <div
                  key={item.id}
                  ref={(el) => {
                    if (el) {
                      itemRefs.current.set(item.id, el)
                    } else {
                      itemRefs.current.delete(item.id)
                    }
                  }}
                  className="flex min-w-0 items-start gap-1.5 rounded-sm border px-1.5 py-0.5"
                  style={{
                    backgroundColor: isHighlighted
                      ? 'var(--md-sys-color-primary-container)'
                      : 'var(--md-sys-color-surface-container)',
                    borderColor: 'var(--md-sys-color-outline-variant)',
                  }}
                >
                  <Text
                    type="secondary"
                    className={cn(
                      'shrink-0 text-[10px] leading-4',
                      isHighlighted &&
                        'text-[var(--md-sys-color-on-primary-container)]'
                    )}
                  >
                    {formatTime(item.actualTime)}
                  </Text>
                  <span
                    className={cn(
                      'shrink-0 rounded px-0.5 text-[10px] leading-4',
                      isHighlighted
                        ? 'text-[var(--md-sys-color-on-primary-container)]'
                        : 'text-[var(--md-sys-color-on-surface-variant)]'
                    )}
                    style={{
                      backgroundColor:
                        'var(--md-sys-color-surface-container-highest)',
                    }}
                  >
                    {item.trackLabel}
                  </span>
                  <Text
                    className={cn(
                      'min-w-0 flex-1 break-words text-[11px] leading-4',
                      isHighlighted &&
                        'text-[var(--md-sys-color-on-primary-container)]'
                    )}
                  >
                    {item.content}
                  </Text>
                  <span
                    className={cn(
                      'shrink-0 rounded px-0.5 text-[10px] leading-4',
                      type.variant === 'primary' &&
                        'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]',
                      type.variant === 'warning' &&
                        'bg-[var(--md-sys-color-tertiary-container)] text-[var(--md-sys-color-on-tertiary-container)]',
                      type.variant === 'success' &&
                        'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]',
                      type.variant === 'default' &&
                        'bg-[var(--md-sys-color-surface-container-highest)] text-[var(--md-sys-color-on-surface-variant)]'
                    )}
                  >
                    {type.label}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
