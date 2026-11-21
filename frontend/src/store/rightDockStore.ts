import { create } from 'zustand'

/**
 * 右下角入口竖列的占位高度。
 *
 * 房间右下角有多个独立悬浮层：语音浮球（bottom-6）、Live2D 角色设置
 * （bottom-84）、动捕预览（再往上一档），音乐浮球同在这个角落。以前音乐
 * 浮球写死 bottom-24/96，正好压在角色设置钮上（用户报「这几个悬浮窗重叠了，
 * 一起听放到上面去」）。Live2D 宿主把自己的竖列顶边登记进来，音乐浮层据此
 * 把落点抬到整列之上——两边各自维护，不互相依赖组件内部实现。
 */
interface RightDockState {
  /** Live2D 入口竖列的顶边距视口底部的 px；宿主未挂载（或列在左下角）时为 0 */
  live2dTop: number
  setLive2dTop: (top: number) => void
}

export const useRightDockStore = create<RightDockState>((set) => ({
  live2dTop: 0,
  setLive2dTop: (top) => set({ live2dTop: top }),
}))
