/**
 * 悬浮工具栏限高滚动（横屏矮窗口 / 矮桌面窗口）。
 *
 * song-control 图标数量随歌曲能力增减（B站源/弹幕/收藏/评论…最多 17 枚），
 * 内容高度超出容器时把工具栏压回范围内并开放上下滑动（hide-scrollbar 不显
 * 滚动条）。布局侧只需常挂 `max-h-full`：只在超出时约束盒子，内容自然溢出
 * 不裁剪，同时作为 scrollHeight > clientHeight 的测量依据。
 *
 * 注意：overflow 裁剪会连同 x 轴一起生效，侧挂弹窗（播放队列 side placement）
 * 会被栏体裁掉——因此仅在滚动激活时才开放 overflow，并把弹窗切换为 sheet
 * （fixed 底部弹出，不受祖先 overflow 裁剪影响）。桌面高窗口内容放得下，
 * 两态均不触发，视觉与交互零变化。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

export function useToolbarScrollable() {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [scrollable, setScrollable] = useState(false)

  const measure = useCallback(() => {
    const el = toolbarRef.current
    if (!el) return
    setScrollable(el.scrollHeight > el.clientHeight + 1)
  }, [])

  // 每次渲染后复测：条件图标（喜欢/弹幕/收藏/评论…）增减会改变内容高度
  useLayoutEffect(measure)
  // 视口尺寸变化（gap/图标尺寸含 vh 项）同样改变内容高度
  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // 滚动激活时初始定位到栏底：底挂工具栏溢出方向向上，保持用户原本
  // 看到的底部图标（收起/全屏/设置）不动，向上滑动揭示被裁的顶部图标
  useEffect(() => {
    if (!scrollable) return
    const el = toolbarRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scrollable])

  return { toolbarRef, scrollable }
}
