import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 评论区侧边栏「双击控制键」热键选项 */
export type CommentDockHotkey = 'off' | 'ctrl' | 'alt' | 'shift'

interface PlayerPrefsState {
  /**
   * 双击控制键打开/关闭全屏评论区侧边栏。
   * 'off' 为关闭快捷键(默认),仅靠鼠标移到屏幕右缘触发。
   */
  commentDockHotkey: CommentDockHotkey
  setCommentDockHotkey: (key: CommentDockHotkey) => void
}

/**
 * 播放器本地偏好(跨房间持久化,不参与同步)。
 * 与 danmakuStore 分离:弹幕样式是弹幕域,这里放播放器交互偏好。
 */
export const usePlayerPrefsStore = create<PlayerPrefsState>()(
  persist(
    (set) => ({
      commentDockHotkey: 'off',
      setCommentDockHotkey: (commentDockHotkey) => set({ commentDockHotkey }),
    }),
    { name: 'player-prefs-storage', version: 1 }
  )
)
