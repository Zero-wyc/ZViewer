import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 控制栏显隐状态机（从 WatchTogetherCore 抽出，纯搬迁）。
 *
 * 桌面端：鼠标 2s 内无移动即自动隐藏，暂停时不强制显示。
 * 移动端：默认隐藏，手指触摸屏幕时显示，3s 后自动隐藏。
 * 开启“隐藏模式”后，点击按钮立即隐藏并进入 2s 冷却，冷却期间任何方式都无法显示，
 * 冷却结束后仅当指针位于播放器底部时才显示（桌面端）/ 触摸即显示（移动端）。
 *
 * 事件挂载在 .zart-stage 容器上；pointerup 绑 window 以保证任意位置松手都计时。
 */
export function useControlBarVisibility({
  stageRef,
  isMobile,
}: {
  stageRef: React.RefObject<HTMLDivElement | null>
  isMobile: boolean
}) {
  // 控制栏可见性：移动端默认隐藏（触摸显示），桌面端默认显示
  const [controlBarVisible, setControlBarVisible] = useState(!isMobile)
  const [controlBarHideMode, setControlBarHideMode] = useState(false)
  const controlBarCooldownRef = useRef<number>(0)
  const controlBarIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  // ── 控制栏显隐逻辑 ────────────────────────────────────
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const BOTTOM_HEIGHT = 80
    // 移动端触摸显示后 3s 自动隐藏；桌面端鼠标空闲 2s 自动隐藏
    const HIDE_DELAY = isMobile ? 3000 : 2000

    const clearIdleTimer = () => {
      if (controlBarIdleTimerRef.current) {
        clearTimeout(controlBarIdleTimerRef.current)
        controlBarIdleTimerRef.current = null
      }
    }

    const scheduleIdleHide = () => {
      clearIdleTimer()
      controlBarIdleTimerRef.current = setTimeout(() => {
        setControlBarVisible(false)
      }, HIDE_DELAY)
    }

    const handlePointerMove = (e: PointerEvent) => {
      if (controlBarHideMode) {
        const now = Date.now()
        if (now < controlBarCooldownRef.current) {
          // 冷却期间无视任何显示请求
          scheduleIdleHide()
          return
        }
        const rect = stage.getBoundingClientRect()
        const inBottom = e.clientY >= rect.bottom - BOTTOM_HEIGHT
        setControlBarVisible(inBottom)
        scheduleIdleHide()
        return
      }
      setControlBarVisible(true)
      // 触摸滑动：手指按住期间一直显示，不启动隐藏计时，松开后再计时
      if (e.pointerType === 'touch') {
        clearIdleTimer()
        return
      }
      scheduleIdleHide()
    }

    const handlePointerLeave = (e: PointerEvent) => {
      // 触摸场景不因 pointerleave 隐藏：触摸的显隐由 pointerup / touch 事件控制
      // （部分浏览器触摸时会派发 pointerleave，若在此隐藏会导致控制栏刚显示就消失）
      if (e.pointerType === 'touch') return
      setControlBarVisible(false)
      clearIdleTimer()
    }

    const handlePointerDown = (e: PointerEvent) => {
      setControlBarVisible(true)
      // 移动端触摸：按住期间一直显示，松开（pointerup）后再计时隐藏
      if (e.pointerType === 'touch' && !controlBarHideMode) {
        clearIdleTimer()
        return
      }
      handlePointerMove(e)
    }

    const handlePointerUp = (e: PointerEvent) => {
      // 触摸松开：开始 3s 隐藏倒计时
      if (e.pointerType === 'touch' && !controlBarHideMode) {
        scheduleIdleHide()
      }
    }

    // ── touch 事件兜底（旧设备 / 不支持 PointerEvent 的浏览器）────
    const handleTouchStart = () => {
      setControlBarVisible(true)
      if (!controlBarHideMode) {
        clearIdleTimer()
      }
    }
    const handleTouchMove = () => {
      // 触摸滑动：手指按住期间一直显示，不启动隐藏计时
      setControlBarVisible(true)
      if (!controlBarHideMode) {
        clearIdleTimer()
      }
    }
    const handleTouchEnd = () => {
      // 触摸松开：开始 3s 隐藏倒计时
      if (!controlBarHideMode) {
        scheduleIdleHide()
      }
    }

    stage.addEventListener('pointermove', handlePointerMove)
    stage.addEventListener('pointerleave', handlePointerLeave)
    stage.addEventListener('pointerdown', handlePointerDown)
    // pointerup 绑到 window：确保手指在任意位置松开都能触发隐藏计时
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    // touch 兜底
    stage.addEventListener('touchstart', handleTouchStart, { passive: true })
    stage.addEventListener('touchmove', handleTouchMove, { passive: true })
    stage.addEventListener('touchend', handleTouchEnd, { passive: true })
    stage.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    if (!isMobile) {
      // 桌面端：初始默认显示，随后按空闲逻辑自动隐藏
      scheduleIdleHide()
    }
    // 移动端：初始已隐藏（见 useState 初始值），触摸屏幕时显示并 3s 后自动隐藏

    return () => {
      stage.removeEventListener('pointermove', handlePointerMove)
      stage.removeEventListener('pointerleave', handlePointerLeave)
      stage.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      stage.removeEventListener('touchstart', handleTouchStart)
      stage.removeEventListener('touchmove', handleTouchMove)
      stage.removeEventListener('touchend', handleTouchEnd)
      stage.removeEventListener('touchcancel', handleTouchEnd)
      clearIdleTimer()
    }
  }, [stageRef, controlBarHideMode, isMobile])

  const handleToggleHideMode = useCallback(() => {
    setControlBarHideMode((prev) => {
      const next = !prev
      if (next) {
        setControlBarVisible(false)
        controlBarCooldownRef.current = Date.now() + 2000
      } else {
        setControlBarVisible(true)
        controlBarCooldownRef.current = 0
      }
      return next
    })
  }, [])

  return {
    controlBarVisible,
    /** 隐藏模式开关状态（控制栏按钮视觉态用） */
    controlBarHideMode,
    /** 隐藏模式开关（控制栏按钮触发；开启即隐藏并进入 2s 冷却） */
    handleToggleHideMode,
  }
}
