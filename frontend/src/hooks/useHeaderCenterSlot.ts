/**
 * 全局 Header 中央槽位挂载 hook。
 *
 * Header（fixed 顶部栏）中部预留了 id="header-center-slot" 的空槽位，
 * 页面用本 hook 拿到挂载节点后以 createPortal 注入内容（如房间模式
 * 切换滑块）：无需全局状态，页面卸载时 portal 自动移除。
 *
 * 布局时序：Layout 先渲染 Header 再渲染 children（同一 commit），但
 * DOM 查询需要等 commit 完成——用 rAF 回调取节点（setState 在回调内，
 * 避免 effect 体内同步 setState 的级联渲染）。
 */
import { useLayoutEffect, useState } from 'react'

/** Header 中央槽位的 DOM id（与 Header.tsx 中的占位节点一致） */
export const HEADER_CENTER_SLOT_ID = 'header-center-slot'

export function useHeaderCenterSlot(): HTMLElement | null {
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    let raf = 0
    raf = requestAnimationFrame(() => {
      setSlotEl(document.getElementById(HEADER_CENTER_SLOT_ID))
    })
    return () => {
      cancelAnimationFrame(raf)
      setSlotEl(null)
    }
  }, [])
  return slotEl
}
