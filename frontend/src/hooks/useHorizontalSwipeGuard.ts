/**
 * 横向滑动守卫。
 *
 * 背景：部分移动端浏览器（自带「网页视频手势」的浏览器）以及装了手势类扩展的
 * 桌面浏览器，会把页面上的左右滑动当成「快进 / 快退」。全屏分屏的评论区要靠
 * 上下滑动翻评论，手指只要有点左右偏移就会触发播放器手势，评论列表因此滑不动。
 *
 * 做法：在评论容器上以捕获阶段监听触摸手势——
 * 1. 记录手势起点；
 * 2. 移动超过阈值后判定方向：纵向优先放行（评论区照常滚动）；
 *    横向则 preventDefault + stopPropagation，把这次手势留在评论区里，
 *    浏览器 / 扩展的「滑动快进」拿不到默认行为与冒泡事件；
 * 3. touchend / touchcancel 复位。
 *
 * 与容器上的 `touch-action: pan-y` 配合：合成器阶段也会把横向滑动当成
 * 「页面不处理」，进一步降低误判为播放器手势的概率。
 */
import { useEffect, type RefObject } from 'react'

/** 判定方向前允许的手指抖动（px） */
const DIRECTION_THRESHOLD_PX = 8
/** 横向判定系数：横向位移要明显大于纵向位移才算横滑 */
const HORIZONTAL_RATIO = 1.2

export function useHorizontalSwipeGuard<T extends HTMLElement>(
  ref: RefObject<T | null>,
  enabled = true
): void {
  useEffect(() => {
    const element = ref.current
    if (!element || !enabled) return undefined

    let tracking = false
    let horizontal = false
    let startX = 0
    let startY = 0

    const reset = () => {
      tracking = false
      horizontal = false
    }

    const handleTouchStart = (event: TouchEvent) => {
      // 多指手势（缩放等）不拦，避免影响页面其他能力
      if (event.touches.length !== 1) {
        reset()
        return
      }
      const touch = event.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      tracking = true
      horizontal = false
    }

    const handleTouchMove = (event: TouchEvent) => {
      if (!tracking) return
      const touch = event.touches[0]
      if (!touch) return
      const deltaX = touch.clientX - startX
      const deltaY = touch.clientY - startY
      if (!horizontal) {
        if (
          Math.abs(deltaX) < DIRECTION_THRESHOLD_PX &&
          Math.abs(deltaY) < DIRECTION_THRESHOLD_PX
        ) {
          return
        }
        if (Math.abs(deltaX) <= Math.abs(deltaY) * HORIZONTAL_RATIO) {
          // 判定为纵向滑动：交还给评论区自己滚动
          reset()
          return
        }
        horizontal = true
      }
      // 横向滑动：拦住默认行为与冒泡，浏览器 / 扩展的「滑动快进」收不到
      if (event.cancelable) event.preventDefault()
      event.stopPropagation()
    }

    // touchstart 用 passive 监听：起点只需要读坐标，不拦。
    // touchmove 必须 passive: false，否则 preventDefault 会被浏览器忽略。
    element.addEventListener('touchstart', handleTouchStart, {
      capture: true,
      passive: true,
    })
    element.addEventListener('touchmove', handleTouchMove, {
      capture: true,
      passive: false,
    })
    element.addEventListener('touchend', reset, true)
    element.addEventListener('touchcancel', reset, true)
    return () => {
      element.removeEventListener('touchstart', handleTouchStart, true)
      element.removeEventListener('touchmove', handleTouchMove, true)
      element.removeEventListener('touchend', reset, true)
      element.removeEventListener('touchcancel', reset, true)
    }
  }, [ref, enabled])
}
