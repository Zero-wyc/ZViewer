/**
 * useHostSync Hook
 *
 * 房主侧同步编排 Hook：组合所有房主需要的同步子 hook，提供统一入口。
 *
 * 组合的子 hook：
 * - useHostBroadcast: 状态广播 + 控制指令 + forceSync
 * - useHostStateRequest: 响应观众的状态请求
 * - useHostHeartbeat: 定时广播心跳
 * - useVideoEventBindings: video 元素事件 → 广播
 *
 * 调用方（useWatchTogether）只需调用一次 useHostSync 即可启用所有房主同步逻辑，
 * 无需分别调用 4 个子 hook。
 *
 * 返回值与 useHostBroadcast 一致（broadcastState / sendControl / forceSync），
 * 因为这些是 useWatchTogether 需要调用的主动 API；其他子 hook 仅产生副作用。
 */
import type { RefObject, MutableRefObject } from 'react'
import type { WatchTogetherState, ControlAction } from '../types'
import { useHostBroadcast } from './useHostBroadcast'
import { useHostStateRequest } from './useHostStateRequest'
import { useHostHeartbeat } from './useHostHeartbeat'
import { useVideoEventBindings } from './useVideoEventBindings'

export interface UseHostSyncOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
}

export interface UseHostSyncReturn {
  broadcastState: (state: WatchTogetherState) => void
  sendControl: (action: ControlAction, value?: number) => void
  forceSync: () => void
}

export function useHostSync({
  roomId,
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
}: UseHostSyncOptions): UseHostSyncReturn {
  const { broadcastState, sendControl, forceSync } = useHostBroadcast({
    roomId,
    isHostRef,
    videoRef,
  })

  useHostStateRequest({ roomId, isHostRef, videoRef })
  useHostHeartbeat({ roomId, isHostRef, videoRef })
  useVideoEventBindings({
    isHostRef,
    videoRef,
    suppressEventsRef,
    setWatchTogether,
    broadcastState,
    sendControl,
  })

  return { broadcastState, sendControl, forceSync }
}
