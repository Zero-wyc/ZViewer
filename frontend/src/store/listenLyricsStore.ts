import { create } from 'zustand'

/**
 * 一起听歌词「播放器下方」插槽。
 *
 * 歌词条挂在 MusicPlayerProvider 内（RoomPage），但视觉上要落在各房间布局的
 * 播放器正下方。布局组件与歌词组件没有父子关系，因此由布局把自己的一块
 * 空容器注册到这里，歌词组件通过 portal 渲染进去。
 *
 * 同一时刻只应有一个布局挂载；换模式/换布局时旧容器卸载会把 slot 清空。
 */
interface ListenLyricsState {
  slot: HTMLElement | null
  setSlot: (slot: HTMLElement | null) => void
}

export const useListenLyricsStore = create<ListenLyricsState>((set, get) => ({
  slot: null,
  setSlot: (slot) => {
    if (get().slot === slot) return
    set({ slot })
  },
}))
