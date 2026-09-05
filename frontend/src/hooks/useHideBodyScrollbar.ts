import { useEffect } from 'react'

/**
 * 页面挂载期间隐藏浏览器最右侧的 body 滚动条。
 *
 * 仅视觉隐藏（复用 index.css 的 .hide-scrollbar），
 * 滚轮 / 触控板 / 键盘滚动不受影响。
 */
export function useHideBodyScrollbar() {
  useEffect(() => {
    // 页面主滚动条挂在 html（documentElement）上，body 上的 overflow
    // 样式在多数布局下不起作用——两个根元素都加类才可靠。
    document.documentElement.classList.add('hide-scrollbar')
    document.body.classList.add('hide-scrollbar')
    return () => {
      document.documentElement.classList.remove('hide-scrollbar')
      document.body.classList.remove('hide-scrollbar')
    }
  }, [])
}
