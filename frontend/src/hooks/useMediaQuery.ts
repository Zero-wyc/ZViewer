/**
 * 媒体查询订阅 hooks（一起听模块移动端响应式的统一入口）。
 *
 * - useMediaQuery：底层 matchMedia 订阅（SSR 安全：无 window 时恒 false）；
 *   变更监听用现代 addEventListener API，旧浏览器回退 addListener。
 * - useIsMobile：窄屏（手机竖屏 / 小窗）判定，阈值与 Tailwind max-md 一致
 *   （767.98px），用于需要条件渲染（而非纯 CSS）的布局分支。
 * - useIsTouch：粗指针（触屏）判定，用于 hover 依赖交互的触屏兜底。
 * - useIsPortraitMobile：手机竖屏组合判定（完整播放器单列布局的开关）。
 */
import { useEffect, useState } from 'react'

/** 订阅一条媒体查询（返回当前是否命中） */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const update = () => setMatches(mql.matches)
    update()
    // 现代 API 优先（旧 Safari/Edge 回退 addListener/removeListener）
    if (mql.addEventListener) {
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }
    mql.addListener(update)
    return () => mql.removeListener(update)
  }, [query])

  return matches
}

/** 窄屏判定（手机竖屏 / 桌面窄窗口）；阈值 = Tailwind max-md 767.98px */
export const MOBILE_QUERY = '(max-width: 767.98px)'

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY)
}

/** 触屏（粗指针）判定：hover 依赖交互的兜底开关 */
export const TOUCH_QUERY = '(pointer: coarse)'

export function useIsTouch(): boolean {
  return useMediaQuery(TOUCH_QUERY)
}

/** 手机竖屏（窄屏 + 竖向）：完整播放器切换上下单列布局 */
export const PORTRAIT_MOBILE_QUERY =
  '(max-width: 767.98px) and (orientation: portrait)'

export function useIsPortraitMobile(): boolean {
  return useMediaQuery(PORTRAIT_MOBILE_QUERY)
}
