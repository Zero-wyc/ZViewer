/**
 * 完整播放器歌词面板（Hydrogen components/Lyric.vue 的 React 1:1 复刻）。
 *
 * 复刻要点：
 * - 行样式：原文 20px / 翻译 14px 加粗，padding 10px 130px 10px 25px，
 *   行距 10px；点击行 seek（无时间戳行不可点），hover 行背景 4.5% 淡色，
 *   按下行整体 scale(0.9)（Hydrogen .line:active）
 * - 当前行：黑色高亮条从左侧滑入盖住整行（hilight，translateX(-101%)→0，
 *   滑入 0.62s / 滑出 0.55s cubic-bezier(0.3,0,0.12,1)），行文字放大 1.15 +
 *   右移 26px 并反色（高亮过渡 0.4s / 失焦过渡 0.5s，双时长）
 * - 手动滚动模式：非当前行文字 scale(1.05)（Hydrogen .lyric-inactive）
 * - 滚动：补偿式平滑动画——scrollTop 直接设为目标值，同时内容层以 WAAPI
 *   施加反向 translateY（delta→0，580ms cubic-bezier(0.4,0,0.12,1)），
 *   视觉平滑且瞬时定位不撕裂；当前行锚定在容器顶部 260px 处
 * - 间奏等待（1:1 复刻 .music-interlude）：当前行演唱结束到下一行间隔
 *   ≥ 阈值时，行下方展开 80px 黑色装饰块（高度 0→80 + scale + 透明度
 *   0.8s 展开动画；收起走弹性曲线 cubic-bezier(1,-0.49,0.61,0.36)，
 *   切行时立即折叠 = fast-close）：左侧 28px 旋转菱形（45°→135°，1.6s
 *   延迟 0.6s 循环）+ 右侧三角标 + THE REMAINING TIME 倒计时 +
 *   MUSIC INTERLUDE 黑底标题（内嵌频谱竖线 SVG 装饰）+ 4px 进度条
 * - 空态：无歌词显示 Lyric-Area——左下/右上两条对角线 38% 展开
 *   （0.8s 延迟 0.5s cubic-bezier(0.32,0.81,0.56,0.98)）+ 文字
 *   0.1s 延迟 1.3s 内闪烁三下常显；纯音乐显示占位行
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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
  /** 是否显示翻译行（播放器内翻译开关） */
  showTranslation: boolean
  /** 是否显示原词行（播放器内原词开关；关闭时仅显示翻译/罗马音） */
  showOriginal?: boolean
  /** 是否显示罗马音行（播放器内罗马音开关） */
  showRoman?: boolean
  /** 原文字号（px，设置：歌词字体大小） */
  lyricSize?: number
  /** 翻译字号（px，设置：歌词翻译字体大小） */
  tlyricSize?: number
  /** 罗马音字号（px，设置：罗马歌词字体大小） */
  rlyricSize?: number
  /** 间奏倒计时阈值（秒，设置：歌词间奏等待时间） */
  interludeThresholdSec?: number
  /** 歌词模糊：非当前行 blur（当前行保持清晰；设置：开启歌词模糊） */
  lyricBlur?: boolean
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
  showOriginal = true,
  showRoman = true,
  lyricSize = 20,
  tlyricSize = 14,
  rlyricSize = 12,
  interludeThresholdSec = 13,
  lyricBlur = false,
  onSeek,
}: PlayerLyricPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** 进行中的滚动补偿动画（手动滚动/组件更新时取消） */
  const scrollAnimRef = useRef<Animation | null>(null)
  /** 手动滚动模式：wheel 打断自动跟随，空闲后恢复（非当前行文字 scale 1.05） */
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

  // activeIndex 变化 → 自动跟随滚动。必须用 useLayoutEffect（DOM commit 后、
  // 浏览器 paint 前同步执行，等价 Hydrogen watch flush:'post' 的"DOM patch 后
  // 立即启动跟随动画"）：useEffect 在 paint 之后才跑，会多等一帧导致
  // "高亮先跳、视图后追"的闪动撕裂感（Hydrogen 注释明确点过这一坑）。
  // 手动模式下不动画；防闪烁 revealed 就绪后也会同步一次，保证切歌后位置正确
  useLayoutEffect(() => {
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

  // 间奏等待（Hydrogen handleInterludeOnIndexChange/OnProgress 的等价实现）：
  // 当前行结束到下一行的间隔 ≥ 阈值（设置：歌词间奏等待时间）时展示倒计时，
  // 剩余时间 ≤ 收起预留（0.8s）时提前收起（INTERLUDE_EXIT 预留）
  const interlude = useMemo(() => {
    const line = lines[activeIndex]
    const next = lines[activeIndex + 1]
    if (!line || !next) return null
    const end = estimateLineEndSec(line, next.time)
    const gap = next.time - end
    if (gap < interludeThresholdSec) return null
    const remaining = next.time - positionSec
    return {
      show: positionSec > end && remaining > INTERLUDE_END_LEAD_SEC,
      remaining: Math.max(1, Math.ceil(remaining)),
    }
  }, [lines, activeIndex, positionSec, interludeThresholdSec])

  const showNodata = emptyMode === 'none'

  return (
    <div
      ref={scrollRef}
      className="hide-scrollbar relative min-h-0 flex-1 overflow-y-auto"
      style={{ visibility: revealed ? 'visible' : 'hidden' }}
    >
      {/* 空态：无歌词 → Lyric-Area 装饰（Hydrogen .lyric-nodata 布局：
          左下 / 右上两条对角线 38% 展开，文字居中闪烁三下常显） */}
      {showNodata ? (
        <div className="relative h-full w-full">
          <div
            className="lyric-nodata-grow absolute bottom-[4%] left-[4%]"
            style={{
              background:
                'linear-gradient(to top right, transparent calc(50% - 0.6px), var(--md-sys-color-on-surface), transparent calc(50% + 0.6px))',
            }}
            aria-hidden="true"
          />
          <div
            className="lyric-nodata-grow absolute right-[4%] top-[4%]"
            style={{
              background:
                'linear-gradient(to bottom right, transparent calc(50% - 0.6px), var(--md-sys-color-on-surface), transparent calc(50% + 0.6px))',
            }}
            aria-hidden="true"
          />
          <span className="lyric-nodata-tip absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[16px] font-bold tracking-wider">
            Lyric-Area
          </span>
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
              showOriginal={showOriginal}
              showRoman={showRoman}
              lyricSize={lyricSize}
              tlyricSize={tlyricSize}
              rlyricSize={rlyricSize}
              lyricBlur={lyricBlur}
              onSeek={onSeek}
              interlude={null}
              manualInactive={false}
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
                  showOriginal={showOriginal}
                  showRoman={showRoman}
                  lyricSize={lyricSize}
                  tlyricSize={tlyricSize}
                  rlyricSize={rlyricSize}
                  lyricBlur={lyricBlur}
                  onSeek={onSeek}
                  interlude={lineInterlude}
                  manualInactive={manualMode}
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

/** 单行歌词（黑色高亮条 + 文本反色放大 + 可选原词/翻译/罗马音 + 间奏装饰块）。
 *  memo：positionSec 高频更新（间奏倒计时依赖它），若全列表行都重渲染会
 *  拉长 paint 帧加剧行切换的视觉撕裂；memo 后仅 active 切换的两行渲染 */
const LyricRow = memo(function LyricRow({
  line,
  active,
  untimed = false,
  showTranslation = true,
  showOriginal = true,
  showRoman = true,
  lyricSize = 20,
  tlyricSize = 14,
  rlyricSize = 12,
  lyricBlur = false,
  onSeek,
  interlude,
  manualInactive,
}: {
  line: LyricLine
  active: boolean
  /** 无时间戳（纯音乐占位等）：不可点击 seek */
  untimed?: boolean
  /** 是否显示翻译行 */
  showTranslation?: boolean
  /** 是否显示原词行 */
  showOriginal?: boolean
  /** 是否显示罗马音行 */
  showRoman?: boolean
  /** 原文 / 翻译 / 罗马音字号（px，设置驱动） */
  lyricSize?: number
  tlyricSize?: number
  rlyricSize?: number
  /** 非当前行模糊（设置：开启歌词模糊） */
  lyricBlur?: boolean
  onSeek: (time: number) => void
  interlude: { show: boolean; remaining: number } | null
  /** 手动滚动模式：非当前行文字 scale(1.05)（Hydrogen .lyric-inactive） */
  manualInactive?: boolean
}) {
  const clickable = !untimed
  return (
    <div
      data-lyric-row
      className="lyric-row-transition mb-[10px] w-full text-left"
    >
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? () => onSeek(line.time) : undefined}
        className={cn(
          'lyric-line-active relative flex origin-left flex-col items-start overflow-hidden px-[130px] py-[10px] pl-[25px]',
          clickable &&
            'cursor-pointer hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_4.5%,transparent)]'
        )}
      >
        {/* 黑色高亮条：藏在左侧，当前行滑入盖住整行 */}
        <span
          aria-hidden="true"
          className="absolute inset-0 z-0 w-full transition-transform ease-[cubic-bezier(0.3,0,0.12,1)]"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            transform: active ? 'translateX(0)' : 'translateX(-101%)',
            // 当前行的高亮条稍慢进场（Hydrogen .hilight-active 0.62s）
            transitionDuration: active ? '620ms' : '550ms',
          }}
        />
        {/* 文本层：当前行放大 1.15 + 右移 26px + 反色；
            手动滚动模式非当前行 scale(1.05)（Hydrogen .lyric-inactive）；
            开启歌词模糊时非当前行 blur */}
        <div
          className={cn('relative z-[1] min-w-0 origin-left')}
          style={{
            color: active
              ? 'var(--md-sys-color-surface)'
              : 'var(--md-sys-color-on-surface)',
            filter: !active && lyricBlur ? 'blur(2.5px)' : 'blur(0px)',
          }}
        >
          {showOriginal && (
            <p
              className={cn(
                'lyric-text m-0 break-words font-bold leading-[1.5]',
                active && 'lyric-text-active'
              )}
              style={{
                fontSize: lyricSize,
                transform: active
                  ? 'scale(1.15) translateX(26px)'
                  : manualInactive
                    ? 'scale(1.05)'
                    : 'scale(1)',
              }}
            >
              {line.text}
            </p>
          )}
          {showTranslation && line.translation && (
            <p
              className={cn(
                'lyric-text m-0 break-words font-bold leading-[1.5]',
                active && 'lyric-text-active'
              )}
              style={{
                fontSize: tlyricSize,
                transform: active
                  ? 'scale(1.15) translateX(26px)'
                  : manualInactive
                    ? 'scale(1.05)'
                    : 'scale(1)',
              }}
            >
              {line.translation}
            </p>
          )}
          {showRoman && line.roman && (
            <p
              className={cn(
                'lyric-text m-0 break-words font-bold leading-[1.5]',
                active && 'lyric-text-active'
              )}
              style={{
                fontSize: rlyricSize,
                transform: active
                  ? 'scale(1.15) translateX(26px)'
                  : manualInactive
                    ? 'scale(1.05)'
                    : 'scale(1)',
              }}
            >
              {line.roman}
            </p>
          )}
        </div>
      </div>
      {/* 间奏等待装饰块（Hydrogen .music-interlude 1:1）：块在当前行下方
          常驻（间奏行期间），由 open class 驱动高度 0↔80px 展开动画——
          展开 0.8s cubic-bezier(0.3,0,0.12,1)，收起走弹性曲线
          cubic-bezier(1,-0.49,0.61,0.36)；切行时块整体卸载 = fast-close */}
      {interlude && (
        <div
          className={cn(
            'lyric-interlude-block relative left-0 flex flex-row items-center justify-center',
            interlude.show && 'open'
          )}
        >
          <div className="flex flex-row items-center justify-center">
            <div className="mr-[15px]">
              <span
                className="interlude-diamond relative block h-[28px] w-[28px] border-2"
                style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
              >
                <span
                  className="absolute left-1/2 top-1/2 block h-[85%] w-[85%] -translate-x-1/2 -translate-y-1/2"
                  style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
                  aria-hidden="true"
                />
              </span>
            </div>
            <div className="relative flex w-full flex-col overflow-hidden">
              <span
                className="absolute right-0 top-px h-0 w-0 border-l-[6px] border-l-transparent"
                style={{
                  borderTop: '6px solid var(--md-sys-color-on-surface)',
                }}
                aria-hidden="true"
              />
              <span
                className="whitespace-nowrap text-[8px] font-bold tabular-nums"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
              >
                THE REMAINING TIME: {interlude.remaining}
              </span>
              <div
                className="mt-[2px] flex w-full flex-row items-center justify-between whitespace-nowrap px-1 py-0"
                style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              >
                <span
                  className="text-[10px] font-bold"
                  style={{ color: 'var(--md-sys-color-surface)' }}
                >
                  MUSIC INTERLUDE
                </span>
                {/* 频谱竖线装饰（Hydrogen title-style SVG 1:1 等价） */}
                <svg
                  width="49"
                  height="8"
                  viewBox="0 0 49 8"
                  fill="none"
                  aria-hidden="true"
                >
                  {[
                    [1, 3],
                    [5, 1],
                    [8, 2],
                    [12, 2],
                    [16, 1],
                    [19, 2],
                    [23, 2],
                    [27, 1],
                    [30, 2],
                    [34, 1],
                    [40, 3],
                    [43, 1],
                    [46, 1],
                    [48, 1],
                  ].map(([x, w]) => (
                    <line
                      key={x}
                      x1={x}
                      y1="0"
                      x2={x}
                      y2="8"
                      stroke="var(--md-sys-color-surface)"
                      strokeWidth={w}
                    />
                  ))}
                </svg>
              </div>
              <div
                className="mt-[3px] h-[4px] w-full"
                style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
