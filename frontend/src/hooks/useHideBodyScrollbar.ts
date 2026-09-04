import { useEffect } from 'react'

/**
 * 页面挂载期间隐藏浏览器最右侧的 body 滚动条。
 *
 * 仅视觉隐藏（复用 index.css 的 .hide-scrollbar），
 * 滚轮 / 触控板 / 键盘滚动不受影响。
 */
export function useHideBodyScrollbar() {
  useEffect(() => {
    document.body.classList.add('hide-scrollbar')
    return () => {
      document.body.classList.remove('hide-scrollbar')
    }
  }, [])
}
