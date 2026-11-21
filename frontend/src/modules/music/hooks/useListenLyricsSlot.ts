import { useCallback } from 'react'
import { useListenLyricsStore } from '@/store/listenLyricsStore'

/**
 * 注册「播放器下方」歌词插槽的稳定 ref 回调。
 *
 * 必须用 useCallback 包一层：内联箭头函数每次渲染都是新引用，React 会
 * 先以 null 再以元素调用，导致 store 来回抖动（甚至重渲染循环）。
 */
export function useListenLyricsSlot() {
  const setSlot = useListenLyricsStore((s) => s.setSlot)
  return useCallback(
    (el: HTMLDivElement | null) => {
      setSlot(el)
    },
    [setSlot]
  )
}
