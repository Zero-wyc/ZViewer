/**
 * 播放页左上角提示区。
 *
 * 从 ListenTogetherPanel 抽出的一条非模态提示条容器，两类内容共存：
 *
 * - **房主离线提示**：房主不在房间且当前用户拿到自主控制权时的常驻提示
 * - **syncNotice**：5s 自动消失的瞬时提示。房主端对「观众控制申请」类
 *   （kind = 'approval'）额外渲染通过 / 拒绝小按钮；纯状态提示（解析进度、
 *   结果回执等）不显示按钮
 *
 * 提示采用「渲染入口 + 退场动画」双状态：syncNotice 清除后仍保留最后文案
 * 0.3s 播放上飘淡出，动画结束才真正卸载（此前是直接闪现消失）。该延迟
 * 状态由父级持有并经 props 传入（详见 useNoticeToast 语义）。
 */
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NoticeView } from '../hooks/useNoticeToast'

export interface PlayerNoticeOverlayProps {
  /** 房主是否离线（且当前用户非房主） */
  hostOffline: boolean
  /** 当前用户是否有直接控制权（有则无需提示「可自主控制」） */
  canControl: boolean
  /** 瞬时提示文案（null = 无） */
  syncNotice: string | null
  /** 是否处于退场动画期（文案仍保留、正在上飘淡出） */
  noticeLeaving: boolean
  /** 实际渲染用的提示快照（退场期继续渲染旧文案） */
  noticeView: NoticeView | null
  /** 是否房主（审批按钮仅房主可见） */
  isHost: boolean
  /** 通过/拒绝当前控制申请 */
  approveControl: () => void
  rejectControl: () => void
  /** 纯净模式下整体隐藏 */
  immersive: boolean
}

export function PlayerNoticeOverlay({
  hostOffline,
  canControl,
  syncNotice,
  noticeLeaving,
  noticeView,
  isHost,
  approveControl,
  rejectControl,
  immersive,
}: PlayerNoticeOverlayProps) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute left-4 top-4 z-30 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 max-md:left-3 max-md:top-3',
        immersive && 'invisible'
      )}
    >
      {hostOffline && !canControl && (
        <div className="zen-notice-bar zen-stagger-fade-up pointer-events-auto flex items-center gap-2 rounded-[14px] px-3.5 py-2 text-xs font-medium">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--md-sys-color-tertiary)] opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--md-sys-color-tertiary)]" />
          </span>
          房主已离开，您可以自主控制播放
        </div>
      )}
      {(syncNotice || noticeLeaving) && noticeView && (
        <div
          className={cn(
            'zen-notice-bar pointer-events-auto flex items-center gap-2.5 rounded-[14px] py-2 pl-3.5 pr-2 text-xs font-medium',
            // 退出动画期间替换入场动画类（上飘淡出后再卸载）
            noticeLeaving ? 'zen-notice-leave' : 'zen-notice-drop-in'
          )}
        >
          <span>{noticeView.text}</span>
          {/* 仅审批类提示（观众控制申请）渲染通过/拒绝按钮；
              纯状态提示（解析进度、结果回执等）不显示；
              退出动画期间 pendingControl 已定，不再渲染 */}
          {isHost && !noticeLeaving && noticeView.kind === 'approval' && (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={approveControl}
                className="flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-bold text-[#111114] transition-all hover:opacity-85 active:scale-95"
                style={{ backgroundColor: 'rgba(255, 255, 255, 0.92)' }}
                title="通过申请"
              >
                <Check className="h-3 w-3" strokeWidth={2.5} />
                通过
              </button>
              <button
                type="button"
                onClick={rejectControl}
                className="flex h-6 items-center gap-1 rounded-full border border-white/20 px-2.5 text-[11px] font-medium text-[#ff6b6b] transition-colors hover:border-white/35 hover:bg-white/10 active:scale-95"
                title="拒绝申请"
              >
                <X className="h-3 w-3" />
                拒绝
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
