/**
 * 完整播放器歌词面板（Hydrogen components/Lyric.vue 的 React 1:1 复刻）。
 *
 * 复刻要点：
 * - 行样式：原文 20px / 翻译 14px 加粗，padding 10px 130px 10px 25px，
 *   行距 10px；点击行 seek（无时间戳行不可点），hover 行背景 4.5% 淡色
 * - 当前行：黑色高亮条从左侧滑入盖住整行（hilight，translateX(-101%)→0，
 *   0.62s cubic-bezier(0.3,0,0.12,1)），行文字放大 1.15 + 右移 26px 并反色
 * - 滚动：补偿式平滑动画——scrollTop 直接设为目标值，同时内容层以 WAAPI
 *   施加反向 translateY（delta→0，580ms cubic-bezier(0.4,0,0.12,1)），
 *   视觉平滑且瞬时定位不撕裂；当前行锚定在容器顶部 260px 处
 * - 手动滚动：wheel 打断动画进入手动模式，1s 无操作后强制回到当前行
 * - 间奏等待：当前行演唱结束点到下一行间隔 ≥ 13s 时，行下方展开 80px
 *   黑色装饰块（旋转菱形 + THE REMAINING TIME 倒计时）
 * - 空态：无歌词显示 Lyric-Area 对角线装饰 + 闪烁文字；纯音乐显示占位行
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LyricLine } from '../utils/lrc'
import { cn } from '@/lib/utils'

/** 滚动同步容差（px）：目标差值小于该值不做动画 */
const SCROLL_SYNC_TOLERANCE_PX = 2
/** 自动滚动动画时长（ms） */
const AUTO_SCROLL_DURATION_MS = 580
/** 自动滚动缓动 */
const AUTO_SCROLL_EASING = 'cubic-bezier(0.4, 0, 0.12, 1)'
/** 当前行锚定位置：容器顶部偏移（px） */
const FOLLOW_TOP_OFFSET_PX = 260
/** 手动滚动空闲（ms）：无操作后恢复自动跟随 */
const MANUAL_SCROLL_IDLE_MS = 1000
/** 间奏判定阈值（秒） */
const INTERLUDE_THRESHOLD_SEC = 13
/** 间奏块收起预留（秒）：接近下一行时提前收起 */
const INTERLUDE_END_LEAD_SEC = 0.8

export interface PlayerLyricPanelProps {
  lines: LyricLine[]
  activeIndex: number
  positionSec: number
  /** 空态模式：null=有歌词；'none'=无歌词（Lyric-Area 装饰）；'pure'=纯音乐占位行 */
  emptyMode: 'none' | 'pure' | null
  /** 是否已就绪（首帧防闪烁：false 时内容 visibility hidden） */
  revealed: boolean
  /** 是否显示翻译行（Hydrogen lyricType 开关） */
  showTranslation: boolean
  /** 点击歌词行跳转进度（秒） */
  onSeek: (time: number) => void
}

/** 估算一行歌词的演唱结束时间（秒）。
 * 文本单位速率模型（Hydrogen lyricCore 思路）：汉字/假名按 1 单位、
 * 拉丁词按 0.6 单位，每单位约 0.32s，clamp 到 1.2~10s。 */
function estimateLineEndSec(line: LyricLine, nextTime: number): number {
  let units = 0
  for (const ch of line.text) {
    if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(ch)) units += 1
  }
  const latinWords = line.text
    .replace(/[\u4e00-\u9fff\u3040-\u30ff]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length
  units += latinWords * 0.6
  if (units <= 0) return Math.min(line.time + 1.2, nextTime)
  const est = Math.min(10, Math.max(1.2, units * 0.32))
  return Math.min(line.time + est, nextTime)
}

export function PlayerLyricPanel({
  lines,
  activeIndex,
  positionSec,
  emptyMode,
  revealed,
  showTranslation,
  onSeek,
}: PlayerLyricPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** 进行中的滚动补偿动画（手动滚动/组件更新时取消） */
  const scrollAnimRef = useRef<Animation | null>(null)
  /** 手动滚动模式：wheel 打断自动跟随，空闲后恢复 */
  const [manualMode, setManualMode] = useState(false)
  const manualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 记录上次同步的 activeIndex，避免同 index 重复动画 */
  const lastSyncedIndexRef = useRef(-1)
  /** 切歌（lines 变化）时退出手动模式（render 期调整，替代 effect 内同步 setState） */
  const [prevLines, setPrevLines] = useState(lines)
  if (prevLines !== lines) {
    setPrevLines(lines)
    setManualMode(false)
  }

  /** 计算当前行的目标 scrollTop（行顶锚定到容器顶部 260px 处，clamp 到底） */
  const computeTargetTop = useCallback((index: number): number | null => {
    const container = scrollRef.current
    const content = contentRef.current
    if (!container || !content) return null
    const rows = content.querySelectorAll<HTMLElement>('[data-lyric-row]')
    const row = rows[index]
    if (!row) return null
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const currentTop = rowRect.top - containerRect.top + container.scrollTop
    const maxTop = container.scrollHeight - container.clientHeight
    return Math.min(
      Math.max(currentTop - FOLLOW_TOP_OFFSET_PX, 0),
      Math.max(0, maxTop)
    )
  }, [])

  /** 补偿式平滑滚动：scrollTop 瞬时到位 + 内容层反向位移补偿（580ms 回落） */
  const animateScrollTo = useCallback((targetTop: number) => {
    const container = scrollRef.current
    const content = contentRef.current
    if (!container || !content) return
    const delta = container.scrollTop - targetTop
    if (Math.abs(delta) < SCROLL_SYNC_TOLERANCE_PX) return
    scrollAnimRef.current?.cancel()
    container.scrollTop = targetTop
    scrollAnimRef.current = content.animate(
      [
        { transform: `translate3d(0, ${delta}px, 0)` },
        { transform: 'translate3d(0, 0, 0)' },
      ],
      {
        duration: AUTO_SCROLL_DURATION_MS,
        easing: AUTO_SCROLL_EASING,
        fill: 'both',
      }
    )
  }, [])

  // activeIndex 变化 → 自动跟随滚动（手动模式下不动画；防闪烁 revealed
  // 就绪后也会同步一次，保证切歌后滚动位置正确）
  useEffect(() => {
    if (activeIndex < 0 || manualMode || !revealed) return
    lastSyncedIndexRef.current = activeIndex
    const target = computeTargetTop(activeIndex)
    if (target == null) return
    animateScrollTo(target)
  }, [activeIndex, manualMode, revealed, computeTargetTop, animateScrollTo])

  // 切歌（lines 变化）时重置同步缓存并取消进行中的补偿动画（ref 操作）
  useEffect(() => {
    lastSyncedIndexRef.current = -1
    scrollAnimRef.current?.cancel()
  }, [lines])

  // 手动滚动：wheel 打断动画 + 进入手动模式，空闲 1s 后强制回到当前行
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const handleWheel = () => {
      scrollAnimRef.current?.cancel()
      setManualMode(true)
      if (manualTimerRef.current) clearTimeout(manualTimerRef.current)
      manualTimerRef.current = setTimeout(() => {
        setManualMode(false)
        // 强制回到当前行（无视 lastSynced 缓存）
        const idx = lastSyncedIndexRef.current
        if (idx >= 0) {
          const target = computeTargetTop(idx)
          if (target != null) animateScrollTo(target)
        }
      }, MANUAL_SCROLL_IDLE_MS)
    }
    container.addEventListener('wheel', handleWheel, { passive: true })
    return () => {
      container.removeEventListener('wheel', handleWheel)
      if (manualTimerRef.current) clearTimeout(manualTimerRef.current)
    }
  }, [computeTargetTop, animateScrollTo])

  // 间奏等待：当前行结束到下一行的间隔 ≥ 13s 时，显示倒计时装饰块
  const interlude = useMemo(() => {
    const line = lines[activeIndex]
    const next = lines[activeIndex + 1]
    if (!line || !next) return null
    const end = estimateLineEndSec(line, next.time)
    const gap = next.time - end
    if (gap < INTERLUDE_THRESHOLD_SEC) return null
    const remaining = next.time - positionSec
    return {
      show: positionSec > end && remaining > INTERLUDE_END_LEAD_SEC,
      remaining: Math.max(1, Math.ceil(remaining)),
    }
  }, [lines, activeIndex, positionSec])

  const showNodata = emptyMode === 'none'

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-y-auto"
      style={{ visibility: revealed ? 'visible' : 'hidden' }}
    >
      {/* 空态：无歌词 → Lyric-Area 装饰（对角线展开 + 文字闪烁三下） */}
      {showNodata ? (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <div
            className="lyric-nodata-grow"
            style={{
              background:
                'linear-gradient(to top right, transparent calc(50% - 0.6px), var(--md-sys-color-on-surface), transparent calc(50% + 0.6px))',
            }}
            aria-hidden="true"
          />
          <span
            className="lyric-nodata-tip text-[16px] font-bold tracking-wider text-[var(--md-sys-color-on-surface)]"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          >
            Lyric-Area
          </span>
          <div
            className="lyric-nodata-grow"
            style={{
              background:
                'linear-gradient(to bottom right, transparent calc(50% - 0.6px), var(--md-sys-color-on-surface), transparent calc(50% + 0.6px))',
            }}
            aria-hidden="true"
          />
        </div>
      ) : (
        <div ref={contentRef}>
          {/* 顶部锚定留白：当前行定位在容器顶部 260px 处 */}
          <div style={{ height: FOLLOW_TOP_OFFSET_PX }} aria-hidden="true" />
          {/* 纯音乐：单行占位（time 0 即高亮，不可点） */}
          {emptyMode === 'pure' && (
            <LyricRow
              line={{ time: 0, text: '纯音乐，请欣赏' }}
              active
              untimed
              showTranslation={showTranslation}
              onSeek={onSeek}
              interlude={null}
            />
          )}
          {emptyMode === null &&
            lines.map((line, i) => {
              const active = i === activeIndex
              // 间奏块仅渲染在当前行下方
              const lineInterlude =
                active && interlude
                  ? {
                      show: interlude.show,
                      remaining: interlude.remaining,
                    }
                  : null
              return (
                <LyricRow
                  key={`${line.time}-${i}`}
                  line={line}
                  active={active}
                  showTranslation={showTranslation}
                  onSeek={onSeek}
                  interlude={lineInterlude}
                />
              )
            })}
          {/* 底部留白：最后一行也能锚定到 260px 位置 */}
          <div style={{ height: 180 }} aria-hidden="true" />
        </div>
      )}
    </div>
  )
}

/** 单行歌词（黑色高亮条 + 文本反色放大 + 可选翻译 + 间奏装饰块） */
function LyricRow({
  line,
  active,
  untimed = false,
  showTranslation = true,
  onSeek,
  interlude,
}: {
  line: LyricLine
  active: boolean
  /** 无时间戳（纯音乐占位等）：不可点击 seek */
  untimed?: boolean
  /** 是否显示翻译行 */
  showTranslation?: boolean
  onSeek: (time: number) => void
  interlude: { show: boolean; remaining: number } | null
}) {
  const clickable = !untimed
  return (
    <div data-lyric-row className="mb-[10px]">
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? () => onSeek(line.time) : undefined}
        className={cn(
          'relative overflow-hidden px-[130px] py-[10px] pl-[25px] transition-colors duration-300',
          clickable &&
            'cursor-pointer hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_4.5%,transparent)]'
        )}
      >
        {/* 黑色高亮条：藏在左侧，当前行滑入盖住整行 */}
        <span
          aria-hidden="true"
          className="absolute inset-0 z-0 w-full transition-transform duration-[550ms] ease-[cubic-bezier(0.3,0,0.12,1)]"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            transform: active ? 'translateX(0)' : 'translateX(-101%)',
            // 当前行的高亮条稍慢进场（Hydrogen .hilight-active 0.62s）
            transitionDuration: active ? '620ms' : '550ms',
          }}
        />
        {/* 文本层：当前行放大 1.15 + 右移 26px + 反色 */}
        <div
          className={cn(
            'relative z-[1] min-w-0',
            'transition-transform duration-[400ms] ease-[cubic-bezier(0.3,0,0.12,1)]'
          )}
          style={{
            transform: active ? 'scale(1.15) translateX(26px)' : 'scale(1)',
            transformOrigin: 'left center',
            color: active
              ? 'var(--md-sys-color-surface)'
              : 'color-mix(in srgb, var(--md-sys-color-on-surface) 60%, transparent)',
          }}
        >
          <p className="m-0 truncate text-[20px] font-bold leading-[1.5]">
            {line.text}
          </p>
          {showTranslation && line.translation && (
            <p className="m-0 truncate text-[14px] font-bold leading-[1.5] opacity-80">
              {line.translation}
            </p>
          )}
        </div>
      </div>
      {/* 间奏等待装饰块：80px 黑色块 + 旋转菱形 + 倒计时 */}
      {interlude?.show && (
        <div
          className="mx-[25px] flex h-20 items-center gap-3 px-[26px]"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            color: 'var(--md-sys-color-surface)',
          }}
        >
          <span
            className="interlude-diamond block h-3 w-3"
            style={{
              backgroundColor: 'var(--md-sys-color-surface)',
            }}
            aria-hidden="true"
          />
          <span className="text-sm font-bold tracking-wider tabular-nums">
            THE REMAINING TIME: {interlude.remaining}
          </span>
        </div>
      )}
    </div>
  )
}
