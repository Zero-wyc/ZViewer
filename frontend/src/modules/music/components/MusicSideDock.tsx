/**
 * 一起听右侧悬浮工具坞（Hydrogen 侧栏范式）。
 *
 * 把「语音聊天 / 房间状态 / 流量统计」三个悬浮面板集成进一个右侧边栏：
 * - 默认隐藏，仅在屏幕右缘垂直居中处显示一条 5px 竖线把手；
 * - 鼠标移入竖线（或移入侧边栏）→ 侧边栏从右缘滑入悬浮展示（不挤压内容）；
 * - 鼠标移出 320ms 后自动收起（延迟避免从把手移动到面板途中误收）；
 * - 点击竖线可切换显隐（触屏设备无 hover 时的兜底交互）。
 *
 * 侧边栏内部为三个面板纵向堆叠、同时可见（各自保留标题栏与高度上限，
 * 超出部分在侧边栏容器内滚动）；面板常挂载：useVoiceChat 的语音连接与
 * RoomInfoPanel 的房间监听不因滚动位置而中断。
 * 完整播放器覆盖层打开时由 MusicAppShell 门控整坞卸载，保持沉浸。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { VoiceChatPanel } from '@/modules/voice-chat/components/VoiceChatPanel'
import { TrafficPanel } from '@/modules/room/components/TrafficPanel'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { cn } from '@/lib/utils'

interface MusicSideDockProps {
  socket: Socket | null
  roomId: string
  username?: string
  isHost: boolean
  /** 队列/房间管理权限（房主或房管），透传为语音禁言/踢出权限 */
  canManage: boolean
}

/** 鼠标移出后的收起延迟：覆盖「把手 → 面板」之间的空隙移动与误滑出 */
const DOCK_CLOSE_DELAY_MS = 320

export function MusicSideDock({
  socket,
  roomId,
  username,
  isHost,
  canManage,
}: MusicSideDockProps) {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const handleEnter = useCallback(() => {
    clearCloseTimer()
    setOpen(true)
  }, [clearCloseTimer])

  const handleLeave = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(
      () => setOpen(false),
      DOCK_CLOSE_DELAY_MS
    )
  }, [clearCloseTimer])

  // 卸载时清理收起定时器
  useEffect(() => clearCloseTimer, [clearCloseTimer])

  return (
    <>
      {/* 右缘竖线把手：默认态的唯一可见元素；hover 滑出侧边栏，点击切换（触屏兜底） */}
      <div
        role="button"
        tabIndex={0}
        aria-label={open ? '收起侧边工具栏' : '展开侧边工具栏'}
        title={open ? '收起侧边工具栏' : '展开侧边工具栏'}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onClick={() => {
          clearCloseTimer()
          setOpen((v) => !v)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            clearCloseTimer()
            setOpen((v) => !v)
          }
        }}
        className="fixed right-0 top-1/2 z-[45] h-28 w-[5px] -translate-y-1/2 cursor-pointer rounded-l-md transition-colors duration-200"
        style={{
          backgroundColor: open
            ? 'var(--md-sys-color-primary)'
            : 'color-mix(in srgb, var(--md-sys-color-on-surface) 30%, transparent)',
        }}
      />

      {/* 悬浮侧边栏：三面板纵向堆叠同时可见（各自高度上限 + 容器滚动兜底） */}
      <aside
        aria-hidden={!open}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        className={cn(
          'fixed right-1.5 top-1/2 z-[45] flex w-[344px] max-w-[calc(100vw-1.5rem)] -translate-y-1/2 flex-col overflow-hidden',
          'rounded-[var(--md-sys-shape-corner)] transition-all duration-300',
          open
            ? 'pointer-events-auto translate-x-0 opacity-100'
            : 'pointer-events-none translate-x-6 opacity-0'
        )}
        style={{
          maxHeight: 'min(760px, calc(100vh - 100px))',
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-surface-container) 94%, transparent)',
          border:
            '1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 60%, transparent)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.25)',
        }}
      >
        {/* 内容区：三面板纵向堆叠、常挂载（保持语音连接/房间监听） */}
        <div className="zen-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {/* 语音聊天（成员较多时面板内部滚动，高度上限保护后面面板可见性） */}
          <div className="flex min-h-0 shrink-0 flex-col">
            <VoiceChatPanel
              embedded
              socket={socket}
              roomId={roomId}
              username={username}
              canManageVoice={canManage}
            />
          </div>
          {/* 房间状态（成员/设置较多，内部滚动） */}
          <div className="max-h-[min(56vh,460px)] shrink-0 overflow-y-auto">
            <RoomInfoPanel roomId={roomId} isHost={isHost} />
          </div>
          {/* 流量统计（内容较少，自适应高度） */}
          <div className="shrink-0">
            <TrafficPanel embedded />
          </div>
        </div>
      </aside>
    </>
  )
}
