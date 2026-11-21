import { create } from 'zustand'

/**
 * 一起听控制面板的展开状态（跨实例共享）。
 *
 * 与 voicePanelStore 同构：面板可能被重挂（进出全屏时 portal 容器变化、
 * 房间模式切换时 RoomPage 的分支变化）。展开状态若留在组件里，重挂后就
 * 回到「收起」，用户会看到两个位置（全屏浮层 / 页面右下角）的入口不同步。
 */
interface MusicPanelState {
  /** 当前展开的一起听面板所属房间；null 表示收起 */
  expandedRoomId: string | null
  /** 点歌搜索弹窗开关（独立于面板展开态，全屏切换不丢失） */
  searchOpen: boolean
  /** 队列大列表开关（横屏侧边并排 / 竖屏大弹窗，二选一由视口方向决定） */
  queueOpen: boolean
  setExpanded: (roomId: string | undefined, expanded: boolean) => void
  setSearchOpen: (open: boolean) => void
  setQueueOpen: (open: boolean) => void
  reset: () => void
}

export const useMusicPanelStore = create<MusicPanelState>((set) => ({
  expandedRoomId: null,
  searchOpen: false,
  queueOpen: false,
  setExpanded: (roomId, expanded) =>
    set((state) => ({
      expandedRoomId: expanded
        ? (roomId ?? null)
        : state.expandedRoomId === roomId
          ? null
          : state.expandedRoomId,
    })),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setQueueOpen: (open) => set({ queueOpen: open }),
  reset: () => set({ expandedRoomId: null, searchOpen: false, queueOpen: false }),
}))
