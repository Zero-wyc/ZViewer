/**
 * 房间内「一起听」单行歌词（桌面歌词样式）。
 *
 * 需求：只显示一行——当前正在播放的那句；还没到第一句时显示即将播放的
 * 那句。非全屏时贴在播放器正下方；播放器全屏（原生/网页）时浮在播放器
 * 上层，可触摸拖动。
 *
 * 结构与数据链路：
 * - 布局（RoomLayout / CinemaLayout）把播放器下方的一块空容器注册到
 *   listenLyricsStore，非全屏时本组件 portal 进去，不依赖布局层级；
 * - 全屏时播放器通过 fullscreenOverlayStore 暴露舞台元素，本组件 portal
 *   到舞台内部（原生全屏下 body 上的浮层不显示），absolute 定位 + Pointer
 *   Events 拖动，位置按舞台比例持久化；
 * - 歌词数据仍走 useLyricTrack（网易云歌词 / B站 AI 字幕），进度用
 *   getPositionSec() + 二分查找定位当前行。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { GripHorizontal, Music2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'
import { useListenLyricsStore } from '@/store/listenLyricsStore'
import { useFullscreenOverlayStore } from '@/store/fullscreenOverlayStore'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { useLyricTrack, type LyricEmptyMode } from '../hooks/useLyricTrack'
import { getPositionSec, subscribePositionSec } from '../hooks/usePlaybackPosition'
import { LYRIC_ADVANCE_SEC } from '../constants'
import {
  applyLyricLineOffsets,
  getLyricOffsetSongKey,
  loadLyricLineOffsetStore,
} from '../utils/lyricLineOffset'
import type { LyricLine } from '../utils/lrc'

/** 浮层宽度上限（px）：窄屏用 calc(100% - 24px) 兜底 */
const OVERLAY_MAX_WIDTH_PX = 480
/** 浮层拖动位置持久化 key（按舞台宽高比例存，换屏幕不跑偏） */
const OVERLAY_POS_STORAGE_KEY = 'zviewer:listenLyricsOverlayPos:v1'

interface Position {
  left: number
  top: number
}

interface Bounds {
  width: number
  height: number
  panelWidth: number
  panelHeight: number
  controlBarHeight: number
}

/** 单行歌词文本：当前句正常色，尚未开始时的那句淡一些 */
function SingleLineText({
  lines,
  activeIndex,
  emptyMode,
  revealed,
  className,
}: {
  lines: LyricLine[]
  activeIndex: number
  emptyMode: LyricEmptyMode
  revealed: boolean
  className?: string
}) {
  const current = activeIndex >= 0 ? lines[activeIndex] : undefined
  const next = lines[activeIndex + 1]
  const line = current ?? next
  const isUpcoming = !current && Boolean(next)

  if (!revealed) return null
  if (emptyMode === 'pure') {
    return (
      <span className={cn('break-words text-center', className)}>
        {t('纯音乐，请欣赏')}
      </span>
    )
  }
  if (!line) return null
  return (
    <span
      key={line.lyricLineKey ?? String(activeIndex)}
      className={cn(
        'lt-single-lyric-in block min-w-0 break-words text-center',
        isUpcoming && 'opacity-55',
        className
      )}
      title={line.text}
    >
      {line.text}
    </span>
  )
}

interface LineProps {
  lines: LyricLine[]
  activeIndex: number
  emptyMode: LyricEmptyMode
  revealed: boolean
}

/** 播放器下方单行歌词条 */
function CompactLyrics({ lines, activeIndex, emptyMode, revealed }: LineProps) {
  return (
    <div
      data-listen-lyrics="compact"
      className="glass-card mt-2 flex min-h-10 w-full min-w-0 items-center gap-2 rounded-xl px-3 py-1.5"
    >
      <Music2 className="h-3.5 w-3.5 flex-none opacity-50" />
      <div className="min-w-0 flex-1 text-sm">
        <SingleLineText
          lines={lines}
          activeIndex={activeIndex}
          emptyMode={emptyMode}
          revealed={revealed}
        />
      </div>
    </div>
  )
}

/** 全屏浮层：portal 到播放器舞台内部，整条可拖动 */
function FloatingLyrics({
  target,
  lines,
  activeIndex,
  emptyMode,
  revealed,
}: LineProps & { target: HTMLElement }) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<Position | null>(null)
  const posRef = useRef<Position | null>(null)
  posRef.current = pos
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    left: number
    top: number
  } | null>(null)
  const prevTargetRef = useRef<HTMLElement | null>(null)

  const controlBarHeight = useFullscreenOverlayStore((s) => s.controlBarHeight)
  const commentPaneOrientation = useFullscreenOverlayStore(
    (s) => s.commentPaneOrientation
  )
  const commentPaneSize = useFullscreenOverlayStore((s) => s.commentPaneSize)

  /** 可用区域：扣除全屏分屏评论区占掉的宽度/高度 */
  const measure = useCallback((): Bounds | null => {
    const panel = panelRef.current
    if (!panel) return null
    const rect = target.getBoundingClientRect()
    const pane =
      commentPaneOrientation === 'side' ||
      commentPaneOrientation === 'stacked'
        ? commentPaneSize
        : 0
    return {
      width: Math.max(
        0,
        rect.width - (commentPaneOrientation === 'side' ? pane : 0)
      ),
      height: Math.max(
        0,
        rect.height - (commentPaneOrientation === 'stacked' ? pane : 0)
      ),
      panelWidth: panel.offsetWidth,
      panelHeight: panel.offsetHeight,
      controlBarHeight,
    }
  }, [target, commentPaneOrientation, commentPaneSize, controlBarHeight])

  const clampTo = useCallback(
    (left: number, top: number, b: Bounds): Position => {
      const maxLeft = Math.max(0, b.width - b.panelWidth)
      const maxTop = Math.max(0, b.height - b.panelHeight)
      return {
        left: Math.min(Math.max(0, left), maxLeft),
        top: Math.min(Math.max(0, top), maxTop),
      }
    },
    []
  )

  /** 默认位置：控制栏上方居中 */
  const defaultPosition = useCallback(
    (b: Bounds): Position =>
      clampTo(
        (b.width - b.panelWidth) / 2,
        b.height - b.panelHeight - Math.max(b.controlBarHeight, 0) - 12,
        b
      ),
    [clampTo]
  )

  // 初始位置 / 舞台变化后的边界修正
  useLayoutEffect(() => {
    const b = measure()
    if (!b) return
    const targetChanged = prevTargetRef.current !== target
    prevTargetRef.current = target
    if (targetChanged) {
      let saved: { fx: number; fy: number } | null = null
      try {
        const raw = localStorage.getItem(OVERLAY_POS_STORAGE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw) as { fx?: unknown; fy?: unknown }
          if (
            typeof parsed?.fx === 'number' &&
            typeof parsed?.fy === 'number' &&
            Number.isFinite(parsed.fx) &&
            Number.isFinite(parsed.fy)
          ) {
            saved = { fx: parsed.fx, fy: parsed.fy }
          }
        }
      } catch {
        // 忽略损坏数据
      }
      setPos(
        saved
          ? clampTo(saved.fx * b.width, saved.fy * b.height, b)
          : defaultPosition(b)
      )
      return
    }
    setPos((prev) => (prev ? clampTo(prev.left, prev.top, b) : defaultPosition(b)))
  }, [
    measure,
    clampTo,
    defaultPosition,
    target,
    commentPaneOrientation,
    commentPaneSize,
    controlBarHeight,
  ])

  // 窗口/舞台尺寸变化时保持在可视区域内
  useEffect(() => {
    const handleResize = () => {
      const b = measure()
      if (!b) return
      setPos((prev) => (prev ? clampTo(prev.left, prev.top, b) : prev))
    }
    window.addEventListener('resize', handleResize)
    const ro = new ResizeObserver(handleResize)
    ro.observe(target)
    const panel = panelRef.current
    if (panel) ro.observe(panel)
    return () => {
      window.removeEventListener('resize', handleResize)
      ro.disconnect()
    }
  }, [measure, clampTo, target])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.pointerType === 'mouse' && event.button !== 0) return
      const b = measure()
      const current = posRef.current
      if (!b || !current) return
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: current.left,
        top: current.top,
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    },
    [measure]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const b = measure()
      if (!b) return
      event.preventDefault()
      event.stopPropagation()
      const next = clampTo(
        drag.left + event.clientX - drag.startX,
        drag.top + event.clientY - drag.startY,
        b
      )
      posRef.current = next
      setPos(next)
    },
    [measure, clampTo]
  )

  const finishDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      setDragging(false)
      try {
        event.currentTarget.releasePointerCapture(drag.pointerId)
      } catch {
        // 指针已释放
      }
      event.stopPropagation()
      const b = measure()
      const current = posRef.current
      if (!b || !current || b.width <= 0 || b.height <= 0) return
      try {
        localStorage.setItem(
          OVERLAY_POS_STORAGE_KEY,
          JSON.stringify({
            fx: current.left / b.width,
            fy: current.top / b.height,
          })
        )
      } catch {
        // 隐私模式/配额不足时忽略
      }
    },
    [measure]
  )

  return (
    <div
      ref={panelRef}
      role="group"
      aria-label={t('一起听歌词')}
      data-listen-lyrics="overlay"
      className={cn(
        'glass-card absolute z-40 flex min-h-11 select-none items-center gap-2 rounded-2xl px-3 py-1.5 shadow-2xl',
        dragging ? 'cursor-grabbing' : 'cursor-grab'
      )}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: `min(${OVERLAY_MAX_WIDTH_PX}px, calc(100% - 24px))`,
        visibility: pos ? 'visible' : 'hidden',
        touchAction: 'none',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onClick={(event) => event.stopPropagation()}
      title={t('拖动可移动歌词')}
    >
      <GripHorizontal className="h-4 w-4 flex-none opacity-45" />
      <div className="min-w-0 flex-1 text-[15px] leading-snug">
        <SingleLineText
          lines={lines}
          activeIndex={activeIndex}
          emptyMode={emptyMode}
          revealed={revealed}
        />
      </div>
    </div>
  )
}

/**
 * 房间内一起听单行歌词。挂在 MusicPlayerProvider 下：
 * 全屏时浮层优先，否则渲染到布局注册的播放器下方插槽。
 */
export function ListenTogetherLyrics() {
  const slot = useListenLyricsStore((s) => s.slot)
  const overlayTarget = useFullscreenOverlayStore((s) => s.target)
  const { currentSong, isPlaying } = useMusicPlayer()
  const currentKey = useMusicStore((s) => s.currentKey)

  const songId = currentSong?.songId
  const { lyricLines, emptyMode, lyricRevealed } = useLyricTrack({
    songId,
    currentKey,
    biliBvid: currentSong?.biliBvid,
    biliCid: currentSong?.biliCid,
    biliDurationMs: currentSong?.durationMs,
  })

  // 行偏移只读：一起听页里调过的偏移在这里同样生效
  const [offsetStore] = useState(loadLyricLineOffsetStore)
  const displayLyricLines = useMemo(
    () =>
      applyLyricLineOffsets(lyricLines, offsetStore, getLyricOffsetSongKey(songId)),
    [lyricLines, offsetStore, songId]
  )

  // 当前行：最后一个 time <= 播放位置 + 提前量的行（二分查找）
  const activeIndex = useSyncExternalStore(
    subscribePositionSec,
    () => {
      if (displayLyricLines.length === 0) return -1
      const targetTime = getPositionSec() + LYRIC_ADVANCE_SEC
      let ans = -1
      let lo = 0
      let hi = displayLyricLines.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (displayLyricLines[mid].time <= targetTime) {
          ans = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return ans
    },
    () => -1
  )

  // 音乐未播放（含暂停）时不显示歌词条，避免暂停后仍挂着一行歌词
  const hasContent = displayLyricLines.length > 0 || emptyMode === 'pure'
  if (!isPlaying || currentSong == null || !lyricRevealed || !hasContent) {
    return null
  }

  const lineProps = {
    lines: displayLyricLines,
    activeIndex,
    emptyMode,
    revealed: lyricRevealed,
  }

  if (overlayTarget) {
    return <FloatingLyrics target={overlayTarget} {...lineProps} />
  }
  if (slot) {
    return createPortal(<CompactLyrics {...lineProps} />, slot)
  }
  return null
}
