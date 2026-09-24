/**
 * 手机横屏 song-control 工具栏显隐：默认隐藏，触摸屏幕任意处亮起 3s。
 *
 * 触屏无 hover，原 lt-touch-visible 常显会让工具栏常驻压在歌词面板上
 * （收起按钮与歌词文本重叠）；桌面矮窗口命中 isLandscapeShort 时仍走
 * group-hover 分支，不受本 state 影响。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export function useLandscapeToolbarFlash(isLandscapeShort: boolean) {
  const [landscapeToolbarVisible, setLandscapeToolbarVisible] = useState(false)
  const landscapeToolbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const flashLandscapeToolbar = useCallback(() => {
    if (!isLandscapeShort) return
    setLandscapeToolbarVisible(true)
    if (landscapeToolbarTimerRef.current)
      clearTimeout(landscapeToolbarTimerRef.current)
    landscapeToolbarTimerRef.current = setTimeout(
      () => setLandscapeToolbarVisible(false),
      3000
    )
  }, [isLandscapeShort])
  // 离开横屏（转竖屏/桌面）时复位显隐态（渲染期 prop-change 模式）
  const [prevLandscapeShort, setPrevLandscapeShort] = useState(isLandscapeShort)
  if (prevLandscapeShort !== isLandscapeShort) {
    setPrevLandscapeShort(isLandscapeShort)
    if (!isLandscapeShort) setLandscapeToolbarVisible(false)
  }
  useEffect(() => {
    return () => {
      if (landscapeToolbarTimerRef.current)
        clearTimeout(landscapeToolbarTimerRef.current)
    }
  }, [])
  return { landscapeToolbarVisible, flashLandscapeToolbar }
}
