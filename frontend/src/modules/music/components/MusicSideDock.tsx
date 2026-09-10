/**
 * 一起听右侧悬浮工具坞（Hydrogen 侧栏范式）。
 *
 * 把「语音聊天 / 房间状态 / 流量统计」三个悬浮面板集成进一个右侧边栏：
 * - 默认隐藏，仅在屏幕右缘垂直居中处显示一条 5px 竖线把手；
 * - 鼠标移入竖线（或移入侧边栏）→ 侧边栏从右缘滑入悬浮展示（不挤压内容）；
 * - 鼠标移出 320ms 后自动收起（延迟避免从把手移动到面板途中误收）；
 * - 点击竖线可切换显隐（触屏设备无 hover 时的兜底交互）。
 *
 * 侧边栏内部为三个 Tab 分段切换，三个面板常挂载（hidden 切换）：
 * useVoiceChat 的语音连接与 RoomInfoPanel 的房间监听不因切 Tab 而中断。
 * 完整播放器覆盖层打开时由 MusicAppShell 门控整坞卸载，保持沉浸。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Headphones, Settings } from 'lucide-react'
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

type DockTab = 'room' | 'voice' | 'traffic'

const DOCK_TABS: Array<{
  key: DockTab
  label: string
  icon: typeof Headphones
}> = [
  { key: 'room', label: '房间状态', icon: Settings },
  { key: 'voice', label: '语音聊天', icon: Headphones },
  { key: 'traffic', label: '流量统计', icon: Activity },
]

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
  const [tab, setTab] = useState<DockTab>('room')
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

      {/* 悬浮侧边栏：三 Tab + 常挂载面板（hidden 切换，保持语音/房间监听） */}
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
          maxHeight: 'min(680px, calc(100vh - 120px))',
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-surface-container) 94%, transparent)',
          border:
            '1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 60%, transparent)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.25)',
        }}
      >
        {/* Tab 分段头 */}
        <div
          className="flex shrink-0 gap-1 border-b p-2"
          style={{
            borderColor:
              'color-mix(in srgb, var(--md-sys-color-outline-variant) 60%, transparent)',
          }}
        >
          {DOCK_TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 rounded-[var(--md-sys-radius-small)] px-2 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                    : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]'
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {label}
              </button>
            )
          })}
        </div>

        {/* 内容区：三面板常挂载，hidden 切换避免语音连接/房间监听中断 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col',
              tab === 'voice' ? '' : 'hidden'
            )}
          >
            <VoiceChatPanel
              embedded
              socket={socket}
              roomId={roomId}
              username={username}
              canManageVoice={canManage}
            />
          </div>
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col',
              tab === 'room' ? '' : 'hidden'
            )}
          >
            <RoomInfoPanel roomId={roomId} isHost={isHost} />
          </div>
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col',
              tab === 'traffic' ? '' : 'hidden'
            )}
          >
            <TrafficPanel embedded />
          </div>
        </div>
      </aside>
    </>
  )
}
