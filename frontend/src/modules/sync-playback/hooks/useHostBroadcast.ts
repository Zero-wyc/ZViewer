import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState, ControlAction } from '../types'
import { SOCKET_EVENT } from '../constants'
import { buildStateFromVideo, isStateEqual } from '../services'

export interface UseHostBroadcastOptions {
  roomId: string
  isHostRef: RefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
}

export interface UseHostBroadcastReturn {
  broadcastState: (state: WatchTogetherState) => void
  sendControl: (action: ControlAction, value?: number) => void
  forceSync: () => void
}

/**
 * 房主广播 Hook：负责向房间内观众广播完整播放状态与离散控制指令。
 *
 * - `broadcastState(state)`：广播完整状态。内部用 `isStateEqual` 浅比较跳过等价状态，
 *   避免房主正常播放时（currentTime 自然增长）每 500ms 都触发广播。
 * - `sendControl(action, value?)`：发送 play/pause/seek/rate 控制指令，
 *   提供亚 500ms 的即时响应（state 节流无法满足）。
 * - `forceSync()`：强制广播当前 video 元素 + store 的最新状态，
 *   用于"手动同步"按钮或清晰度切换后立即推送。内部使用 `buildStateFromVideo` 构建状态。
 *
 * 该 Hook 仅声明函数，不绑定副作用；事件监听由 useVideoEventBindings 负责。
 */
export function useHostBroadcast({
  roomId,
  isHostRef,
  videoRef,
}: UseHostBroadcastOptions): UseHostBroadcastReturn {
  const { socket } = useSocket()
  // 最近一次广播的状态：用于浅比较跳过等价广播
  const lastStateRef = useRef<WatchTogetherState | null>(null)

  const broadcastState = useCallback(
    (state: WatchTogetherState) => {
      if (!socket || !isHostRef.current) return
      // 浅比较跳过等价状态：房主正常播放时 currentTime 增长 < 0.5s 不广播
      if (isStateEqual(lastStateRef.current, state)) return
      lastStateRef.current = state
      socket.emit(SOCKET_EVENT.STATE, { roomId, state })
    },
    [socket, roomId, isHostRef]
  )

  const sendControl = useCallback(
    (action: ControlAction, value?: number) => {
      if (!socket || !isHostRef.current) return
      socket.emit(SOCKET_EVENT.CONTROL, { roomId, action, value })
    },
    [socket, roomId, isHostRef]
  )

  const forceSync = useCallback(() => {
    if (!socket || !isHostRef.current) return
    const video = videoRef.current
    const storeState = useRoomStore.getState().watchTogether
    const newState = buildStateFromVideo(video, storeState)
    // forceSync 总是广播，跳过浅比较
    lastStateRef.current = newState
    socket.emit(SOCKET_EVENT.STATE, { roomId, state: newState })
  }, [socket, roomId, isHostRef, videoRef])

  return {
    broadcastState,
    sendControl,
    forceSync,
  }
}
