import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { getBilibiliParseOptions } from '@/modules/bilibili/parseOptions'
import type { WatchTogetherState, ControlAction } from '../types'
import { SOCKET_EVENT } from '../constants'
import {
  buildStateFromVideo,
  isStateEqual,
  computeStateDiff,
} from '../services'

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
  // 广播序号：每次广播递增。观众检测跳号（seq > lastSeq + 1）即说明错失了
  // 中间广播（socket 重连窗口），主动请求全量状态自愈——避免 diff 合并基线
  // 错位导致的字段静默发散。
  const seqRef = useRef(0)

  const broadcastState = useCallback(
    (state: WatchTogetherState) => {
      if (!socket || !isHostRef.current) return
      // 注入房主 CLI 标记：让观众知道房主是否启用了 CLI 高画质代理，
      // 从而决定是否需要强制走 MP4（观众无法使用房主的 CLI 代理）
      const movieId = useRoomStore.getState().currentMovieId
      const stateWithCli: WatchTogetherState = {
        ...state,
        hostCliEnabled:
          movieId != null
            ? getBilibiliParseOptions(movieId).cliEnabled
            : state.hostCliEnabled,
      }
      // 浅比较跳过等价状态：房主正常播放时 currentTime 增长 < 0.5s 不广播
      if (isStateEqual(lastStateRef.current, stateWithCli)) return
      // 计算增量（P1-Opt#7）：观众端合并 diff 到现有 state，减少全量替换
      const diff = computeStateDiff(lastStateRef.current, stateWithCli)
      lastStateRef.current = stateWithCli
      seqRef.current += 1
      socket.emit(SOCKET_EVENT.STATE, {
        roomId,
        state: stateWithCli,
        diff,
        seq: seqRef.current,
        // 发送时刻时间戳：服务端据此补偿传输延迟，使持久化基线锚定服务器时间轴
        clientTs: Date.now(),
      })
    },
    [socket, roomId, isHostRef]
  )

  const sendControl = useCallback(
    (action: ControlAction, value?: number) => {
      if (!socket || !isHostRef.current) return
      socket.emit(SOCKET_EVENT.CONTROL, {
        roomId,
        action,
        value,
        clientTs: Date.now(),
      })
    },
    [socket, roomId, isHostRef]
  )

  const forceSync = useCallback(() => {
    if (!socket || !isHostRef.current) return
    const video = videoRef.current
    const storeState = useRoomStore.getState().watchTogether
    const newState = buildStateFromVideo(video, storeState)
    // 注入房主 CLI 标记（与 broadcastState 一致）
    const movieId = useRoomStore.getState().currentMovieId
    if (movieId != null) {
      newState.hostCliEnabled = getBilibiliParseOptions(movieId).cliEnabled
    }
    // forceSync 总是广播，跳过浅比较；seq 递增以触发观众端无条件全量应用
    lastStateRef.current = newState
    seqRef.current += 1
    socket.emit(SOCKET_EVENT.STATE, {
      roomId,
      state: newState,
      seq: seqRef.current,
      clientTs: Date.now(),
    })
  }, [socket, roomId, isHostRef, videoRef])

  return {
    broadcastState,
    sendControl,
    forceSync,
  }
}
