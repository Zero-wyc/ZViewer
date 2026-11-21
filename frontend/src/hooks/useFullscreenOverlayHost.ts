import { useEffect } from 'react'
import { useFullscreenOverlayStore } from '@/store/fullscreenOverlayStore'

export interface UseFullscreenOverlayHostOptions {
  /** 宿主标识（同一时刻只有一个宿主生效） */
  owner: string
  /** 全屏舞台元素（浮层的 portal 目标） */
  stageRef: React.RefObject<HTMLElement | null>
  /** 是否处于全屏（原生全屏或网页全屏） */
  active: boolean
  /** 控制栏是否可见：浮层与之同步显隐 */
  controlBarVisible: boolean
  /**
   * 全屏控制栏的容器元素：用来实测控制栏高度并写进浮层 store。
   * 浮层需要抬到控制栏上方，而控制栏在窄屏下会因按钮换行变高（80px → ~110px），
   * 静态偏移挡不住，必须按实测值定位。
   */
  barRef?: React.RefObject<HTMLElement | null>
}

/**
 * 把播放器舞台注册为全屏浮层宿主。
 *
 * 退出全屏（或卸载）时自动注销，浮层回到 document.body 上的常规位置。
 */
export function useFullscreenOverlayHost({
  owner,
  stageRef,
  active,
  controlBarVisible,
  barRef,
}: UseFullscreenOverlayHostOptions): void {
  const publish = useFullscreenOverlayStore((s) => s.publish)
  const clear = useFullscreenOverlayStore((s) => s.clear)
  const setControlBarVisible = useFullscreenOverlayStore(
    (s) => s.setControlBarVisible
  )
  const setControlBarHeight = useFullscreenOverlayStore(
    (s) => s.setControlBarHeight
  )

  useEffect(() => {
    if (!active) {
      clear(owner)
      return undefined
    }
    publish(owner, stageRef.current)
    return () => clear(owner)
  }, [active, owner, publish, clear, stageRef])

  useEffect(() => {
    if (active) setControlBarVisible(controlBarVisible)
  }, [active, controlBarVisible, setControlBarVisible])

  // 实测控制栏高度：控制栏只在有视频源时才渲染，且高度随视口宽度变化
  // （窄屏按钮换行），所以既要用 ResizeObserver 跟随时时变化，也要轮询等待
  // 控制栏元素出现（源加载完成才挂载）。退出全屏时归零，浮层恢复常规定位。
  useEffect(() => {
    if (!active) {
      setControlBarHeight(0)
      return undefined
    }
    const measure = () => {
      const el = barRef?.current ?? null
      setControlBarHeight(el ? el.getBoundingClientRect().height : 0)
    }
    measure()
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    let observed: HTMLElement | null = null
    const timer = window.setInterval(() => {
      const el = barRef?.current ?? null
      if (el !== observed) {
        observer?.disconnect()
        if (el) observer?.observe(el)
        observed = el
        measure()
      }
    }, 300)
    return () => {
      window.clearInterval(timer)
      observer?.disconnect()
      setControlBarHeight(0)
    }
  }, [active, barRef, setControlBarHeight])
}
