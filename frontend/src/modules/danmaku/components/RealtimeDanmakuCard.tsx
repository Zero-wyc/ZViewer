import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FC } from 'react'
import { Maximize2, Search, Ban, Trash2, ListX, RotateCcw } from 'lucide-react'
import { Text } from '@/components/ui/Typography'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { message } from '@/components/ui/message'
import { useDanmakuStore } from '@/store/danmakuStore'
import type { DanmakuItem } from '@/modules/danmaku/types'
import { useRoomStore } from '@/store/roomStore'
import { cn, formatDuration } from '@/lib/utils'

const WINDOW_SIZE = 5 // 秒，用于当前时间高亮范围
const AUTO_SCROLL_RESUME_MS = 2000

// 紧凑列表单项估算高度（px），包含 flex gap 的等效值。
// 实际 item 高约 24px，加上 gap-0.5 后按 26px 估算，虚拟滚动对少量误差不敏感。
const COMPACT_ITEM_HEIGHT = 26
// 展开模式（Modal）下单项估算高度，内容换行时允许少量误差。
const EXPANDED_ITEM_HEIGHT = 34
// 上下缓冲行数，避免快速滚动时出现白边
const OVERSCAN = 8

interface RealtimeDanmakuItem {
  id: string
  trackId: string
  itemId: string
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

/**
 * 单条弹幕项 — 用 React.memo 包裹，只在 isHighlighted 变化时重渲染。
 */
const DanmakuListItem: FC<{
  item: RealtimeDanmakuItem
  isHighlighted: boolean
  isBlocked: boolean
  onBlock: (content: string) => void
  onDelete: (trackId: string, itemId: string) => void
  expanded?: boolean
}> = memo(function DanmakuListItem({
  item,
  isHighlighted,
  isBlocked,
  onBlock,
  onDelete,
  expanded = false,
}) {
  const type = getDanmakuTypeLabel(item.mode, item.color)
  return (
    <div
      className={cn(
        'group flex min-w-0 gap-1.5 rounded-sm border px-1.5 py-0.5',
        expanded ? 'items-start' : 'items-center'
      )}
      style={{
        backgroundColor: isHighlighted
          ? 'var(--md-sys-color-primary-container)'
          : 'var(--glass-bg)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      <Text
        type="secondary"
        className={cn(
          'shrink-0 text-[10px] leading-5 tabular-nums',
          isHighlighted && 'text-[var(--md-sys-color-on-primary-container)]'
        )}
      >
        {formatDuration(item.actualTime)}
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
          backgroundColor: 'var(--glass-bg)',
        }}
        title={item.trackLabel}
      >
        {item.trackLabel}
      </span>
      <Text
        className={cn(
          'min-w-0 flex-1 text-[11px] leading-5',
          expanded ? 'break-words' : 'truncate',
          isHighlighted && 'text-[var(--md-sys-color-on-primary-container)]'
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
            'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface-variant)]'
        )}
      >
        {type.label}
      </span>
      <button
        type="button"
        className={cn(
          'shrink-0 rounded p-0.5 transition-colors hover:bg-white/10',
          isBlocked
            ? 'text-[var(--md-sys-color-primary)]'
            : 'text-[var(--md-sys-color-on-surface-variant)]'
        )}
        title={isBlocked ? '取消屏蔽' : '屏蔽该内容'}
        onClick={() => onBlock(item.content)}
      >
        <Ban size={11} />
      </button>
      <button
        type="button"
        className="shrink-0 rounded p-0.5 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-white/10 hover:text-red-400"
        title="删除该弹幕（本地生效）"
        onClick={() => onDelete(item.trackId, item.itemId)}
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
})

interface VirtualRange {
  start: number
  end: number
  totalHeight: number
  topPadding: number
  bottomPadding: number
}

/**
 * 固定高度虚拟滚动核心逻辑。
 *
 * 只渲染视口内 + 上下缓冲区的节点，将 5000+ 条弹幕的 DOM 节点数量
 * 控制在固定几十条，避免大量 DOM 导致的渲染与滚动卡顿。
 */
function useVirtualList(
  itemCount: number,
  itemHeight: number,
  listRef: React.RefObject<HTMLDivElement | null>,
  overscan = OVERSCAN
) {
  const [listHeight, setListHeight] = useState(320)
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const el = listRef.current
    if (!el) return

    const updateHeight = () => {
      const height = el.clientHeight
      if (height > 0) setListHeight(height)
    }
    updateHeight()

    const observer = new ResizeObserver(updateHeight)
    observer.observe(el)
    return () => observer.disconnect()
  }, [listRef])

  const range: VirtualRange = useMemo(() => {
    const totalHeight = itemCount * itemHeight
    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
    const visibleCount = Math.ceil(listHeight / itemHeight)
    const end = Math.min(itemCount, start + visibleCount + overscan * 2)
    return {
      start,
      end,
      totalHeight,
      topPadding: start * itemHeight,
      bottomPadding: Math.max(0, (itemCount - end) * itemHeight),
    }
  }, [itemCount, itemHeight, listHeight, scrollTop, overscan])

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }, [])

  return { ...range, scrollTop, onScroll, listHeight }
}

export function RealtimeDanmakuCard() {
  const tracks = useDanmakuStore((state) => state.tracks)
  const blockKeywords = useDanmakuStore((state) => state.blockKeywords)
  const addBlockKeyword = useDanmakuStore((state) => state.addBlockKeyword)
  const removeBlockKeyword = useDanmakuStore(
    (state) => state.removeBlockKeyword
  )
  const removeTrackItem = useDanmakuStore((state) => state.removeTrackItem)
  const restoreTrackItem = useDanmakuStore((state) => state.restoreTrackItem)
  const addDeletedLog = useDanmakuStore((state) => state.addDeletedLog)
  const removeDeletedLog = useDanmakuStore((state) => state.removeDeletedLog)
  const clearDeletedLog = useDanmakuStore((state) => state.clearDeletedLog)
  const deletedLog = useDanmakuStore((state) => state.deletedLog)
  const triggerDanmakuRefresh = useDanmakuStore(
    (state) => state.triggerDanmakuRefresh
  )
  // currentTime 降为整数秒，避免房主广播频率（0.5-1s）中浮点变化每秒触发重渲染。
  const rawCurrentTime = useRoomStore(
    (state) => state.watchTogether.currentTime
  )
  const currentTime = Math.floor(rawCurrentTime)

  const listRef = useRef<HTMLDivElement>(null)
  const modalListRef = useRef<HTMLDivElement>(null)
  const [isUserScrolling, setIsUserScrolling] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [manageModalOpen, setManageModalOpen] = useState(false)
  const [manageTab, setManageTab] = useState<'blocked' | 'deleted'>('blocked')
  const [searchQuery, setSearchQuery] = useState('')
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const programmaticScrollRef = useRef(false)

  // allDanmaku 只依赖 tracks（低频变化），不依赖 currentTime
  const allDanmaku = useMemo<RealtimeDanmakuItem[]>(() => {
    const list: RealtimeDanmakuItem[] = []
    tracks.forEach((track) => {
      if (track.hidden) return
      track.items.forEach((item) => {
        list.push({
          id: `${track.trackId}-${item.id}`,
          trackId: track.trackId,
          itemId: item.id,
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
      if (formatDuration(item.actualTime).includes(query)) return true
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

  const {
    start: visibleStart,
    end: visibleEnd,
    totalHeight,
    topPadding,
    bottomPadding,
    onScroll: handleVirtualScroll,
    listHeight,
  } = useVirtualList(allDanmaku.length, COMPACT_ITEM_HEIGHT, listRef)

  const {
    start: modalVisibleStart,
    end: modalVisibleEnd,
    totalHeight: modalTotalHeight,
    topPadding: modalTopPadding,
    bottomPadding: modalBottomPadding,
    onScroll: handleModalVirtualScroll,
  } = useVirtualList(filteredDanmaku.length, EXPANDED_ITEM_HEIGHT, modalListRef)

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      handleVirtualScroll(e)
      if (programmaticScrollRef.current) return
      setIsUserScrolling(true)
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current)
      }
      resumeTimerRef.current = setTimeout(() => {
        setIsUserScrolling(false)
      }, AUTO_SCROLL_RESUME_MS)
    },
    [handleVirtualScroll]
  )

  const handleModalScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      handleModalVirtualScroll(e)
    },
    [handleModalVirtualScroll]
  )

  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current)
      }
    }
  }, [])

  // 自动滚动：将当前高亮项保持在列表可视区域中央。
  // 使用虚拟滚动后不再依赖 itemRefs，直接按索引计算 scrollTop。
  useEffect(() => {
    if (activeIndex < 0 || isUserScrolling || !listRef.current) return
    const list = listRef.current
    const targetScrollTop =
      activeIndex * COMPACT_ITEM_HEIGHT -
      listHeight / 2 +
      COMPACT_ITEM_HEIGHT / 2
    const clamped = Math.max(
      0,
      Math.min(targetScrollTop, totalHeight - listHeight)
    )
    if (Math.abs(list.scrollTop - clamped) <= 2) return

    programmaticScrollRef.current = true
    list.scrollTop = clamped
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [activeIndex, isUserScrolling, listHeight, totalHeight])

  const visibleDanmaku = useMemo(
    () => allDanmaku.slice(visibleStart, visibleEnd),
    [allDanmaku, visibleStart, visibleEnd]
  )

  const modalVisibleDanmaku = useMemo(
    () => filteredDanmaku.slice(modalVisibleStart, modalVisibleEnd),
    [filteredDanmaku, modalVisibleStart, modalVisibleEnd]
  )

  const handleBlock = useCallback(
    (content: string) => {
      if (blockKeywords.includes(content)) {
        void removeBlockKeyword(content)
        message.info('已取消屏蔽该内容')
      } else {
        void addBlockKeyword(content)
        message.success('已屏蔽该内容关键词')
      }
      triggerDanmakuRefresh()
    },
    [blockKeywords, addBlockKeyword, removeBlockKeyword, triggerDanmakuRefresh]
  )

  const handleDelete = useCallback(
    (trackId: string, itemId: string) => {
      const track = tracks.find((t) => t.trackId === trackId)
      const item = track?.items.find((i) => i.id === itemId)
      if (track && item) {
        void addDeletedLog({ trackId, trackLabel: track.label, item })
      }
      // removeTrackItem 内部会自动触发 refreshSignal，播放器弹幕层会立即清屏重载
      removeTrackItem(trackId, itemId)
      message.success('已删除该弹幕（本地生效）')
    },
    [tracks, addDeletedLog, removeTrackItem]
  )

  const handleRestore = useCallback(
    (trackId: string, item: DanmakuItem) => {
      // restoreTrackItem 内部会自动触发 refreshSignal
      restoreTrackItem(trackId, item)
      void removeDeletedLog(trackId, item.id)
      message.success('已恢复该弹幕')
    },
    [restoreTrackItem, removeDeletedLog]
  )

  const renderEmpty = (minHeight?: string) => (
    <div
      className={cn(
        'flex items-center justify-center',
        minHeight ? '' : 'min-h-full'
      )}
      style={minHeight ? { minHeight } : undefined}
    >
      <Text type="secondary" className="text-xs">
        暂无弹幕
      </Text>
    </div>
  )

  return (
    <div className="glass flex h-full min-h-0 min-w-0 flex-col gap-2 rounded-[var(--md-sys-shape-corner)] p-2">
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
              icon={<ListX className="h-3 w-3" />}
              onClick={() => {
                setManageTab(blockKeywords.length > 0 ? 'blocked' : 'deleted')
                setManageModalOpen(true)
              }}
            >
              管理
            </Button>
          )}
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
        className="h-full min-h-0 overflow-y-auto overflow-x-hidden rounded-[var(--md-sys-shape-corner)] border p-1.5"
        style={{
          backgroundColor: 'var(--glass-bg)',
          borderColor: 'var(--md-sys-color-outline-variant)',
        }}
      >
        {allDanmaku.length === 0 ? (
          renderEmpty()
        ) : (
          <div
            className="flex flex-col gap-0.5"
            style={{
              paddingTop: topPadding,
              paddingBottom: bottomPadding,
              height: totalHeight,
            }}
          >
            {visibleDanmaku.map((item) => (
              <DanmakuListItem
                key={item.id}
                item={item}
                isHighlighted={
                  Math.abs(item.actualTime - currentTime) <= WINDOW_SIZE
                }
                isBlocked={blockKeywords.includes(item.content)}
                onBlock={handleBlock}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {blockKeywords.length > 0 && (
        <div className="flex min-h-0 max-h-[80px] shrink-0 flex-col border-t border-white/10 px-1 pt-2">
          <div className="mb-1 text-[10px] text-white/40">
            已屏蔽关键词 ({blockKeywords.length})
          </div>
          <div className="flex flex-wrap gap-1 overflow-y-auto">
            {blockKeywords.slice(0, 10).map((kw) => (
              <button
                key={kw}
                type="button"
                className="max-w-full truncate rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] text-white/70 transition-colors hover:bg-white/10"
                title={`点击取消屏蔽：${kw}`}
                onClick={() => {
                  void removeBlockKeyword(kw)
                  triggerDanmakuRefresh()
                }}
              >
                {kw}
              </button>
            ))}
            {blockKeywords.length > 10 && (
              <span className="text-[10px] text-white/40">
                +{blockKeywords.length - 10}
              </span>
            )}
          </div>
        </div>
      )}

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
            ref={modalListRef}
            onScroll={handleModalScroll}
            className="max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-[var(--md-sys-shape-corner)] border p-2"
            style={{
              backgroundColor: 'var(--glass-bg)',
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
              <div
                className="flex flex-col gap-1"
                style={{
                  paddingTop: modalTopPadding,
                  paddingBottom: modalBottomPadding,
                  height: modalTotalHeight,
                }}
              >
                {modalVisibleDanmaku.map((item) => (
                  <DanmakuListItem
                    key={item.id}
                    item={item}
                    isHighlighted={
                      Math.abs(item.actualTime - currentTime) <= WINDOW_SIZE
                    }
                    isBlocked={blockKeywords.includes(item.content)}
                    onBlock={handleBlock}
                    onDelete={handleDelete}
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

      <Modal
        open={manageModalOpen}
        onClose={() => setManageModalOpen(false)}
        title="弹幕管理"
        className="max-w-lg"
      >
        <div className="flex flex-col gap-3">
          <div
            className="flex gap-1 rounded-lg border p-1"
            style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
          >
            <button
              type="button"
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                manageTab === 'blocked'
                  ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                  : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-white/5'
              )}
              onClick={() => setManageTab('blocked')}
            >
              已屏蔽 ({blockKeywords.length})
            </button>
            <button
              type="button"
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                manageTab === 'deleted'
                  ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                  : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-white/5'
              )}
              onClick={() => setManageTab('deleted')}
            >
              已删除 ({deletedLog.length})
            </button>
          </div>

          {manageTab === 'blocked' && (
            <div
              className="flex max-h-[50vh] min-h-[120px] flex-col gap-1.5 overflow-y-auto rounded-[var(--md-sys-shape-corner)] border p-2"
              style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
            >
              {blockKeywords.length === 0 ? (
                <div className="flex h-24 items-center justify-center">
                  <Text type="secondary" className="text-xs">
                    暂无屏蔽关键词
                  </Text>
                </div>
              ) : (
                blockKeywords.map((kw) => (
                  <div
                    key={kw}
                    className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                    style={{
                      borderColor: 'var(--md-sys-color-outline-variant)',
                    }}
                  >
                    <Ban
                      size={12}
                      className="shrink-0 text-[var(--md-sys-color-primary)]"
                    />
                    <Text
                      className="min-w-0 flex-1 truncate text-xs"
                      title={kw}
                    >
                      {kw}
                    </Text>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-[10px] text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-white/10 hover:text-red-400"
                      title="取消屏蔽"
                      onClick={() => {
                        void removeBlockKeyword(kw)
                        triggerDanmakuRefresh()
                      }}
                    >
                      取消
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {manageTab === 'deleted' && (
            <div
              className="flex max-h-[50vh] min-h-[120px] flex-col gap-1.5 overflow-y-auto rounded-[var(--md-sys-shape-corner)] border p-2"
              style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
            >
              {deletedLog.length === 0 ? (
                <div className="flex h-24 items-center justify-center">
                  <Text type="secondary" className="text-xs">
                    暂无已删除弹幕
                  </Text>
                </div>
              ) : (
                <>
                  {deletedLog.map((entry) => (
                    <div
                      key={`${entry.trackId}-${entry.item.id}`}
                      className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                      style={{
                        borderColor: 'var(--md-sys-color-outline-variant)',
                      }}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <Text
                          className="truncate text-xs"
                          title={entry.item.content}
                        >
                          {entry.item.content}
                        </Text>
                        <Text type="secondary" className="text-[10px]">
                          {formatDuration(entry.item.time)} · {entry.trackLabel}
                        </Text>
                      </div>
                      <button
                        type="button"
                        className="flex shrink-0 items-center gap-1 rounded p-1 text-[10px] text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-white/10 hover:text-green-400"
                        title="恢复该弹幕"
                        onClick={() => handleRestore(entry.trackId, entry.item)}
                      >
                        <RotateCcw size={12} />
                        恢复
                      </button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-7 w-full text-[10px] text-red-400 hover:bg-red-400/10"
                    onClick={() => {
                      void clearDeletedLog()
                      message.success('已清空删除记录')
                    }}
                  >
                    清空删除记录
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
