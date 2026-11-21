import { create } from 'zustand'

/**
 * 全屏浮层宿主。
 *
 * 问题：语音聊天悬浮按钮渲染在 document.body 上（fixed 定位），
 * - 原生全屏（requestFullscreen）时浏览器只渲染 fullscreen 元素的子树 → 按钮消失；
 * - 网页全屏时播放器舞台是 fixed z-[100]，会盖住 z-40 的按钮。
 *
 * 解法：全屏播放器把自己的舞台元素与控制栏可见性注册进来，浮层组件
 * （VoiceChatPanel 的按钮）portal 到舞台内部，并随控制栏一起显隐。
 * 同一时刻只允许一个宿主（owner 用组件名区分），退出全屏时注销。
 */
interface FullscreenOverlayState {
  /** 当前宿主标识（退出时校验，避免误清别人的注册） */
  owner: string | null
  /** 宿主舞台元素：浮层 portal 的目标容器 */
  target: HTMLElement | null
  /** 宿主控制栏是否可见：浮层与之同步显隐 */
  controlBarVisible: boolean
  /**
   * 宿主控制栏实测高度（px，含内边距）。
   *
   * 浮层要抬到控制栏上方，但控制栏高度不是固定值：窄屏（手机竖屏）按钮
   * 换行后整条可达 ~110px，静态 80px 的偏移仍会被盖住（用户报「一起看全屏
   * 时控制栏挡住语音按钮」，390 宽下实测重叠 21px）。由播放器测量后写入，
   * 浮层按实测值定位。
   */
  controlBarHeight: number
  /**
   * 全屏分屏评论区的占位尺寸（px）：横屏左右分屏时是宽度，竖屏上下分屏时
   * 是高度；未开分屏为 null / 0。
   *
   * 语音与一起听浮球原本贴舞台右下角；开了右侧评论区分屏后舞台右边缘已让给
   * 评论区，浮球会被挤到评论区上方（用户报「评论区将语音和一起听悬浮按钮挤开，
   * 两个悬浮按钮保持在视频的边框」）。由 CommentSplit 实测写入，浮球据此把
   * 右侧（或底部）偏移让出来，继续贴在画面边框上。
   */
  commentPaneOrientation: 'side' | 'stacked' | null
  commentPaneSize: number
  publish: (owner: string, target: HTMLElement | null) => void
  setControlBarVisible: (visible: boolean) => void
  setControlBarHeight: (height: number) => void
  setCommentPane: (orientation: 'side' | 'stacked' | null, size: number) => void
  clear: (owner: string) => void
}

export const useFullscreenOverlayStore = create<FullscreenOverlayState>(
  (set, get) => ({
    owner: null,
    target: null,
    controlBarVisible: true,
    controlBarHeight: 0,
    commentPaneOrientation: null,
    commentPaneSize: 0,
    publish: (owner, target) => set({ owner, target }),
    setControlBarVisible: (visible) => set({ controlBarVisible: visible }),
    setControlBarHeight: (height) => {
      const next = Math.max(0, Math.round(height))
      if (get().controlBarHeight === next) return
      set({ controlBarHeight: next })
    },
    setCommentPane: (orientation, size) => {
      const nextOrientation = orientation == null ? null : orientation
      const nextSize = nextOrientation == null ? 0 : Math.max(0, Math.round(size))
      const current = get()
      if (
        current.commentPaneOrientation === nextOrientation &&
        current.commentPaneSize === nextSize
      ) {
        return
      }
      set({
        commentPaneOrientation: nextOrientation,
        commentPaneSize: nextSize,
      })
    },
    clear: (owner) => {
      if (get().owner !== owner) return
      set({
        owner: null,
        target: null,
        controlBarVisible: true,
        controlBarHeight: 0,
        commentPaneOrientation: null,
        commentPaneSize: 0,
      })
    },
  })
)
