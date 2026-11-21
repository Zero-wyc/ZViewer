/**
 * useControlBarAutoHide —— 控制栏自动隐藏 Hook。
 *
 * 逻辑仿照一起看播放器的控制栏显隐行为：
 * - 桌面端：控制栏默认显示，鼠标移动唤醒，5s 内无移动自动隐藏。
 * - 移动端：控制栏默认隐藏，轻点画面显示，松手 5s 后自动隐藏。
 * - 点击播放器画面本身（video / canvas）：切换控制栏显隐——可见时点一下立即收起。
 * - 鼠标离开播放区域时立即隐藏（桌面端）。
 *
 * 交互判定（全屏分屏评论区场景）：调用方通过 resolveInteraction 把某次交互
 * 标记为 quiet（例如落在评论区里：既不唤醒也不收起控制栏）、swallow（分屏打开
 * 时点画面：收起控制栏并回调 onBlockedInteraction，供「只关评论区」使用）或
 * toggle（点播放器画面：切换控制栏显隐）。
 *
 * 使用方式：
 *   const stageRef = useRef<HTMLDivElement>(null)
 *   const controlBarVisible = useControlBarAutoHide(stageRef)
 *   // 根据 controlBarVisible 控制 UI 显隐
 */
import { useEffect, useRef, useState } from 'react'

export type ControlBarInteraction =
  'normal' | 'quiet' | 'ignore' | 'swallow' | 'toggle'

/**
 * 交互类型：
 * - move：鼠标/指针移动（悬停），只在桌面端有效
 * - down：按下 / 触摸开始
 * 悬停与按下的语义完全不同——悬停绝不能触发「关闭分屏」这类带副作用的动作，
 * 否则鼠标从画面上一划而过就把评论区收掉了。
 */
export type ControlBarInteractionKind = 'move' | 'down'

export interface UseControlBarAutoHideOptions {
  /** 桌面端自动隐藏延迟 (ms)，默认 5000 */
  desktopDelay?: number
  /** 移动端自动隐藏延迟 (ms)，默认 5000 */
  mobileDelay?: number
  /** 是否禁用自动隐藏（始终显示），默认 false */
  disabled?: boolean
  /**
   * 判定一次交互的性质：
   * - normal：正常唤醒控制栏（默认）
   * - quiet：不唤醒、也不收起控制栏（例如点/划过评论区）
   * - ignore：不唤醒、收起控制栏（保留旧语义）
   * - swallow：不唤醒、收起控制栏，并回调 onBlockedInteraction
   * - toggle：切换控制栏显隐（点播放器画面本身）
   */
  resolveInteraction?: (
    target: EventTarget | null,
    kind: ControlBarInteractionKind
  ) => ControlBarInteraction
  /** 判定为 swallow 的按下/触摸时回调（例如只关闭分屏评论区） */
  onBlockedInteraction?: () => void
}

export function useControlBarAutoHide(
  stageRef: React.RefObject<HTMLElement | null>,
  options: UseControlBarAutoHideOptions = {}
): boolean {
  const {
    desktopDelay = 5000,
    mobileDelay = 5000,
    disabled = false,
    resolveInteraction,
    onBlockedInteraction,
  } = options

  // 移动端检测（与一起看播放器一致）
  const [isMobile] = useState(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia('(pointer: coarse)').matches ||
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
  )

  // 控制栏可见性：移动端默认隐藏，桌面端默认显示
  const [controlBarVisible, setControlBarVisible] = useState(!isMobile)
  // effect 重跑（例如分屏开关导致 resolveInteraction 变化）时用来判断
  // 当前是否仍有可见的控制栏需要重新挂上隐藏计时；事件回调里也要读最新值。
  const controlBarVisibleRef = useRef(controlBarVisible)
  // 渲染期同步：事件回调与其它 effect 里读到的必须是最新可见性
  // eslint-disable-next-line react-hooks/refs -- 同上，事件里同步读取需要最新值
  controlBarVisibleRef.current = controlBarVisible
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 最近一次「点画面收起」的时间；之后极短窗口内的 pointermove 不再唤醒，
  // 避免鼠标微抖把刚收起的控制栏又弹出来。
  const lastClickHideAtRef = useRef(0)
  // 最近一次交互是否被豁免（松手后不要重新显示/重新计时）
  const blockedRef = useRef(false)
  // 本次触摸是否起始于播放器内部：只有播放器内的触摸松手后才开始隐藏计时，
  // 触摸评论区等播放器以外的区域不应刷新控制栏的存活时间。
  const stagePointerActiveRef = useRef(false)
  // 判定回调走 ref：调用方常常内联箭头函数（每次渲染都是新引用），若把它放进
  // effect 依赖，播放状态/统计等高频更新会不停重启 effect，把空闲隐藏计时器
  // 一起清掉——控制栏就永远收不起来（WebRTC 观众端曾因此一直常显）。
  const resolveInteractionRef = useRef(resolveInteraction)
  const onBlockedInteractionRef = useRef(onBlockedInteraction)
  // eslint-disable-next-line react-hooks/refs -- 事件回调里始终要读最新的判定逻辑
  resolveInteractionRef.current = resolveInteraction
  // eslint-disable-next-line react-hooks/refs -- 同上
  onBlockedInteractionRef.current = onBlockedInteraction

  useEffect(() => {
    /** 同时更新 state 与 ref：同一次事件里后续逻辑要读到最新可见性 */
    const setVisible = (next: boolean) => {
      controlBarVisibleRef.current = next
      setControlBarVisible(next)
    }

    if (disabled) {
      setVisible(true)
      return
    }

    const stage = stageRef.current
    if (!stage) return

    const HIDE_DELAY = isMobile ? mobileDelay : desktopDelay
    // 点击画面收起后，pointermove 唤醒的抑制窗口
    const CLICK_HIDE_SUPPRESS_MS = 250

    const clearIdleTimer = () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }

    const scheduleIdleHide = () => {
      clearIdleTimer()
      idleTimerRef.current = setTimeout(() => {
        setVisible(false)
      }, HIDE_DELAY)
    }

    /** 立即收起控制栏，并记录时间用于抑制随后的 pointermove 唤醒 */
    const hideNow = () => {
      clearIdleTimer()
      setVisible(false)
      lastClickHideAtRef.current = Date.now()
    }

    /** 返回本次交互的判定；未配置时一律 normal */
    const classify = (
      target: EventTarget | null,
      kind: ControlBarInteractionKind
    ): ControlBarInteraction => {
      const resolve = resolveInteractionRef.current
      if (!resolve) return 'normal'
      try {
        return resolve(target, kind)
      } catch {
        return 'normal'
      }
    }

    /** 命中 quiet/ignore/swallow：按语义处理，不按普通交互唤醒 */
    const handleBlocked = (mode: ControlBarInteraction) => {
      blockedRef.current = true
      if (mode === 'quiet') {
        // 评论区里：既不收起也不唤醒，保留原有的隐藏计时
        return
      }
      clearIdleTimer()
      setVisible(false)
      if (mode === 'swallow') onBlockedInteractionRef.current?.()
    }

    /** 点播放器画面：切换控制栏显隐 */
    const handleToggle = (pointerType: string) => {
      if (controlBarVisibleRef.current) {
        hideNow()
        return
      }
      setVisible(true)
      if (pointerType === 'touch') {
        // 触摸按住期间保持可见，松开（pointerup）后再计时
        clearIdleTimer()
      } else {
        scheduleIdleHide()
      }
    }

    // ── PointerEvent 处理 ──────────────────────────────
    const handlePointerMove = (e: PointerEvent) => {
      // 触摸（以及部分环境里 pointerType 为空的触摸事件）不需要靠 pointermove
      // 唤醒：一次轻点也会先派发 pointermove，若在这里就唤醒控制栏，紧随其后的
      // pointerdown 会把「控制栏已显示」当成用户意图（分屏下判定为 swallow），
      // 导致点画面反而关掉分屏且不显示控制栏。移动端不靠 hover 唤醒（含蓝牙鼠标），
      // 桌面端鼠标移动仍按原逻辑自动显示。
      if (isMobile || e.pointerType !== 'mouse') return
      // 悬停只做「显示/隐藏控制栏」，不允许触发 swallow（关分屏）等副作用
      const mode = classify(e.target, 'move')
      if (mode !== 'normal') {
        handleBlocked(mode)
        return
      }
      if (
        !controlBarVisibleRef.current &&
        Date.now() - lastClickHideAtRef.current < CLICK_HIDE_SUPPRESS_MS
      ) {
        // 刚点画面收起，忽略紧随其后的轻微移动
        return
      }
      blockedRef.current = false
      setVisible(true)
      scheduleIdleHide()
    }

    const handlePointerLeave = (e: PointerEvent) => {
      // 触摸场景不因 pointerleave 隐藏
      if (e.pointerType === 'touch') return
      setVisible(false)
      clearIdleTimer()
    }

    const handlePointerDown = (e: PointerEvent) => {
      const mode = classify(e.target, 'down')
      if (mode === 'toggle') {
        stagePointerActiveRef.current = true
        blockedRef.current = false
        handleToggle(e.pointerType)
        return
      }
      if (mode !== 'normal') {
        stagePointerActiveRef.current = false
        handleBlocked(mode)
        return
      }
      stagePointerActiveRef.current = true
      blockedRef.current = false
      setVisible(true)
      // 移动端触摸：按住期间一直显示，松开后再计时隐藏
      if (e.pointerType === 'touch') {
        clearIdleTimer()
        return
      }
      handlePointerMove(e)
    }

    const handlePointerUp = (e: PointerEvent) => {
      // 触摸松开：只有从播放器内开始的触摸才重置/开始隐藏倒计时。
      // 触摸评论区等外部区域不刷新计时，避免控制栏一直停留在屏幕上。
      if (e.pointerType === 'touch') {
        const startedInStage = stagePointerActiveRef.current
        stagePointerActiveRef.current = false
        if (!startedInStage || blockedRef.current) return
        if (!controlBarVisibleRef.current) return
        scheduleIdleHide()
      }
    }

    // ── touch 事件兜底（旧设备 / 不支持 PointerEvent 的浏览器）────
    // 支持 PointerEvent 的浏览器里不要再处理 touch：一次轻点会先派发
    // pointerdown 再派发 touchstart，若两边都判定，第二次会读到刚被唤醒的
    // 控制栏状态（分屏下变成 swallow），把评论区关掉且不显示控制栏。
    const pointerEventsSupported =
      typeof window !== 'undefined' && 'PointerEvent' in window
    const handleTouchStart = (e: TouchEvent) => {
      if (pointerEventsSupported) return
      const mode = classify(e.target, 'down')
      if (mode === 'toggle') {
        stagePointerActiveRef.current = true
        blockedRef.current = false
        handleToggle('touch')
        return
      }
      if (mode !== 'normal') {
        stagePointerActiveRef.current = false
        handleBlocked(mode)
        return
      }
      stagePointerActiveRef.current = true
      blockedRef.current = false
      setVisible(true)
      clearIdleTimer()
    }
    const handleTouchMove = (e: TouchEvent) => {
      if (pointerEventsSupported) return
      const mode = classify(e.target, 'move')
      if (mode !== 'normal') {
        handleBlocked(mode)
        return
      }
      setVisible(true)
      clearIdleTimer()
    }
    const handleTouchEnd = () => {
      if (pointerEventsSupported) return
      const startedInStage = stagePointerActiveRef.current
      stagePointerActiveRef.current = false
      if (!startedInStage || blockedRef.current) return
      if (!controlBarVisibleRef.current) return
      scheduleIdleHide()
    }

    // 播放器以外区域按下/触摸：不唤醒控制栏，只保证空闲隐藏计时仍在进行。
    // 若计时已经存在则不重置，避免用户连续操作评论区时把控制栏一直"续命"。
    const handleDocumentPointerDown = (e: PointerEvent) => {
      const stage = stageRef.current
      if (!stage) return
      if (e.target instanceof Node && stage.contains(e.target)) return
      stagePointerActiveRef.current = false
      if (!idleTimerRef.current) scheduleIdleHide()
    }

    stage.addEventListener('pointermove', handlePointerMove)
    stage.addEventListener('pointerleave', handlePointerLeave)
    // 捕获阶段：视频/播放器内部可能 stopPropagation，冒泡阶段会收不到
    // 触摸事件，导致控制栏隐藏后怎么点画面都唤不出来。
    stage.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerdown', handleDocumentPointerDown, true)
    // pointerup 绑到 window：确保手指在任意位置松开都能触发隐藏计时
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    // touch 兜底
    stage.addEventListener('touchstart', handleTouchStart, {
      passive: true,
      capture: true,
    })
    stage.addEventListener('touchmove', handleTouchMove, { passive: true })
    stage.addEventListener('touchend', handleTouchEnd, { passive: true })
    stage.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    if (!isMobile) {
      // 桌面端：初始默认显示，随后按空闲逻辑自动隐藏
      scheduleIdleHide()
    } else if (controlBarVisibleRef.current) {
      // 移动端通常初始隐藏；但 effect 重跑时可能正显示着（例如刚打开分屏），
      // 必须重新挂上隐藏计时，否则控制栏会一直停留在屏幕上。
      scheduleIdleHide()
    }

    return () => {
      stage.removeEventListener('pointermove', handlePointerMove)
      stage.removeEventListener('pointerleave', handlePointerLeave)
      stage.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener(
        'pointerdown',
        handleDocumentPointerDown,
        true
      )
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      stage.removeEventListener('touchstart', handleTouchStart, {
        capture: true,
      })
      stage.removeEventListener('touchmove', handleTouchMove)
      stage.removeEventListener('touchend', handleTouchEnd)
      stage.removeEventListener('touchcancel', handleTouchEnd)
      clearIdleTimer()
    }
  }, [stageRef, isMobile, desktopDelay, mobileDelay, disabled])

  return controlBarVisible
}
