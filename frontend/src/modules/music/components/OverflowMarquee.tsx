/**
 * 溢出跑马灯（Hydrogen base/OverflowMarquee.vue 的 React 复刻）。
 *
 * 规格（与 Hydrogen 一致）：
 * - 文本溢出容器超过 8px 阈值才滚动，否则静态显示
 * - 滚动速度 42px/s，循环间隔 36px（内容为「文本 + 36px 空隙」的循环体，
 *   渲染两份文本拼接实现无缝循环），启动延迟 900ms
 * - 布局就绪后双帧测量（rAF 两跳），文本变化时重新测量并重启动画
 */
import { useEffect, useRef, useState } from 'react'

/** 溢出阈值（px）：超出该值才启动滚动 */
const OVERFLOW_THRESHOLD_PX = 8
/** 滚动速度（px/s） */
const SPEED_PX_PER_SEC = 42
/** 循环体间隙（px） */
const LOOP_GAP_PX = 36
/** 启动延迟（ms） */
const START_DELAY_MS = 900

export function OverflowMarquee({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  /** 是否溢出（决定是否滚动） */
  const [overflowing, setOverflowing] = useState(false)
  /** 动画代次：文本变化 / 溢出状态变化时 +1，用于重启动画 */
  const [runId, setRunId] = useState(0)

  // 双帧测量溢出：字体/宽度就绪后再判定，避免首帧误判
  useEffect(() => {
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const wrap = wrapRef.current
        const inner = innerRef.current
        if (!wrap || !inner) return
        // inner = 文本A + 36px 间隙 + 文本B，单份文本宽度 = (总宽 - 间隙) / 2
        const textWidth = (inner.scrollWidth - LOOP_GAP_PX) / 2
        const isOverflow = textWidth - wrap.clientWidth > OVERFLOW_THRESHOLD_PX
        setOverflowing(isOverflow)
        setRunId((n) => n + 1)
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [text])

  // WAAPI 循环滚动：translateX(0 → -(半宽 + gap))，linear 匀速
  useEffect(() => {
    if (!overflowing) return
    const inner = innerRef.current
    if (!inner) return
    const distance = inner.scrollWidth / 2 + LOOP_GAP_PX / 2
    if (distance <= 0) return
    const anim = inner.animate(
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(-${distance}px)` },
      ],
      {
        duration: (distance / SPEED_PX_PER_SEC) * 1000,
        delay: START_DELAY_MS,
        easing: 'linear',
        iterations: Infinity,
      }
    )
    return () => anim.cancel()
  }, [overflowing, runId])

  return (
    <div
      ref={wrapRef}
      className={`relative min-w-0 overflow-hidden ${className ?? ''}`}
    >
      <div
        ref={innerRef}
        className="flex w-max items-center whitespace-nowrap will-change-transform"
      >
        <span className="block">{text}</span>
        {/* 循环体间隙 + 第二份文本（无缝循环用，视觉上首尾相接）。
            未溢出时保持占位但不可见（visibility 不影响 scrollWidth 测量），
            否则短文本时第二份会进入可视区，出现「歌名重复显示」 */}
        <span
          className="block"
          style={{
            width: LOOP_GAP_PX,
            visibility: overflowing ? 'visible' : 'hidden',
          }}
          aria-hidden="true"
        />
        <span
          className="block"
          style={{ visibility: overflowing ? 'visible' : 'hidden' }}
          aria-hidden="true"
        >
          {text}
        </span>
      </div>
    </div>
  )
}
