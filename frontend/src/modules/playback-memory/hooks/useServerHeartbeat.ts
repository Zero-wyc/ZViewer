/**
 * useServerHeartbeat Hook
 *
 * 订阅服务器心跳事件（sync-heartbeat source='server'）——观众进度的唯一权威来源。
 *
 * 演进：
 * - 旧架构：房主每 2s 广播 host-heartbeat，房主断开后观众 6s 超时暂停。
 * - 中间态：服务器仅在房主离线时广播 server-heartbeat 接管。
 * - 当前（Step 2，服务器权威化）：服务器每 2s 恒定广播（房主在线/离线同一路径），
 *   观众进度校正统一走服务器推算值；房主侧 watch-together-state / control
 *   降级为「源信息 + 即时操作事件」通道。
 *
 * 行为：
 * - 收到 server-heartbeat 时，做两阶段自适应进度校正（软同步倍速追赶 / 硬 seek）
 * - 房主离线（host-disconnected）后观众进入自主控制模式，不再应用服务器心跳
 * - 监听 host-disconnected 仅显示提示，不暂停
 * - 检测 URL 过期后暂停并提示
 */
import { useEffect, useRef, useCallback } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import type { WatchTogetherState } from '@/modules/sync-playback/types'
import { SOCKET_EVENT } from '@/modules/sync-playback/constants'
import type { SyncHeartbeatPayload } from '@/modules/sync-playback/types'
import { safePlay } from '@/modules/sync-playback/safePlay'
import {
  executeSeek,
  shouldSoftSync,
  getCatchUpRate,
  getAdaptiveSeekThreshold,
} from '@/modules/sync-playback/services'
import type { SeekToResult } from '@/modules/sync-playback/services'
import type { ServerHeartbeatPayload } from '../types'
import {
  isBilibiliUrlExpired,
  isVideoSourceExpired,
} from '../services/url-expiry'

export interface UseServerHeartbeatOptions {
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
  /** 当前播放状态（用于 URL 过期检测） */
  watchTogether: WatchTogetherState
  /** seek 到目标时间（MSE 流不重建 MediaSource，由 useVideoSource 提供） */
  seekTo: (video: HTMLVideoElement, targetTime: number) => Promise<SeekToResult>
  /** MSE seek 失败时调用（如 video.error），用 forceReload 重新加载 */
  reloadVideo: (video: HTMLVideoElement) => Promise<void>
}

export type UseServerHeartbeatReturn = void

/**
 * 判断两个状态除进度字段（currentTime）外是否等价。
 * 用于服务器心跳时跳过无意义的 setWatchTogether（避免每 2s 无谓重渲染）：
 * 进度由视频元素自身的播放自然推进，store 中的 currentTime 仅在
 * 非进度字段变化（换源/播放状态/倍速/清晰度等）时才需要更新。
 */
function isSameExceptProgress(
  a: WatchTogetherState,
  b: WatchTogetherState
): boolean {
  const keys = new Set([
    ...(Object.keys(a) as (keyof WatchTogetherState)[]),
    ...(Object.keys(b) as (keyof WatchTogetherState)[]),
  ])
  for (const key of keys) {
    if (key === 'currentTime') continue
    if (a[key] !== b[key]) return false
  }
  return true
}

export function useServerHeartbeat({
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  watchTogether,
  seekTo,
  reloadVideo,
}: UseServerHeartbeatOptions): UseServerHeartbeatReturn {
  const { socket } = useSocket()
  // 防止重复提示"房主已离开"
  const hostLeftNotifiedRef = useRef(false)
  // 房主离线标记：房主离开后观众进入自主控制模式，不再应用服务器心跳
  const hostOfflineRef = useRef(false)
  // 房主重连过渡标记：重连后首次心跳判断是否需平滑同步（P3-Opt#15）
  const reconnectTransitionRef = useRef(false)
  // 重连后延迟 seek 的定时器 ref
  const reconnectSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  // URL 过期状态标记
  const urlExpiredRef = useRef(false)
  // 已处理的 video error 签名，避免同一个 error 重复触发过期提示
  const lastErrorSignatureRef = useRef<string | null>(null)
  // 缓存最新的 watchTogether 供 callback 读取
  const watchTogetherRef = useRef(watchTogether)
  useEffect(() => {
    watchTogetherRef.current = watchTogether
  }, [watchTogether])
  // 软同步追赶进行中标记（P2-Opt#9 策略移植自旧 host 心跳路径）
  const catchUpActiveRef = useRef(false)
  // 硬 seek 并发锁（executeSeek 要求）
  const isReloadingRef = useRef(false)

  // 处理服务器心跳：更新本地状态
  const handleServerHeartbeat = useCallback(
    (payload: ServerHeartbeatPayload) => {
      // 缓冲下载期间跳过：useViewerStateSync/usePlaybackStateRequest 在下载时
      // 设置 suppressEventsRef=true，若此处提前释放会破坏下载期间的抑制标记，
      // 导致旧源触发的 video 事件回环。下载完成后下一帧心跳会自然应用最新状态。
      if (suppressEventsRef.current) return

      // 房主离线后观众进入自主控制模式：不再应用服务器推算的播放状态，
      // 避免 isPlaying/currentTime 强制覆盖观众的 play/pause/seek 操作。
      // URL 过期检测由 video error 事件兜底。
      if (hostOfflineRef.current) return

      const state = payload.state
      const video = videoRef.current

      // P3-Opt#15：房主重连过渡——对比差异决定是否平滑同步
      if (reconnectTransitionRef.current) {
        reconnectTransitionRef.current = false
        if (video && !Number.isNaN(video.currentTime) && video.currentSrc) {
          const diff = Math.abs(video.currentTime - state.currentTime)
          if (diff > 10) {
            // 大幅差异：显示提示并延迟 2s 后 seek，避免突兀跳转
            message.info('房主已重连，即将同步进度，2 秒后自动同步')
            if (reconnectSyncTimerRef.current) {
              clearTimeout(reconnectSyncTimerRef.current)
            }
            reconnectSyncTimerRef.current = setTimeout(() => {
              try {
                video.currentTime = state.currentTime
              } catch {
                // ignore
              }
            }, 2000)
            // 放行其他状态同步（play/pause/rate），但跳过 currentTime seek
            suppressEventsRef.current = true
            setWatchTogether(state)
            if (state.isPlaying && video.paused) {
              void safePlay(video)
            } else if (!state.isPlaying && !video.paused) {
              video.pause()
            }
            if (video.playbackRate !== state.playbackRate) {
              video.playbackRate = state.playbackRate
            }
            suppressEventsRef.current = false
            return
          }
          // 小幅差异（≤10s）：走软同步逻辑，让余下代码自然处理
        }
      }

      // 更新 store：仅非进度字段变化时写入，进度由视频自然播放推进，
      // 避免每 2s 心跳的 currentTime 差异触发无谓的全量重渲染
      if (!isSameExceptProgress(watchTogetherRef.current, state)) {
        setWatchTogether(state)
      }

      if (!video) return

      // URL 过期后不再应用状态（等待房主重连）
      if (urlExpiredRef.current) {
        return
      }

      // 缓冲模式下视频从 blob URL 播放，state.sourceUrl（B站 CDN URL）的 deadline
      // 过期不影响实际播放，忽略 deadline 检测。
      // 此处仅通过 URL deadline 做严格过期判断；video.error 的兜底检测在 error
      // 事件监听中处理，避免 MSE/DASH 切换或 transient error 导致误报。
      const isBufferMode = state.bufferMode === true
      if (!isBufferMode && isBilibiliUrlExpired(state.sourceUrl)) {
        urlExpiredRef.current = true
        if (!video.paused) video.pause()
        message.warning('视频源已过期，等待房主重连')
        return
      }

      // ① 同步播放/暂停状态
      if (state.isPlaying && video.paused) {
        void safePlay(video)
      } else if (!state.isPlaying && !video.paused) {
        video.pause()
      }

      // ② 同步倍速（软同步追赶期间跳过，避免覆盖追赶倍速打断收敛）
      if (
        !catchUpActiveRef.current &&
        state.playbackRate > 0 &&
        video.playbackRate !== state.playbackRate
      ) {
        video.playbackRate = state.playbackRate
      }

      // ③ 两阶段自适应进度校正（服务器为进度权威，Step 2）：
      //    diff ≤ 自适应阈值 → 忽略，自然播放；
      //    阈值 < diff ≤ 硬 seek 阈值 且播放中 → 软同步倍速渐进追赶；
      //    diff > 硬 seek 阈值 → 硬 seek（走统一 executeSeek，MSE Range seek
      //    / 缓冲区检测 / 失败重载，与旧 host 心跳路径同策略）。
      const rate = state.playbackRate > 0 ? state.playbackRate : 1
      const diff = Math.abs(video.currentTime - state.currentTime)
      const threshold = getAdaptiveSeekThreshold(rate)

      if (diff <= threshold) {
        // 差异已收敛 → 结束软同步，恢复服务器权威基准倍速
        if (catchUpActiveRef.current) {
          catchUpActiveRef.current = false
          if (state.playbackRate > 0) {
            video.playbackRate = state.playbackRate
          }
        }
      } else if (
        state.isPlaying &&
        shouldSoftSync(video.currentTime, state.currentTime, rate)
      ) {
        // 软同步：小幅差异通过微调倍速追赶（暂停态无进度推进，不适用）
        if (!catchUpActiveRef.current) {
          catchUpActiveRef.current = true
        }
        const catchUpRate = getCatchUpRate(rate)
        if (video.playbackRate !== catchUpRate) {
          video.playbackRate = catchUpRate
        }
      } else {
        // 硬 seek：大幅差异直接跳转
        if (catchUpActiveRef.current) {
          catchUpActiveRef.current = false
        }
        void executeSeek({
          video,
          targetTime: state.currentTime,
          state,
          seekTo,
          suppressEventsRef,
          isReloadingRef,
          onSeekFailed: reloadVideo,
        }).then((didSeek) => {
          // 未触发 MSE seek 时执行普通 seek
          if (!didSeek) {
            suppressEventsRef.current = true
            try {
              video.currentTime = state.currentTime
            } catch {
              // ignore
            }
            suppressEventsRef.current = false
          }
        })
      }
    },
    [videoRef, suppressEventsRef, setWatchTogether, seekTo, reloadVideo]
  )

  // 订阅服务器心跳
  useEffect(() => {
    if (!socket || isHostRef.current) return

    // 统一心跳协议（#14）：只监听 sync-heartbeat（source='server'）。
    // 后端双发 server-heartbeat 与 sync-heartbeat，两者都绑定会导致
    // 每条心跳被处理两遍（setWatchTogether 双倍 notify → 渲染翻倍），故不绑旧事件。
    const handleSyncHeartbeat = (payload: SyncHeartbeatPayload) => {
      if (payload.source === 'server' && payload.state) {
        handleServerHeartbeat({ roomId: '', state: payload.state })
      }
    }
    socket.on(SOCKET_EVENT.SYNC_HEARTBEAT, handleSyncHeartbeat)

    return () => {
      socket.off(SOCKET_EVENT.SYNC_HEARTBEAT, handleSyncHeartbeat)
    }
  }, [socket, isHostRef, handleServerHeartbeat])

  // 监听 host-disconnected：仅提示，不暂停播放
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleHostDisconnected = () => {
      hostOfflineRef.current = true
      if (hostLeftNotifiedRef.current) return
      hostLeftNotifiedRef.current = true
      // 仅提示，不暂停播放（观众进入自主控制模式）
      message.info('房主已离开，您可以自主控制播放')
    }

    // 房主重连时重置标记（通过 sharer-ready 事件判断）
    const handleHostReconnect = () => {
      hostOfflineRef.current = false
      hostLeftNotifiedRef.current = false
      urlExpiredRef.current = false
      // P3-Opt#15：设置重连过渡标记，下次心跳判断是否需平滑同步
      reconnectTransitionRef.current = true
    }

    socket.on(SOCKET_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
    socket.on('sharer-ready', handleHostReconnect)

    return () => {
      socket.off(SOCKET_EVENT.HOST_DISCONNECTED, handleHostDisconnected)
      socket.off('sharer-ready', handleHostReconnect)
      // 清理重连延迟定时器
      if (reconnectSyncTimerRef.current) {
        clearTimeout(reconnectSyncTimerRef.current)
      }
    }
  }, [socket, isHostRef])

  // 切换视频源后重置过期标记与 error 签名，避免房主添加新视频或观众进入房间时
  // 被旧状态误拦截。
  useEffect(() => {
    urlExpiredRef.current = false
    lastErrorSignatureRef.current = null
  }, [watchTogether.sourceUrl])

  // 监听 video error 事件（URL 过期兜底检测）
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleError = () => {
      if (urlExpiredRef.current) return
      // attach / reload / seek 等操作期间 suppressEventsRef 为 true，此时产生的
      // transient error（如 resetVideoElement、切换 DASH/MP4 引擎）不应被判定为
      // URL 过期，避免误报。
      if (suppressEventsRef.current) return

      const error = video.error
      if (!error) return

      // 同一个 error 不重复处理（MSE/DASH 切换或重试时可能触发相同 error）
      const signature = `${error.code}-${error.message ?? ''}-${video.currentSrc}`
      if (lastErrorSignatureRef.current === signature) return
      lastErrorSignatureRef.current = signature

      const currentState = watchTogetherRef.current
      if (isVideoSourceExpired(currentState.sourceUrl, error, video)) {
        urlExpiredRef.current = true
        if (!video.paused) video.pause()
        message.warning('视频源已过期，等待房主重连')
      }
    }

    video.addEventListener('error', handleError)
    return () => {
      video.removeEventListener('error', handleError)
    }
  }, [videoRef, suppressEventsRef])
}
