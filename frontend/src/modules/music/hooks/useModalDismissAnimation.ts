import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * cloud-add-in 系弹窗（PlayerSettingsModal / AddToPlaylistModal /
 * NcmSearchModal / BiliFavCollectModal / MusicBilibiliPage 三处）共用的
 * 退出动画中间态管理。
 *
 * 背景：React 卸载即无动画——直接 onClose() 会瞬间消失。本 hook 引入
 * closing 中间态：requestClose() 置 closing → 组件据此切换
 *  - 遮罩类 `lt-modal-dim-in` → `lt-modal-dim-out`（压暗渐进退出）
 *  - 面板 animation `cloud-add-in` → `cloud-add-out`（宽高反向收起）
 * 收起动画结束（onAnimationEnd 匹配 cloud-add-out）后组件再真正回调
 * onClose 卸载。
 *
 * 兜底：closing 置位后 450ms 强制回调——prefers-reduced-motion 下
 * 动画被禁用、onAnimationEnd 永不触发，没有兜底弹窗会卡死无法关闭。
 * 正常路径动画 0.4s 先触发回调，effect cleanup 清掉兜底计时器。
 *
 * requestClose 幂等（closing 中重复点击/Esc 无副作用）。
 *
 * resetClose 供 open-prop 常驻组件（AddToPlaylistModal / NcmSearchModal /
 * BiliFavCollectModal：open=false 时 return null 但组件不卸载）在重新
 * 打开时复位 closing 残留；条件渲染的弹窗每次挂载状态天然复位，无需调用。
 */
export function useModalDismissAnimation(onClose: () => void) {
  const [closing, setClosing] = useState(false)
  /** 始终指向最新 onClose（父组件多以内联箭头函数传入，引用每次渲染都变；
   *  effect 内同步——react-hooks/refs 禁止 render 期间写 ref） */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  const requestClose = useCallback(() => setClosing(true), [])
  const resetClose = useCallback(() => setClosing(false), [])
  useEffect(() => {
    if (!closing) return
    const timer = window.setTimeout(() => onCloseRef.current(), 450)
    return () => window.clearTimeout(timer)
  }, [closing])
  return { closing, requestClose, resetClose }
}
