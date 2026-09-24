/**
 * 页面全屏切换。
 *
 * 对文档根节点请求全屏（播放页打开时即播放页全屏），并监听 fullscreenchange
 * 同步图标状态——Esc 等浏览器侧退出路径同样要跟随。
 *
 * iOS iPhone Safari 不支持元素全屏：静默失败不弹错。
 */
import { useCallback, useEffect, useState } from 'react'

export function useFullscreenToggle() {
  const [isFullscreen, setIsFullscreen] = useState(
    () => document.fullscreenElement != null
  )

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement != null)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {})
    } else {
      // iOS iPhone Safari 不支持元素全屏：静默失败不弹错
      void document.documentElement.requestFullscreen().catch(() => {})
    }
  }, [])

  return { isFullscreen, toggle }
}
