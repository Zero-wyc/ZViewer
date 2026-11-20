import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 控制栏显隐状态机（从 WatchTogetherCore 抽出）。
 *
 * 桌面端：鼠标移动唤醒，5s 无操作自动隐藏。
 * 移动端：默认隐藏，轻点画面显示，5s 无操作自动隐藏。
 * 点击播放器画面本身（video / canvas）：切换控制栏显隐——可见时点一下立即收起。
 * 全屏评论分屏内的交互（评论区、分隔条）：既不唤醒也不收起控制栏。
 * 开启“隐藏模式”后，点击按钮立即隐藏并进入 2s 冷却，冷却期间任何方式都无法显示，
 * 冷却结束后仅当指针位于播放器底部时才显示（桌面端）/ 触摸即显示（移动端）。
 *
 * 事件挂载在 .zart-stage 容器上；pointerup 绑 window 以保证任意位置松手都计时。
 */
export function useControlBarVisibility({
  stageRef,
  isMobile,
  ignoreSelector,
}: {
  stageRef: React.RefObject<HTMLDivElement | null>
  isMobile: boolean
  /** 落在该选择器内的交互既不唤醒也不收起控制栏（例如全屏评论侧边栏）。 */
  ignoreSelector?: string
}) {
  // 控制栏可见性：移动端默认隐藏（触摸显示），桌面端默认显示
  const [controlBarVisible, setControlBarVisible] = useState(!isMobile)
  const [controlBarHideMode, setControlBarHideMode] = useState(false)
  const controlBarCooldownRef = useRef<number>(0)
  const controlBarIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  // 事件回调里要读到最新可见性（同一次事件里 state 尚未刷新）
  const controlBarVisibleRef = useRef(controlBarVisible)
  controlBarVisibleRef.current = controlBarVisible
  // 最近一次「点画面收起」的时间；之后极短窗口内的 pointermove 不再唤醒，
  // 避免鼠标微抖把刚收起的控制栏又弹出来。
  const lastClickHideAtRef = useRef(0)
  // 本次触摸是否起始于播放器内部：播放器外（如评论侧边栏）的触摸不应刷新
  // 控制栏的隐藏计时。
  const stagePointerActiveRef = useRef(false)

  // ── 控制栏显隐逻辑 ────────────────────────────────────
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const BOTTOM_HEIGHT = 80
    // 无操作 5s 自动收起（桌面 / 移动一致）
    const HIDE_DELAY = 5000
    // 点击画面收起后，pointermove 唤醒的抑制窗口
    const CLICK_HIDE_SUPPRESS_MS = 250

    const isIgnored = (target: EventTarget | null) =>
      Boolean(
        ignoreSelector &&
          target instanceof Element &&
          target.closest(ignoreSelector)
      )

    /** 目标是否播放器画面本身（点它 = 切换控制栏显隐） */
    const isPlayerSurface = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest('video, canvas'))

    const setVisible = (next: boolean) => {
      controlBarVisibleRef.current = next
      setControlBarVisible(next)
    }

    const clearIdleTimer = () => {
      if (controlBarIdleTimerRef.current) {
        clearTimeout(controlBarIdleTimerRef.current)
        controlBarIdleTimerRef.current = null
      }
    }

    const scheduleIdleHide = () => {
      clearIdleTimer()
      controlBarIdleTimerRef.current = setTimeout(() => {
        setVisible(false)
      }, HIDE_DELAY)
    }

    /** 立即收起控制栏，并记录时间用于抑制随后的 pointermove 唤醒 */
    const hideNow = () => {
      clearIdleTimer()
      setVisible(false)
      lastClickHideAtRef.current = Date.now()
    }

    const handlePointerMove = (e: PointerEvent) => {
      if (isIgnored(e.target)) {
        // 评论分屏内：不收起也不唤醒控制栏（静默忽略）
        stagePointerActiveRef.current = false
        return
      }
      if (controlBarHideMode) {
        const now = Date.now()
        if (now < controlBarCooldownRef.current) {
          // 冷却期间无视任何显示请求
          scheduleIdleHide()
          return
        }
        const rect = stage.getBoundingClientRect()
        const inBottom = e.clientY >= rect.bottom - BOTTOM_HEIGHT
        setVisible(inBottom)
        scheduleIdleHide()
        return
      }
      if (
        !controlBarVisibleRef.current &&
        Date.now() - lastClickHideAtRef.current < CLICK_HIDE_SUPPRESS_MS
      ) {
        // 刚点画面收起，忽略紧随其后的轻微移动
        return
      }
      setVisible(true)
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
      setVisible(false)
      clearIdleTimer()
    }

    const handlePointerDown = (e: PointerEvent) => {
      if (isIgnored(e.target)) {
        stagePointerActiveRef.current = false
        return
      }
      stagePointerActiveRef.current = true
      if (controlBarHideMode) {
        setVisible(true)
        handlePointerMove(e)
        return
      }
      // 点播放器画面：切换控制栏显隐（可见 → 立即收起）
      if (isPlayerSurface(e.target)) {
        if (controlBarVisibleRef.current) {
          hideNow()
          return
        }
        setVisible(true)
        if (e.pointerType === 'touch') {
          // 触摸按住期间保持可见，松开（pointerup）后再计时
          clearIdleTimer()
        } else {
          scheduleIdleHide()
        }
        return
      }
      // 控制栏 / 设置面板等交互区域：保持可见
      setVisible(true)
      if (e.pointerType === 'touch') {
        clearIdleTimer()
        return
      }
      scheduleIdleHide()
    }

    const handlePointerUp = (e: PointerEvent) => {
      // 触摸松开：只有从播放器内开始的触摸才刷新 5s 隐藏倒计时
      if (e.pointerType === 'touch') {
        const startedInStage = stagePointerActiveRef.current
        stagePointerActiveRef.current = false
        if (
          !controlBarHideMode &&
          startedInStage &&
          controlBarVisibleRef.current
        ) {
          scheduleIdleHide()
        }
      }
    }

    // ── touch 事件兜底（旧设备 / 不支持 PointerEvent 的浏览器）────
    // 支持 PointerEvent 的浏览器里不能再处理 touch：一次轻点会先派发
    // touchstart 再派发 pointerdown，两边都判定会把控制栏状态翻转两次。
    const pointerEventsSupported =
      typeof window !== 'undefined' && 'PointerEvent' in window

    const handleTouchStart = (e: TouchEvent) => {
      if (pointerEventsSupported) return
      if (isIgnored(e.target)) {
        stagePointerActiveRef.current = false
        return
      }
      stagePointerActiveRef.current = true
      if (controlBarHideMode) {
        setVisible(true)
        clearIdleTimer()
        return
      }
      if (isPlayerSurface(e.target)) {
        if (controlBarVisibleRef.current) {
          hideNow()
          return
        }
        setVisible(true)
        clearIdleTimer()
        return
      }
      setVisible(true)
      clearIdleTimer()
    }
    const handleTouchMove = (e: TouchEvent) => {
      if (pointerEventsSupported) return
      if (isIgnored(e.target)) {
        stagePointerActiveRef.current = false
        return
      }
      // 触摸滑动：手指按住期间一直显示，不启动隐藏计时
      setVisible(true)
      if (!controlBarHideMode) {
        clearIdleTimer()
      }
    }
    const handleTouchEnd = () => {
      if (pointerEventsSupported) return
      const startedInStage = stagePointerActiveRef.current
      stagePointerActiveRef.current = false
      // 触摸松开：只有播放器内的触摸才开始 5s 隐藏倒计时
      if (
        !controlBarHideMode &&
        startedInStage &&
        controlBarVisibleRef.current
      ) {
        scheduleIdleHide()
      }
    }

    // 播放器以外区域按下/触摸：不唤醒控制栏，只保证空闲隐藏计时仍在进行；
    // 已有计时时不重置，避免连续操作评论区把控制栏一直续命。
    const handleDocumentPointerDown = (e: PointerEvent) => {
      const stageEl = stageRef.current
      if (!stageEl) return
      if (e.target instanceof Node && stageEl.contains(e.target)) return
      stagePointerActiveRef.current = false
      if (!controlBarIdleTimerRef.current) scheduleIdleHide()
    }

    stage.addEventListener('pointermove', handlePointerMove)
    stage.addEventListener('pointerleave', handlePointerLeave)
    // 捕获阶段：视频内部可能 stopPropagation，冒泡阶段收不到触摸事件。
    stage.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerdown', handleDocumentPointerDown, true)
    // pointerup 绑到 window：确保手指在任意位置松开都能触发隐藏计时
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    // touch 兜底
    stage.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true })
    stage.addEventListener('touchmove', handleTouchMove, { passive: true })
    stage.addEventListener('touchend', handleTouchEnd, { passive: true })
    stage.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    if (!isMobile) {
      // 桌面端：初始默认显示，随后按空闲逻辑自动隐藏
      scheduleIdleHide()
    }
    // 移动端：初始已隐藏（见 useState 初始值），触摸屏幕时显示并 5s 后自动隐藏

    return () => {
      stage.removeEventListener('pointermove', handlePointerMove)
      stage.removeEventListener('pointerleave', handlePointerLeave)
      stage.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      stage.removeEventListener('touchstart', handleTouchStart, { capture: true })
      stage.removeEventListener('touchmove', handleTouchMove)
      stage.removeEventListener('touchend', handleTouchEnd)
      stage.removeEventListener('touchcancel', handleTouchEnd)
      clearIdleTimer()
    }
  }, [stageRef, controlBarHideMode, isMobile, ignoreSelector])

  const handleToggleHideMode = useCallback(() => {
    setControlBarHideMode((prev) => {
      const next = !prev
      if (next) {
        controlBarVisibleRef.current = false
        setControlBarVisible(false)
        controlBarCooldownRef.current = Date.now() + 2000
      } else {
        controlBarVisibleRef.current = true
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
