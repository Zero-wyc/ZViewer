import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import type { TrackChangePayload, TrackChangeHandler } from '../types'
import { SOCKET_EVENT } from '../constants'

export interface UseTrackSyncOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
}

export interface UseTrackSyncReturn {
  /** 房主：广播弹幕轨道切换 */
  broadcastDanmakuTrackChange: (trackId: string | null) => void
  /** 房主：广播字幕轨道切换 */
  broadcastSubtitleTrackChange: (trackIndex: number | null) => void
  /** 房主用别名：等价于 broadcastSubtitleTrackChange */
  setSubtitleTrackIndex: (trackIndex: number | null) => void
  /** 当前字幕轨道索引（null 表示关闭字幕） */
  subtitleTrackIndex: number | null
  /** 当前弹幕轨道 ID（null 表示关闭弹幕） */
  danmakuTrackId: string | null
  /** 观众：注册弹幕轨道变化回调，返回取消订阅函数 */
  onDanmakuTrackChange: (handler: TrackChangeHandler<string>) => () => void
  /** 观众：注册字幕轨道变化回调，返回取消订阅函数 */
  onSubtitleTrackChange: (handler: TrackChangeHandler<number>) => () => void
}

/**
 * 轨道同步 Hook（合并弹幕与字幕）：统一处理 `track-change` 事件的广播与接收。
 *
 * 协议精简（v2）：
 * - 合并旧 `danmaku-track-change` + `subtitle-track-change` → `track-change`
 * - payload: `{ type: 'danmaku' | 'subtitle', value: string | number | null }`
 * - 后端新增转发 handler（旧版未转发导致功能失效）
 *
 * 房主：
 * - `broadcastDanmakuTrackChange(trackId)` → emit `{ type: 'danmaku', value: trackId }`
 * - `broadcastSubtitleTrackChange(trackIndex)` → emit `{ type: 'subtitle', value: trackIndex }`
 *
 * 观众：
 * - `onDanmakuTrackChange(handler)` → 订阅弹幕轨道变化
 * - `onSubtitleTrackChange(handler)` → 订阅字幕轨道变化
 *
 * 内部维护 danmakuTrackId / subtitleTrackIndex 状态，
 * 收到房主广播时更新状态并通知所有订阅者。
 */
export function useTrackSync({
  roomId,
  isHostRef,
}: UseTrackSyncOptions): UseTrackSyncReturn {
  const { socket } = useSocket()

  const [danmakuTrackId, setDanmakuTrackId] = useState<string | null>(null)
  const [subtitleTrackIndex, setSubtitleTrackIndexState] = useState<
    number | null
  >(null)

  // 观众端订阅者集合：收到房主广播时回调
  const danmakuTrackChangeCallbacksRef = useRef<
    Set<TrackChangeHandler<string>>
  >(new Set())
  const subtitleTrackChangeCallbacksRef = useRef<
    Set<TrackChangeHandler<number>>
  >(new Set())

  // 房主：广播弹幕轨道切换
  const broadcastDanmakuTrackChange = useCallback(
    (trackId: string | null) => {
      setDanmakuTrackId(trackId)
      if (!socket || !isHostRef.current) return
      const payload: TrackChangePayload = {
        type: 'danmaku',
        value: trackId,
      }
      socket.emit(SOCKET_EVENT.TRACK_CHANGE, { roomId, ...payload })
    },
    [socket, roomId, isHostRef]
  )

  // 房主：广播字幕轨道切换
  const broadcastSubtitleTrackChange = useCallback(
    (trackIndex: number | null) => {
      setSubtitleTrackIndexState(trackIndex)
      if (!socket || !isHostRef.current) return
      const payload: TrackChangePayload = {
        type: 'subtitle',
        value: trackIndex,
      }
      socket.emit(SOCKET_EVENT.TRACK_CHANGE, { roomId, ...payload })
    },
    [socket, roomId, isHostRef]
  )

  // 房主用别名：等价于 broadcastSubtitleTrackChange
  const setSubtitleTrackIndex = broadcastSubtitleTrackChange

  // 观众：注册弹幕轨道变化订阅
  const onDanmakuTrackChange = useCallback(
    (handler: TrackChangeHandler<string>) => {
      danmakuTrackChangeCallbacksRef.current.add(handler)
      return () => {
        danmakuTrackChangeCallbacksRef.current.delete(handler)
      }
    },
    []
  )

  // 观众：注册字幕轨道变化订阅
  const onSubtitleTrackChange = useCallback(
    (handler: TrackChangeHandler<number>) => {
      subtitleTrackChangeCallbacksRef.current.add(handler)
      return () => {
        subtitleTrackChangeCallbacksRef.current.delete(handler)
      }
    },
    []
  )

  // 观众端：监听合并后的 track-change 事件，按 type 分发到对应订阅者
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleTrackChange = (payload: TrackChangePayload) => {
      if (!payload || typeof payload.type !== 'string') return
      if (payload.type === 'danmaku') {
        // 弹幕轨道 ID 为 string；非 string 值统一降级为 null（关闭弹幕）
        const trackId: string | null =
          typeof payload.value === 'string' ? payload.value : null
        setDanmakuTrackId(trackId)
        danmakuTrackChangeCallbacksRef.current.forEach((cb) => cb(trackId))
      } else if (payload.type === 'subtitle') {
        // 字幕轨道索引为 number；非 number 值统一降级为 null（关闭字幕）
        const trackIndex: number | null =
          typeof payload.value === 'number' ? payload.value : null
        setSubtitleTrackIndexState(trackIndex)
        subtitleTrackChangeCallbacksRef.current.forEach((cb) => cb(trackIndex))
      }
    }
    socket.on(SOCKET_EVENT.TRACK_CHANGE, handleTrackChange)

    return () => {
      socket.off(SOCKET_EVENT.TRACK_CHANGE, handleTrackChange)
    }
  }, [socket, isHostRef])

  return {
    broadcastDanmakuTrackChange,
    broadcastSubtitleTrackChange,
    setSubtitleTrackIndex,
    subtitleTrackIndex,
    danmakuTrackId,
    onDanmakuTrackChange,
    onSubtitleTrackChange,
  }
}
