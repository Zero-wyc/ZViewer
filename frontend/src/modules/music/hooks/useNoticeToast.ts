/**
 * 瞬时提示条（syncNotice）的展示生命周期。
 *
 * 两条时序规则原先内联在 ListenTogetherPanel：
 *
 * - **5s 自动消失**：到点回调 `dismiss`，真正的清除动作仍在调用方
 * - **退场动画**：清除后不能立刻卸载，否则提示会「闪现消失」。保留最后
 *   文案继续渲染 0.3s（播放上飘淡出动画），动画时长到才真正置空。
 *   状态同步走 render 期派生（react-hooks 规则禁止 effect 内同步 setState、
 *   也禁止渲染期读 ref），卸载定时器走 effect。
 *
 * 返回的两个值即为渲染入口：调用方用 `syncNotice || noticeLeaving` 判定
 * 是否渲染、渲染 `noticeView`（而非原始 syncNotice，保证退场期文案不空）。
 * 视图组件见 components/PlayerNoticeOverlay.tsx。
 */
import { useEffect, useState } from 'react'
import { SYNC_NOTICE_AUTO_DISMISS_MS } from '../constants'

/** 退场动画时长（毫秒）：与 zen-notice-leave 动画时长对齐 */
const NOTICE_LEAVE_MS = 300

export type NoticeKind = 'info' | 'approval'

export interface NoticeView {
  text: string
  kind: NoticeKind
}

export interface UseNoticeToastOptions {
  /** 当前提示文案（null = 无提示） */
  notice: string | null
  /** 提示类型：信息类 / 需要房主审批的控制申请 */
  noticeKind: NoticeKind
  /** 到点自动关闭的回调（透出给调用方清除自己的 state） */
  dismiss: () => void
}

export function useNoticeToast({
  notice,
  noticeKind,
  dismiss,
}: UseNoticeToastOptions) {
  const [noticeView, setNoticeView] = useState<NoticeView | null>(null)
  const [noticeLeaving, setNoticeLeaving] = useState(false)

  if (notice) {
    if (
      noticeLeaving ||
      noticeView?.text !== notice ||
      noticeView?.kind !== noticeKind
    ) {
      setNoticeView({ text: notice, kind: noticeKind })
      setNoticeLeaving(false)
    }
  } else if (noticeView && !noticeLeaving) {
    setNoticeLeaving(true)
  }

  // 退场动画结束才真正卸载
  useEffect(() => {
    if (!noticeLeaving) return
    const timer = setTimeout(() => {
      setNoticeLeaving(false)
      setNoticeView(null)
    }, NOTICE_LEAVE_MS)
    return () => clearTimeout(timer)
  }, [noticeLeaving])

  // 5s 自动消失
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(dismiss, SYNC_NOTICE_AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [notice, dismiss])

  return { noticeView, noticeLeaving }
}
