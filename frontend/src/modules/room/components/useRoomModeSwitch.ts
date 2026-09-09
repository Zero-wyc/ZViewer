/**
 * 房间模式切换（房主）：emit update-room-mode + ack / 超时 / 断线兜底。
 * 从 RoomLayout 上移为页面级 hook：滑块既渲染在 RoomLayout 顶栏
 * （一起看/投屏），也可注入音乐顶导航（一起听，经 MusicTopNav 的
 * modeSwitchSlot 插槽），两处共用同一份切换状态与事件监听。
 * 独立成文件以满足 react-refresh/only-export-components（组件文件
 * 只能导出组件，hook 需单独放置）。
 */
import { useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { useRoomStore, type RoomMode } from '@/store/roomStore'

export const MODE_LABELS: Record<RoomMode, string> = {
  'watch-together': '一起看',
  'screen-share': '投屏',
  'listen-together': '一起听',
}

/** 滑块选项顺序（一起看 → 投屏 → 一起听） */
export const MODE_ORDER: RoomMode[] = [
  'watch-together',
  'screen-share',
  'listen-together',
]

export function useRoomModeSwitch(
  socket: Socket | null,
  roomId: string,
  isHost: boolean
) {
  const roomMode = useRoomStore((state) => state.mode)
  const setMode = useRoomStore((state) => state.setMode)
  // 模式切换加载占位：房主点击切换后等待后端确认期间显示 Spinner
  const [isModeSwitching, setIsModeSwitching] = useState(false)

  // 用于保护模式切换过程中的竞态：记录当前请求的 id 与超时定时器
  const switchingRef = useRef<{
    id: number
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)

  // 监听 room-mode-changed：观众端跟随房主切换无需刷新；
  // 同时清除本地加载占位（房主切换完成后）。
  useEffect(() => {
    if (!socket) return

    const handleRoomModeChanged = (data: { mode: RoomMode }) => {
      setMode(data.mode)
      setIsModeSwitching(false)
    }

    const handleDisconnect = () => {
      if (switchingRef.current) {
        if (switchingRef.current.timer) {
          clearTimeout(switchingRef.current.timer)
        }
        switchingRef.current = null
        setIsModeSwitching(false)
        message.error('连接已断开，请刷新页面后重试')
      }
    }

    socket.on('room-mode-changed', handleRoomModeChanged)
    socket.on('disconnect', handleDisconnect)

    return () => {
      if (switchingRef.current?.timer) {
        clearTimeout(switchingRef.current.timer)
      }
      switchingRef.current = null
      setIsModeSwitching(false)
      socket.off('room-mode-changed', handleRoomModeChanged)
      socket.off('disconnect', handleDisconnect)
    }
  }, [socket, setMode])

  const handleSwitchMode = (targetMode: RoomMode) => {
    if (!socket || !isHost || targetMode === roomMode || isModeSwitching) {
      return
    }

    const nextId = (switchingRef.current?.id ?? 0) + 1
    if (switchingRef.current?.timer) {
      clearTimeout(switchingRef.current.timer)
    }
    switchingRef.current = { id: nextId, timer: null }
    setIsModeSwitching(true)

    const timer = setTimeout(() => {
      if (switchingRef.current?.id === nextId) {
        switchingRef.current = null
        setIsModeSwitching(false)
        message.error('切换超时，请重试')
      }
    }, 5000)

    switchingRef.current.timer = timer

    socket.emit(
      'update-room-mode',
      { roomId, mode: targetMode },
      (response: {
        success: boolean
        message?: string
        data?: { mode?: RoomMode }
      }) => {
        if (switchingRef.current?.id !== nextId) {
          return
        }
        if (switchingRef.current.timer) {
          clearTimeout(switchingRef.current.timer)
        }
        switchingRef.current = null

        // 后端 AckResponse 标准格式：mode 在 data 字段内
        const mode = response.data?.mode
        if (response.success && mode) {
          setMode(mode)
        } else {
          message.error(response.message ?? '切换模式失败')
        }
        setIsModeSwitching(false)
      }
    )
  }

  return { isModeSwitching, handleSwitchMode }
}
