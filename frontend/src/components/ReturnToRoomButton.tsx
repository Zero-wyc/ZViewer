import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { DoorOpen, X } from 'lucide-react'
import { useRoomStore } from '@/store/roomStore'
import { useSocket } from '@/hooks/useSocket'
import { cn } from '@/lib/utils'

/**
 * "回到房间"浮动入口。
 *
 * 当用户进入过房间后不在房间页面时（无论是不离开房间导航到其他页面，
 * 还是主动离开房间），在右上角显示一个浮动按钮，点击即可快速回到房间。
 *
 * 工作原理：
 * - RoomPage 挂载时设置 roomStore.activeRoomId
 * - 「主动离开房间」与「导航到其他页面」都保留 activeRoomId
 * - 此组件检测到 activeRoomId 存在且当前不在房间路由，显示浮动入口
 * - 用户点击"回到房间"导航回 /room/:activeRoomId
 * - 用户点击关闭按钮才真正退出：房主 emit host-leave（进入宽限期）+
 *   exitRoom() 清除本地状态；进入/创建新房间时也会自动释放旧房间
 */
export function ReturnToRoomButton() {
  const location = useLocation()
  const navigate = useNavigate()
  const { socket } = useSocket()
  const activeRoomId = useRoomStore((state) => state.activeRoomId)
  const roomName = useRoomStore((state) => state.roomName)
  const exitRoom = useRoomStore((state) => state.exitRoom)

  // 当前路由是否为房间页面。
  // 注意：不能用 startsWith('/room')，否则 /rooms（房间列表）会被误判。
  // 房间路由只有两种形式：/room（无 roomId）和 /room/:roomId
  const isInRoomRoute =
    location.pathname === '/room' || location.pathname.startsWith('/room/')

  // 是否应该显示：有活跃房间且不在房间页面
  const shouldShow = !!activeRoomId && !isInRoomRoute

  // 渲染状态：配合退场动画，shouldShow=false 时延迟卸载
  const [render, setRender] = useState(false)
  const [exiting, setExiting] = useState(false)

  // React Compiler 严格规则误报：render/exiting 仅用于入场/退场动画状态同步。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (shouldShow) {
      setRender(true)
      setExiting(false)
    } else if (render) {
      // 播放退场动画后卸载
      setExiting(true)
      const timer = setTimeout(() => {
        setRender(false)
        setExiting(false)
      }, 280)
      return () => clearTimeout(timer)
    }
  }, [shouldShow, render])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!render || !activeRoomId) return null

  const handleReturn = () => {
    navigate(`/room/${activeRoomId}`)
  }

  const handleExit = (e: React.MouseEvent) => {
    e.stopPropagation()
    // 真正退出：房主此时才 emit host-leave（房间进入 10 分钟宽限期后关闭，
    // 期间可通过房间链接重新进入恢复房主身份），并清除本地房间状态。
    try {
      if (
        activeRoomId &&
        sessionStorage.getItem('zcontrol-host-room') === activeRoomId
      ) {
        socket?.emit('host-leave', () => {
          /* ack */
        })
      }
    } catch {
      // ignore
    }
    exitRoom()
  }

  return (
    <div
      className={cn(
        'fixed top-20 right-4 z-40',
        exiting ? 'zen-toast-exit' : 'zen-toast-enter'
      )}
    >
      <button
        onClick={handleReturn}
        className={cn(
          'group flex items-center gap-2.5 rounded-[var(--md-sys-shape-corner)] border border-[var(--glass-border)] px-4 py-2.5 shadow-lg transition-all duration-200',
          'hover:scale-[1.02] hover:shadow-xl active:scale-[0.98]'
        )}
        style={{
          backgroundColor: 'var(--glass-bg)',
          backdropFilter: 'blur(var(--glass-blur-strong))',
          WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
          boxShadow:
            '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
        }}
        title="回到房间"
      >
        {/* 图标容器：Material 3 container 纯色背景 */}
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            backgroundColor: 'var(--md-sys-color-primary-container)',
            color: 'var(--md-sys-color-on-primary-container)',
          }}
        >
          <DoorOpen className="h-4 w-4" />
        </span>

        <div className="flex flex-col items-start">
          <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
            回到房间
          </span>
          {roomName ? (
            <span className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
              {roomName}
            </span>
          ) : (
            <span className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
              {activeRoomId}
            </span>
          )}
        </div>

        {/* 关闭按钮：点击退出房间（清除活跃房间标记） */}
        <span
          onClick={handleExit}
          role="button"
          tabIndex={0}
          className="ml-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full opacity-50 transition-all hover:scale-110 hover:opacity-100"
          title="退出房间"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
          }}
        >
          <X className="h-3 w-3 text-[var(--md-sys-color-on-surface)]" />
        </span>
      </button>
    </div>
  )
}
