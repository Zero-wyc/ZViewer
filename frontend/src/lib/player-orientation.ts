/**
 * player-orientation —— 手机端播放器全屏后的横屏 / 竖屏切换。
 *
 * 两条实现路径：
 * 1) Screen Orientation API（Android Chrome / 支持 lock 的浏览器）：进入全屏后真正锁定屏幕方向。
 * 2) CSS 兜底（iOS Safari 与“网页全屏”）：网页全屏是 CSS 模拟的全屏，此时调用 lock 会失败，
 *    因此给舞台追加 {@link FORCE_LANDSCAPE_CLASS}，由样式在竖屏视口下把舞台旋转 90°。
 *
 * 语义约定：
 * - 每次进入全屏都自动从横屏开始；退出全屏恢复系统方向（解锁）。
 * - 竖屏态在锁定可用时锁 portrait；CSS 兜底时直接还原（跟随设备物理方向）。
 * - {@link FORCE_LANDSCAPE_CLASS} 只在竖屏视口（@media (orientation: portrait)）内生效，
 *   设备物理旋转后样式自动失效，不会出现“双重旋转”。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

/** 强制横屏时加在播放舞台上的类名（样式见 art-overrides.css） */
export const FORCE_LANDSCAPE_CLASS = 'zviewer-force-landscape'
/**
 * 强制竖屏时加在播放舞台上的类名：设备物理横屏（或系统方向锁定失败）时，
 * 把舞台反向旋转 90° 呈现竖屏画面。用户报「全屏状态下无法切换竖屏」——
 * 原来只实现了「强制横屏」，竖屏按钮在网页全屏/锁定不可用的路径上等于没反应。
 */
export const FORCE_PORTRAIT_CLASS = 'zviewer-force-portrait'

export type PlayerOrientation = 'landscape' | 'portrait'

type ScreenOrientationWithLock = ScreenOrientation & {
  lock?: (orientation: 'landscape' | 'portrait') => Promise<void>
  unlock?: () => void
}

function getScreenOrientation(): ScreenOrientationWithLock | undefined {
  if (typeof screen === 'undefined') return undefined
  return screen.orientation as ScreenOrientationWithLock | undefined
}

/** 当前浏览器是否支持锁定屏幕方向 */
export function supportsOrientationLock(): boolean {
  return typeof getScreenOrientation()?.lock === 'function'
}

/** 是否为触屏设备（旋转功能只在触屏设备上出现） */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false
  if (navigator.maxTouchPoints > 0) return true
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  )
}

async function lockOrientation(
  orientation: PlayerOrientation
): Promise<boolean> {
  const screenOrientation = getScreenOrientation()
  const lock = screenOrientation?.lock
  if (!screenOrientation || typeof lock !== 'function') return false
  try {
    await lock.call(screenOrientation, orientation)
    return true
  } catch {
    // 非全屏状态、桌面浏览器、iOS 等都会走到这里，交由调用方降级处理
    return false
  }
}

function unlockOrientation(): void {
  const screenOrientation = getScreenOrientation()
  if (typeof screenOrientation?.unlock !== 'function') return
  try {
    screenOrientation.unlock()
  } catch {
    // 部分实现要求处于全屏才能 unlock，失败可忽略
  }
}

export interface UsePlayerRotationOptions {
  /** 播放舞台容器（旋转 / 加类名的目标元素） */
  stageRef: React.RefObject<HTMLElement | null>
  /** 是否处于全屏（原生全屏或网页全屏） */
  active: boolean
  /** 当前是否走 CSS 兜底（网页全屏时无法真正锁定方向） */
  cssFallbackActive?: boolean
}

export interface PlayerRotation {
  /** 当前方向 */
  orientation: PlayerOrientation
  /** 是否处于强制横屏（用于按钮图标与高亮） */
  forcedLandscape: boolean
  /** 是否显示旋转按钮：触屏设备 + 已全屏 + 有可用实现 */
  canRotate: boolean
  /** 横屏 / 竖屏切换 */
  toggle: () => void
}

export function usePlayerRotation({
  stageRef,
  active,
  cssFallbackActive = false,
}: UsePlayerRotationOptions): PlayerRotation {
  const touchDevice = useMemo(() => isTouchDevice(), [])
  const [lockUsable, setLockUsable] = useState(() => supportsOrientationLock())
  const [orientation, setOrientation] =
    useState<PlayerOrientation>('landscape')

  // 网页全屏（CSS 模拟）与不支持锁定方向的浏览器都走 CSS 兜底
  const useCssFallback = cssFallbackActive || !lockUsable

  // 每次进入全屏都从横屏开始
  useEffect(() => {
    if (!active) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入全屏属于会话切换，需重置为横屏
    setOrientation('landscape')
  }, [active])

  // 应用旋转：CSS 兜底时只切类名（横屏 / 竖屏各一个），其余场景真正锁定屏幕方向
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const cssFallbackNow = touchDevice && active && useCssFallback
    stage.classList.toggle(
      FORCE_LANDSCAPE_CLASS,
      cssFallbackNow && orientation === 'landscape'
    )
    stage.classList.toggle(
      FORCE_PORTRAIT_CLASS,
      cssFallbackNow && orientation === 'portrait'
    )
    if (!active || !touchDevice) {
      unlockOrientation()
      return undefined
    }
    if (useCssFallback) return undefined

    let cancelled = false
    void lockOrientation(orientation).then((ok) => {
      if (cancelled || ok) return
      // 设备拒绝锁定（如桌面浏览器模拟触屏）：降级为不显示旋转按钮
      setLockUsable(false)
    })
    return () => {
      cancelled = true
    }
  }, [stageRef, touchDevice, active, useCssFallback, orientation])

  // 卸载时清理类名与方向锁定
  useEffect(() => {
    return () => {
      stageRef.current?.classList.remove(FORCE_LANDSCAPE_CLASS)
      stageRef.current?.classList.remove(FORCE_PORTRAIT_CLASS)
      unlockOrientation()
    }
  }, [stageRef])

  const canRotate = touchDevice && active && (useCssFallback || lockUsable)

  const toggle = useCallback(() => {
    setOrientation((prev) => (prev === 'landscape' ? 'portrait' : 'landscape'))
  }, [])

  return {
    orientation,
    forcedLandscape: touchDevice && active && orientation === 'landscape',
    canRotate,
    toggle,
  }
}
