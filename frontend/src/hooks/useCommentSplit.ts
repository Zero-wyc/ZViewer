/**
 * 全屏分屏评论区：开关状态、比例持久化与视口方向。
 *
 * 与 `components/CommentSplit.tsx`（纯布局组件）分开，是为了让组件文件只导出
 * 组件——`react-refresh/only-export-components` 要求如此，否则热更新会整块刷新。
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

/** 分屏比例持久化 key */
export const COMMENT_SPLIT_RATIO_STORAGE_KEY = 'zviewer.comment-split.ratio'
/** 默认比例：评论区占 50% */
export const COMMENT_SPLIT_DEFAULT_RATIO = 0.5
/** 拖拽下限：画面至少保留 10% */
export const COMMENT_SPLIT_MIN_RATIO = 0.1
/** 拖拽上限：评论区最多占 90% */
export const COMMENT_SPLIT_MAX_RATIO = 0.9
/** 开合动画时长（ms，与布局组件的 transition 保持一致） */
export const COMMENT_SPLIT_ANIMATION_MS = 220

export type CommentSplitOrientation = 'side' | 'stacked'

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return COMMENT_SPLIT_DEFAULT_RATIO
  return Math.min(
    COMMENT_SPLIT_MAX_RATIO,
    Math.max(COMMENT_SPLIT_MIN_RATIO, value)
  )
}

function readStoredRatio(): number {
  try {
    const raw = window.localStorage.getItem(COMMENT_SPLIT_RATIO_STORAGE_KEY)
    if (!raw) return COMMENT_SPLIT_DEFAULT_RATIO
    return clampRatio(Number.parseFloat(raw))
  } catch {
    return COMMENT_SPLIT_DEFAULT_RATIO
  }
}

function subscribeOrientation(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  window.addEventListener('orientationchange', onChange)
  return () => {
    window.removeEventListener('resize', onChange)
    window.removeEventListener('orientationchange', onChange)
  }
}

function readOrientation(): CommentSplitOrientation {
  return window.innerHeight > window.innerWidth ? 'stacked' : 'side'
}

/**
 * 视口方向：竖屏竖排（上下分屏）、横屏横排（左右分屏）。
 * 用 useSyncExternalStore 读取，避免 effect 里 setState 触发额外渲染。
 */
export function useCommentSplitOrientation(): CommentSplitOrientation {
  return useSyncExternalStore<CommentSplitOrientation>(
    subscribeOrientation,
    readOrientation,
    () => 'side'
  )
}

/** 分屏开关 + 比例状态（比例持久化到 localStorage） */
export function useCommentSplit(active: boolean) {
  const [open, setOpen] = useState(false)
  const [ratio, setRatioState] = useState<number>(() => readStoredRatio())

  const setRatio = useCallback((next: number) => {
    const clamped = clampRatio(next)
    setRatioState(clamped)
    try {
      window.localStorage.setItem(
        COMMENT_SPLIT_RATIO_STORAGE_KEY,
        clamped.toFixed(4)
      )
    } catch {
      // localStorage 不可用（隐私模式等）时只影响记忆，不影响本次使用
    }
  }, [])

  // 退出全屏后收起分屏：下次进全屏是「没开评论区」的干净状态。
  // 全屏状态由外部（Fullscreen API / 网页全屏 prop）驱动，此处属于响应外部系统状态变化。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 全屏状态由外部驱动
    if (!active) setOpen(false)
  }, [active])

  const toggle = useCallback(() => setOpen((prev) => !prev), [])
  const close = useCallback(() => setOpen(false), [])

  return { open, toggle, close, ratio, setRatio, active: open && active }
}
