import { create } from 'zustand'

/**
 * 评论悬浮窗。
 *
 * 原来「独立窗口」按钮走 window.open 打开浏览器小窗：在桌面壳（WebView2）里
 * 会另开系统窗口、脱离主界面，还要重新握手/进房，体验割裂。改为应用内悬浮窗：
 * 无边框、可拖动、可调背景透明度、可切换置顶。
 *
 * 这里只存状态（房间号、透明度、置顶、位置尺寸），渲染在
 * components/CommentFloatingWindow.tsx，挂载于 Layout 全局一次。
 */
export interface CommentFloatRect {
  x: number
  y: number
  w: number
  h: number
}

const STORAGE_KEY = 'zviewer.comment-float.window.v1'

/** 透明度下限：再低文字就压不住背景了 */
export const COMMENT_FLOAT_MIN_OPACITY = 0.3
export const COMMENT_FLOAT_DEFAULT_OPACITY = 0.88
/** 悬浮窗最小尺寸，避免被拖成一条线 */
export const COMMENT_FLOAT_MIN_WIDTH = 280
export const COMMENT_FLOAT_MIN_HEIGHT = 220

interface PersistedState {
  opacity: number
  pinned: boolean
  rect: CommentFloatRect | null
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return COMMENT_FLOAT_DEFAULT_OPACITY
  return Math.min(1, Math.max(COMMENT_FLOAT_MIN_OPACITY, value))
}

function loadPersisted(): PersistedState {
  const fallback: PersistedState = {
    opacity: COMMENT_FLOAT_DEFAULT_OPACITY,
    pinned: true,
    rect: null,
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const rect = parsed.rect
    const validRect =
      rect &&
      [rect.x, rect.y, rect.w, rect.h].every((n) => Number.isFinite(n))
        ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.max(COMMENT_FLOAT_MIN_WIDTH, Math.round(rect.w)),
            h: Math.max(COMMENT_FLOAT_MIN_HEIGHT, Math.round(rect.h)),
          }
        : null
    return {
      opacity: clampOpacity(parsed.opacity ?? fallback.opacity),
      pinned: parsed.pinned ?? fallback.pinned,
      rect: validRect,
    }
  } catch {
    return fallback
  }
}

function savePersisted(state: PersistedState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式/配额满：悬浮窗仍可用，只是不记忆
  }
}

interface CommentFloatingState {
  /** 打开悬浮窗的房间号；null 表示未打开 */
  roomId: string | null
  /** 窗口背景不透明度 0.3~1 */
  opacity: number
  /** 置顶：压在其他悬浮面板（语音/一起听）之上 */
  pinned: boolean
  rect: CommentFloatRect | null
  open: (roomId: string) => void
  close: () => void
  setOpacity: (opacity: number) => void
  togglePinned: () => void
  setRect: (rect: CommentFloatRect) => void
}

const initial = loadPersisted()

export const useCommentFloatingStore = create<CommentFloatingState>(
  (set, get) => ({
    roomId: null,
    opacity: initial.opacity,
    pinned: initial.pinned,
    rect: initial.rect,
    open: (roomId) => {
      if (!roomId) return
      set({ roomId })
    },
    close: () => set({ roomId: null }),
    setOpacity: (opacity) => {
      const next = clampOpacity(opacity)
      if (get().opacity === next) return
      set({ opacity: next })
      savePersisted({ opacity: next, pinned: get().pinned, rect: get().rect })
    },
    togglePinned: () => {
      const next = !get().pinned
      set({ pinned: next })
      savePersisted({ opacity: get().opacity, pinned: next, rect: get().rect })
    },
    setRect: (rect) => {
      const next: CommentFloatRect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.max(COMMENT_FLOAT_MIN_WIDTH, Math.round(rect.w)),
        h: Math.max(COMMENT_FLOAT_MIN_HEIGHT, Math.round(rect.h)),
      }
      const current = get().rect
      if (
        current &&
        current.x === next.x &&
        current.y === next.y &&
        current.w === next.w &&
        current.h === next.h
      ) {
        return
      }
      set({ rect: next })
      savePersisted({ opacity: get().opacity, pinned: get().pinned, rect: next })
    },
  })
)
