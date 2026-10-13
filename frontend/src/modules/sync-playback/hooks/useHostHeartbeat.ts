import { useEffect } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import type { HeartbeatPayload } from '../types'
import { SOCKET_EVENT, HEARTBEAT_INTERVAL_MS } from '../constants'
import { buildStateFromVideo } from '../services'

export interface UseHostHeartbeatOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  /** 事件抑制 ref：suppress 期间不广播心跳 */
  suppressEventsRef: MutableRefObject<boolean>
}

export type UseHostHeartbeatReturn = void

/**
 * 房主心跳广播 Hook：每 `HEARTBEAT_INTERVAL_MS`（默认 5s）向房间广播一次
 * `host-heartbeat` 事件，携带当前播放进度与播放状态。
 *
 * v3 重构：
 * - 间隔从 2s 提升至 5s，降低高频广播带来的网络压力与观众端卡顿
 * - suppressEventsRef 期间不广播，避免源切换/恢复进度期间发送错误心跳
 * - 心跳为轻量事件（仅 currentTime + isPlaying），观众端据此校正进度漂移
 *
 * 观众端不再直接消费该心跳（Step 2 服务器权威化）：
 * 后端将心跳合并进播放记忆基线（applyHostHeartbeat，含传输延迟补偿），
 * 由服务器每 2s 恒定广播 sync-heartbeat(source='server') 作为观众进度的
 * 唯一权威来源；观众端进度校正统一在 useServerHeartbeat 中处理。
 */
export function useHostHeartbeat({
  roomId,
  isHostRef,
  videoRef,
  suppressEventsRef,
}: UseHostHeartbeatOptions): UseHostHeartbeatReturn {
  const { socket } = useSocket()

  useEffect(() => {
    if (!socket || !isHostRef.current) return

    const intervalId = setInterval(() => {
      const video = videoRef.current
      const storeState = useRoomStore.getState().watchTogether
      // 使用 buildStateFromVideo 构建完整 state，但心跳仅发送轻量字段
      // 完整 state 通过离散事件 + watch-together-state 广播
      const built = buildStateFromVideo(video, storeState)

      if (suppressEventsRef.current) {
        // suppress 期间（源切换/恢复进度）仍发送存活心跳（带 suppressed 标记），
        // 让观众端能重置"房主离线"计时器，避免误报离线。
        // 观众端收到 suppressed 标记时不会同步状态，仅更新离线计时。
        const alivePayload: HeartbeatPayload = {
          currentTime: built.currentTime,
          isPlaying: built.isPlaying,
          playbackRate: built.playbackRate,
        }
        socket.emit(SOCKET_EVENT.HOST_HEARTBEAT, {
          roomId,
          ...alivePayload,
          suppressed: true,
          clientTs: Date.now(),
        })
        return
      }
      const payload: HeartbeatPayload = {
        currentTime: built.currentTime,
        isPlaying: built.isPlaying,
        playbackRate: built.playbackRate,
      }
      // clientTs：服务端据此补偿传输延迟后再合并进播放记忆基线
      socket.emit(SOCKET_EVENT.HOST_HEARTBEAT, {
        roomId,
        ...payload,
        clientTs: Date.now(),
      })
    }, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [socket, roomId, videoRef, isHostRef, suppressEventsRef])
}
