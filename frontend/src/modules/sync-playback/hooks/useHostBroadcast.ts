import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState, ControlAction } from '../types'
import { SOCKET_EVENT } from '../constants'

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
 * 浅比较两个 WatchTogetherState 是否等价。
 *
 * 旧实现使用 `JSON.stringify(state) === JSON.stringify(lastStateRef.current)`
 * 进行双次序列化对比，每秒触发 4 次（timeupdate ~250ms），在大 state 对象上
 * 产生明显 GC 压力。改用字段级浅比较后性能更优且语义更清晰。
 *
 * acceptQuality 是数组，单独按引用 + 长度 + qn 字段比较，避免每次都序列化。
 */
function isStateEqual(
  a: WatchTogetherState | null,
  b: WatchTogetherState
): boolean {
  if (!a) return false
  if (a === b) return true
  // 源字段
  if (
    a.sourceUrl !== b.sourceUrl ||
    a.sourceType !== b.sourceType ||
    a.audioUrl !== b.audioUrl ||
    a.format !== b.format ||
    a.videoCodec !== b.videoCodec ||
    a.audioCodec !== b.audioCodec ||
    a.cid !== b.cid
  )
    return false
  // 播放字段
  if (
    a.isPlaying !== b.isPlaying ||
    a.playbackRate !== b.playbackRate ||
    a.duration !== b.duration
  )
    return false
  // currentTime 单独处理：允许小幅差异（< 0.5s）视为相同，
  // 避免房主正常播放时每 500ms 都触发广播（自然进度差 ~0.5s）。
  if (Math.abs(a.currentTime - b.currentTime) > 0.5) return false
  // B站 清晰度字段
  if (a.currentQn !== b.currentQn) return false
  // acceptQuality 浅比较
  const aqA = a.acceptQuality
  const aqB = b.acceptQuality
  if (aqA === aqB) return true
  if (!aqA || !aqB || aqA.length !== aqB.length) return false
  for (let i = 0; i < aqA.length; i++) {
    if (aqA[i].id !== aqB[i].id || aqA[i].label !== aqB[i].label) return false
  }
  return true
}

/**
 * 房主广播 Hook：负责向房间内观众广播完整播放状态与离散控制指令。
 *
 * - `broadcastState(state)`：广播完整状态。内部用浅比较跳过等价状态，
 *   避免房主正常播放时（currentTime 自然增长）每 500ms 都触发广播。
 * - `sendControl(action, value?)`：发送 play/pause/seek/rate 控制指令，
 *   提供亚 500ms 的即时响应（state 节流无法满足）。
 * - `forceSync()`：强制广播当前 video 元素 + store 的最新状态，
 *   用于"手动同步"按钮或清晰度切换后立即推送。
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
    const state = useRoomStore.getState().watchTogether
    const hasLoadedSource = video && video.currentSrc !== ''
    const newState: WatchTogetherState = {
      sourceUrl: state.sourceUrl,
      sourceType: state.sourceType,
      audioUrl: state.audioUrl,
      format: state.format,
      videoCodec: state.videoCodec,
      audioCodec: state.audioCodec,
      cid: state.cid,
      isPlaying: hasLoadedSource ? !video.paused : state.isPlaying,
      currentTime: hasLoadedSource ? video.currentTime : state.currentTime,
      playbackRate: hasLoadedSource ? video.playbackRate : state.playbackRate,
      duration: hasLoadedSource
        ? video.duration || state.duration
        : state.duration,
      // Bug #12 修复：补齐 currentQn / acceptQuality 字段，
      // 否则观众端 syncFromState 会清空清晰度 UI 显示
      currentQn: state.currentQn,
      acceptQuality: state.acceptQuality,
    }
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
