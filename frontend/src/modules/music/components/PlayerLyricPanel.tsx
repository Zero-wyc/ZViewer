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
/** 当前行锚定位置：容器顶部偏移（px，Hydrogen LYRIC_FOLLOW_TOP_OFFSET_PX） */
const FOLLOW_TOP_OFFSET_PX = 260
/** 底部留白基线（px，Hydrogen LYRIC_FOLLOW_BOTTOM_GUTTER_PX） */
const FOLLOW_BOTTOM_GUTTER_PX = 180
/** 可视边距（px，Hydrogen LYRIC_FOLLOW_VISIBLE_GUTTER_PX）：
 *  行高超出容器时收缩锚定偏移，保证当前行至少露出这么多 */
const FOLLOW_VISIBLE_GUTTER_PX = 24
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
  /** 进行中的滚动补偿动画（Hydrogen lyricContentAnimation） */
  const scrollAnimRef = useRef<Animation | null>(null)
  /** 进行中动画的目标 scrollTop（2px 容错守卫，防同目标重启） */
  const scrollAnimTargetRef = useRef<number | null>(null)
  /** 动画令牌：onfinish/oncancel 属主校验（Hydrogen lyricScrollAnimationToken） */
  const scrollAnimTokenRef = useRef(0)
  /** 手动滚动模式：wheel 打断自动跟随，空闲后恢复（非当前行文字 scale 1.05） */
  const [manualMode, setManualMode] = useState(false)
  const manualModeRef = useRef(false)
  const manualTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前 activeIndex 镜像（Hydrogen lycCurrentIndex：sync 内读取，不进依赖） */
  const activeIndexRef = useRef(activeIndex)
  /**
   * 顶部/底部动态留白（Hydrogen lyricTopSpacerHeight/lyricBottomSpacerHeight，
   * CSS transition height 0.3s）：随当前行高与容器尺寸 clamp，
   * 保证当前行总能锚定在可视区内且末行可滚动到位
   */
  const [topSpacer, setTopSpacer] = useState(FOLLOW_TOP_OFFSET_PX)
  const [bottomSpacer, setBottomSpacer] = useState(FOLLOW_BOTTOM_GUTTER_PX)
  /** 切歌（lines 变化）时退出手动模式（render 期调整，替代 effect 内同步 setState） */
  const [prevLines, setPrevLines] = useState(lines)
  if (prevLines !== lines) {
    setPrevLines(lines)
    setManualMode(false)
  }

  /**
   * 当前行锚定偏移 clamp（Hydrogen getLyricFollowTopOffset）：行高超过
   * 容器可视高度 - 24px 边距时收缩锚定偏移，保证行内容仍可见
   */
  const getFollowTopOffset = useCallback(
    (container: HTMLElement, wrapperHeight: number): number => {
      const maxVisibleTop = Math.max(
        0,
        container.clientHeight - wrapperHeight - FOLLOW_VISIBLE_GUTTER_PX
      )
      return Math.min(FOLLOW_TOP_OFFSET_PX, maxVisibleTop)
    },
    []
  )

  /** 更新动态 spacer（Hydrogen updateLyricScrollSpacers 同款） */
  const updateSpacers = useCallback(
    (wrapperHeight = 0) => {
      const container = scrollRef.current
      if (!container) return
      const followTopOffset = getFollowTopOffset(container, wrapperHeight)
      setTopSpacer(followTopOffset)
      setBottomSpacer(
        Math.max(
          FOLLOW_BOTTOM_GUTTER_PX,
          container.clientHeight - followTopOffset - wrapperHeight
        )
      )
    },
    [getFollowTopOffset]
  )

  /**
   * 当前行目标 scrollTop（Hydrogen getLyricContentMetrics）。
   * 关键差异：用 offsetTop 布局测量——它不受内容层 WAAPI transform 影响；
   * getBoundingClientRect 会被进行中的动画位移污染，测出错误目标
   * 导致每次换行"重新定位"卡顿。同时顺带更新动态 spacer
   */
  const getMetrics = useCallback(
    (index: number): { targetScrollTop: number } | null => {
      const container = scrollRef.current
      const content = contentRef.current
      if (!container || !content) return null
      const rows = content.querySelectorAll<HTMLElement>('[data-lyric-row]')
      const row = rows[index]
      if (!row) return null
      const wrapperHeight = row.offsetHeight
      const followTopOffset = getFollowTopOffset(container, wrapperHeight)
      updateSpacers(wrapperHeight)
      const maxScrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
      )
      return {
        targetScrollTop: Math.min(
          maxScrollTop,
          Math.max(0, row.offsetTop - followTopOffset)
        ),
      }
    },
    [getFollowTopOffset, updateSpacers]
  )

  /** 读取内容层当前实际 translateY（含 WAAPI 动画进行中的插值）。
   *  Hydrogen getLyricContentVisualShiftY 同款：优先 DOMMatrix，回退矩阵解析 */
  const getContentShiftY = useCallback((): number => {
    const content = contentRef.current
    if (!content) return 0
    const transform = getComputedStyle(content).transform
    if (!transform || transform === 'none') return 0
    try {
      if (typeof DOMMatrixReadOnly === 'function') {
        return new DOMMatrixReadOnly(transform).m42 || 0
      }
    } catch {
      // fall through
    }
    const m3d = transform.match(/^matrix3d\((.+)\)$/)
    if (m3d) {
      const v = m3d[1].split(',').map((s) => Number(s.trim()))
      return Number.isFinite(v[13]) ? v[13] : 0
    }
    const m = transform.match(/^matrix\((.+)\)$/)
    if (m) {
      const v = m[1].split(',').map((s) => Number(s.trim()))
      return Number.isFinite(v[5]) ? v[5] : 0
    }
    return 0
  }, [])

  /** 取消进行中的补偿动画，preserveVisualPosition 时先把剩余位移固化进
   *  scrollTop（视觉位置不变）；Hydrogen cancelLyricScrollAnimation 同款。
   *  cancel 后同步清除内联 transform 起点（Firefox 首帧保险值，见
   *  animateScrollTo 注释），避免动画失效后残留位移跳变 */
  const cancelScrollAnim = useCallback(
    (preserveVisualPosition: boolean) => {
      const container = scrollRef.current
      const content = contentRef.current
      const prevAnim = scrollAnimRef.current
      if (!prevAnim) return
      if (preserveVisualPosition && container) {
        const shiftY = getContentShiftY()
        if (Math.abs(shiftY) > 0.1) {
          container.scrollTop = Math.max(0, container.scrollTop - shiftY)
        }
      }
      try {
        prevAnim.cancel()
      } catch {
        // ignore：已结束/已取消
      }
      if (content) content.style.transform = ''
      scrollAnimRef.current = null
      scrollAnimTargetRef.current = null
    },
    [getContentShiftY]
  )

  /**
   * 补偿式平滑滚动（Hydrogen animateLyricScrollTop 1:1）：
   * scrollTop 瞬时到位 + 内容层反向位移补偿（580ms 回落）。
   * - 目标容错守卫：进行中动画的目标与新目标差 ≤ 2px 时不重启，
   *   仪式性 setState 风暴下不会反复重启动画
   * - 打断旧动画前固化剩余位移（StrictMode 双执行幂等无跳变）
   * - WAAPI 生命周期挂 token 属主校验，过期回调不误清新动画
   * - Firefox 兼容：动画激活前同步写内联 transform 起点——Firefox 中
   *   布局后创建的 WAAPI 动画其初始关键帧可能下一帧才应用，那一帧
   *   scrollTop 已瞬移而补偿未生效，列表会闪跳一帧；内联样式当帧
   *   生效堵住空窗，动画激活后（Animation origin 优先级高于内联样式）
   *   接管，结束时清除
   */
  const animateScrollTo = useCallback(
    (targetTop: number) => {
      const container = scrollRef.current
      const content = contentRef.current
      if (!container || !content) return

      const normalizedTargetTop = Math.max(0, Number(targetTop) || 0)
      if (
        scrollAnimRef.current !== null &&
        scrollAnimTargetRef.current !== null &&
        Math.abs(scrollAnimTargetRef.current - normalizedTargetTop) <=
          SCROLL_SYNC_TOLERANCE_PX
      ) {
        return
      }

      if (scrollAnimRef.current) {
        cancelScrollAnim(true)
      }

      const delta = normalizedTargetTop - container.scrollTop
      if (Math.abs(delta) <= SCROLL_SYNC_TOLERANCE_PX) {
        scrollAnimTargetRef.current = null
        container.scrollTop = normalizedTargetTop
        return
      }

      const animationToken = ++scrollAnimTokenRef.current
      scrollAnimTargetRef.current = normalizedTargetTop
      // Firefox 首帧保险：先同步写补偿起点再瞬移 scrollTop，
      // 保证同一帧 paint 时补偿 transform 必然生效
      content.style.transform = `translate3d(0, ${delta}px, 0)`
      container.scrollTop = normalizedTargetTop

      try {
        const animation = content.animate(
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
        animation.onfinish = () => {
          if (animationToken !== scrollAnimTokenRef.current) return
          scrollAnimRef.current = null
          scrollAnimTargetRef.current = null
          // 动画结束后 fill both 仍覆盖内联样式，清除保险值保持 DOM 干净
          if (contentRef.current) contentRef.current.style.transform = ''
        }
        animation.oncancel = () => {
          if (animationToken !== scrollAnimTokenRef.current) return
          scrollAnimRef.current = null
          scrollAnimTargetRef.current = null
        }
        scrollAnimRef.current = animation
      } catch {
        // WAAPI 创建失败（极老浏览器）：退化为无动画直接定位
        content.style.transform = ''
        scrollAnimRef.current = null
        scrollAnimTargetRef.current = null
      }
    },
    [cancelScrollAnim]
  )

  /**
   * 滚动位置同步（Hydrogen syncLyricPosition 1:1）：
   * behavior 'smooth' 走补偿动画 / 'auto' 直接定位；force 越过手动模式。
   * 无激活行（-1）时按 force 滚回顶部
   */
  const syncLyricPosition = useCallback(
    ({ behavior = 'auto', force = false } = {}) => {
      const container = scrollRef.current
      if (!container) return
      if (!force && manualModeRef.current) return

      const targetIndex = activeIndexRef.current
      if (targetIndex < 0) {
        updateSpacers()
        if (force) {
          if (behavior === 'smooth') {
            animateScrollTo(0)
          } else {
            cancelScrollAnim(false)
            container.scrollTop = 0
          }
        }
        return
      }

      const metrics = getMetrics(targetIndex)
      if (!metrics) return

      if (
        Math.abs(container.scrollTop - metrics.targetScrollTop) <=
        SCROLL_SYNC_TOLERANCE_PX
      ) {
        if (force && behavior !== 'smooth') {
          cancelScrollAnim(false)
          container.scrollTop = metrics.targetScrollTop
        }
        return
      }

      if (behavior === 'smooth') {
        animateScrollTo(metrics.targetScrollTop)
      } else {
        cancelScrollAnim(false)
        container.scrollTop = metrics.targetScrollTop
      }
    },
    [updateSpacers, getMetrics, animateScrollTo, cancelScrollAnim]
  )

  // activeIndex 变化 → 平滑跟随（Hydrogen currentLyricIndex watcher 同语义：
  // "DOM patch 后立即启动跟随动画，避免多等一帧导致高亮先跳、视图后追"）。
  // useLayoutEffect 在 paint 前同步执行；manualMode 走 ref 不进依赖，
  // 由 syncLyricPosition 内部判定（与 Hydrogen isManualScrollActive 一致）
  useLayoutEffect(() => {
    activeIndexRef.current = activeIndex
    syncLyricPosition({ behavior: 'smooth' })
  }, [activeIndex, syncLyricPosition])

  // 防闪烁揭示完成（revealed false→true）→ 强制 auto 定位一次
  //（Hydrogen setDefaultStyle → syncLyricPosition force auto）
  useLayoutEffect(() => {
    if (!revealed) return
    syncLyricPosition({ behavior: 'auto', force: true })
  }, [revealed, syncLyricPosition])

  // 切歌（lines 变化）时取消进行中的补偿动画并退出手动模式 ref
  //（面板此时处于防闪烁隐藏态，无需视觉固位）
  useEffect(() => {
    manualModeRef.current = false
    cancelScrollAnim(false)
  }, [lines, cancelScrollAnim])

  // manualMode state 变化时同步 ref（timer 回调/sync 内读取用）
  useEffect(() => {
    manualModeRef.current = manualMode
  }, [manualMode])

  // 手动滚动：wheel 固位打断动画 + 进入手动模式，空闲 1s 后强制回到当前行
  //（Hydrogen enterManualScrollMode）
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const handleWheel = () => {
      // 视觉固位取消：用户手动滚动打断动画时不发生列表跳变
      cancelScrollAnim(true)
      manualModeRef.current = true
      setManualMode(true)
      if (manualTimerRef.current) clearTimeout(manualTimerRef.current)
      manualTimerRef.current = setTimeout(() => {
        manualTimerRef.current = null
        manualModeRef.current = false
        setManualMode(false)
        syncLyricPosition({ behavior: 'smooth', force: true })
      }, MANUAL_SCROLL_IDLE_MS)
    }
    container.addEventListener('wheel', handleWheel, { passive: true })
    return () => {
      container.removeEventListener('wheel', handleWheel)
      if (manualTimerRef.current) clearTimeout(manualTimerRef.current)
    }
  }, [syncLyricPosition, cancelScrollAnim])

  // 容器尺寸变化 → rAF 防抖后强制重新测量与定位（Hydrogen
  // ResizeObserver → scheduleLayout → applyLyricLayout auto）
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    let raf = 0
    const scheduleResync = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        syncLyricPosition({ behavior: 'auto', force: true })
      })
    }
    const observer = new ResizeObserver(scheduleResync)
    observer.observe(container)
    return () => {
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [syncLyricPosition])

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
      style={{
        visibility: revealed ? 'visible' : 'hidden',
        // Firefox 滚动锚定防护：溢出锚定会对手动 scrollTop 瞬移 +
        // 内容层 transform 动画做自动补偿，把滚动位置"拉回"造成跳动
        overflowAnchor: 'none',
      }}
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
        <div ref={contentRef} className="lyric-content">
          {/* 顶部动态锚定留白（Hydrogen .lyric-spacer：随当前行高与容器
              尺寸自适应，height 0.3s 过渡） */}
          <div
            className="lyric-spacer"
            style={{ height: topSpacer }}
            aria-hidden="true"
          />
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
          {/* 底部动态留白（Hydrogen .lyric-spacer：保证末行也能锚定到位） */}
          <div
            className="lyric-spacer"
            style={{ height: bottomSpacer }}
            aria-hidden="true"
          />
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
