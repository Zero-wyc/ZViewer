import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FC } from 'react'
import { Maximize2, Search } from 'lucide-react'
import { Text } from '@/components/ui/Typography'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
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

/**
 * 单条弹幕项 — 用 React.memo 包裹，只在 isHighlighted 变化时重渲染。
 *
 * 原实现在 RealtimeDanmakuCard 内部用 allDanmaku.map 直接渲染，
 * 每秒 currentTime 变化时数千个 DOM 节点全部重建，导致严重卡顿。
 * 提取为独立 memo 组件后，只有高亮状态翻转的 2 条弹幕会重渲染。
 */
const DanmakuListItem: FC<{
  item: RealtimeDanmakuItem
  isHighlighted: boolean
  registerRef?: (id: string, el: HTMLDivElement | null) => void
  expanded?: boolean
}> = memo(function DanmakuListItem({
  item,
  isHighlighted,
  registerRef,
  expanded = false,
}) {
  const type = getDanmakuTypeLabel(item.mode, item.color)
  return (
    <div
      ref={(el) => registerRef?.(item.id, el)}
      className={cn(
        'flex min-w-0 gap-1.5 rounded-sm border px-1.5 py-0.5',
        expanded ? 'items-start' : 'items-center'
      )}
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
          'shrink-0 text-[10px] leading-5 tabular-nums',
          isHighlighted &&
            'text-[var(--md-sys-color-on-primary-container)]'
        )}
      >
        {formatTime(item.actualTime)}
      </Text>
      <span
        className={cn(
          'shrink-0 truncate rounded px-1 text-[10px] leading-5',
          expanded ? 'max-w-[140px]' : 'max-w-[80px]',
          isHighlighted
            ? 'text-[var(--md-sys-color-on-primary-container)]'
            : 'text-[var(--md-sys-color-on-surface-variant)]'
        )}
        style={{
          backgroundColor:
            'var(--md-sys-color-surface-container-highest)',
        }}
        title={item.trackLabel}
      >
        {item.trackLabel}
      </span>
      <Text
        className={cn(
          'min-w-0 flex-1 text-[11px] leading-5',
          expanded ? 'break-words' : 'truncate',
          isHighlighted &&
            'text-[var(--md-sys-color-on-primary-container)]'
        )}
        title={item.content}
      >
        {item.content}
      </Text>
      <span
        className={cn(
          'shrink-0 rounded px-1 text-[10px] leading-5',
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
})

export function RealtimeDanmakuCard() {
  const tracks = useDanmakuStore((state) => state.tracks)
  // currentTime 降为整数秒，避免房主广播频率（0.5-1s）中浮点变化每秒触发重渲染。
  // 高亮范围 ±5s，整数精度对高亮判断无影响。
  const rawCurrentTime = useRoomStore(
    (state) => state.watchTogether.currentTime
  )
  const currentTime = Math.floor(rawCurrentTime)

  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const [isUserScrolling, setIsUserScrolling] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 稳定的 ref 注册回调，避免每条弹幕项 prop 变化
  const registerRef = useCallback(
    (id: string, el: HTMLDivElement | null) => {
      if (el) {
        itemRefs.current.set(id, el)
      } else {
        itemRefs.current.delete(id)
      }
    },
    []
  )

  const handleScroll = useCallback(() => {
    setIsUserScrolling(true)
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current)
    }
    resumeTimerRef.current = setTimeout(() => {
      setIsUserScrolling(false)
    }, AUTO_SCROLL_RESUME_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current)
      }
    }
  }, [])

  // allDanmaku 只依赖 tracks（低频变化），不依赖 currentTime
  const allDanmaku = useMemo<RealtimeDanmakuItem[]>(() => {
    const list: RealtimeDanmakuItem[] = []
    tracks.forEach((track) => {
      if (track.hidden) return
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

  const filteredDanmaku = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return allDanmaku
    return allDanmaku.filter((item) => {
      if (item.content.toLowerCase().includes(query)) return true
      if (item.trackLabel.toLowerCase().includes(query)) return true
      if (formatTime(item.actualTime).includes(query)) return true
      return false
    })
  }, [allDanmaku, searchQuery])

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

    const alignIntoList = () => {
      const listRect = list.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      if (listRect.height <= 0 || elRect.height <= 0) return
      if (elRect.top < listRect.top) {
        list.scrollTop -= listRect.top - elRect.top - 4
      } else if (elRect.bottom > listRect.bottom) {
        list.scrollTop += elRect.bottom - listRect.bottom + 4
      }
    }

    const rafId = requestAnimationFrame(alignIntoList)
    return () => cancelAnimationFrame(rafId)
  }, [allDanmaku, activeIndex, isUserScrolling])

  return (
    <div
      className="flex min-h-0 min-w-0 flex-col gap-2 rounded-[var(--md-sys-shape-corner)] border p-2"
      style={{
        backgroundColor: 'var(--md-sys-color-surface-container)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <Text className="text-xs font-medium">实时弹幕</Text>
        <div className="flex items-center gap-2">
          <Text
            type="secondary"
            className="shrink-0 truncate text-[10px]"
            title={`全部弹幕（高亮当前 ±${WINDOW_SIZE}s）`}
          >
            {allDanmaku.length > 0
              ? `${allDanmaku.length} 条`
              : `高亮 ±${WINDOW_SIZE}s`}
          </Text>
          {allDanmaku.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              icon={<Maximize2 className="h-3 w-3" />}
              onClick={() => setModalOpen(true)}
            >
              查看全部
            </Button>
          )}
        </div>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="max-h-[320px] min-h-[120px] overflow-y-auto overflow-x-hidden rounded-[var(--md-sys-shape-corner)] border p-1.5"
        style={{
          backgroundColor: 'var(--md-sys-color-surface-container-high)',
          borderColor: 'var(--md-sys-color-outline-variant)',
        }}
      >
        {allDanmaku.length === 0 ? (
          <div className="flex h-full min-h-[120px] items-center justify-center">
            <Text type="secondary" className="text-xs">
              暂无弹幕
            </Text>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {allDanmaku.map((item) => (
              <DanmakuListItem
                key={item.id}
                item={item}
                isHighlighted={
                  Math.abs(item.actualTime - currentTime) <= WINDOW_SIZE
                }
                registerRef={registerRef}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false)
          setSearchQuery('')
        }}
        title={`实时弹幕 (${allDanmaku.length} 条)`}
        className="max-w-2xl"
      >
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索弹幕内容、轨道或时间 (如 01:23)"
              className="pl-8"
            />
          </div>

          <div
            className="max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-[var(--md-sys-shape-corner)] border p-2"
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
              borderColor: 'var(--md-sys-color-outline-variant)',
            }}
          >
            {filteredDanmaku.length === 0 ? (
              <div className="flex h-32 items-center justify-center">
                <Text type="secondary" className="text-xs">
                  {searchQuery ? '未找到匹配弹幕' : '暂无弹幕'}
                </Text>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {filteredDanmaku.map((item) => (
                  <DanmakuListItem
                    key={item.id}
                    item={item}
                    isHighlighted={
                      Math.abs(item.actualTime - currentTime) <= WINDOW_SIZE
                    }
                    expanded
                  />
                ))}
              </div>
            )}
          </div>

          {searchQuery && (
            <Text type="secondary" className="text-[10px]">
              找到 {filteredDanmaku.length} 条匹配弹幕
            </Text>
          )}
        </div>
      </Modal>
    </div>
  )
}
