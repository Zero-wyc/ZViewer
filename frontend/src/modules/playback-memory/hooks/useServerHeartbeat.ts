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
 * - 卡死自愈看门狗：房主播放中而本地进度 15s 零推进时自动重载视频（30s 冷却），
 *   避免 2s 心跳反复硬 seek 造成的无限转圈
 * - 房主离线（host-disconnected）后观众进入自主控制模式，不再应用服务器心跳
 * - 监听 host-disconnected 仅显示提示，不暂停
 * - 检测 URL 过期后暂停并提示
 */
import { useEffect, useRef, useCallback } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState } from '@/modules/sync-playback/types'
import type { SyncHeartbeatPayload } from '@/modules/sync-playback/types'
import {
  SOCKET_EVENT,
  CHECK_STATUS_INTERVAL_MS,
} from '@/modules/sync-playback/constants'
import { safePlay } from '@/modules/sync-playback/safePlay'
import {
  executeSeek,
  shouldSoftSync,
  getCatchUpRate,
  getAdaptiveSeekThreshold,
} from '@/modules/sync-playback/services'
import type { SeekToResult } from '@/modules/sync-playback/services'
import type { ServerHeartbeatPayload, CheckStatusAckData } from '../types'
import {
  isBilibiliUrlExpired,
  isVideoSourceExpired,
} from '../services/url-expiry'

export interface UseServerHeartbeatOptions {
  /** 房间 ID（自检上报需要，服务端据此校验在房） */
  roomId: string
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
  roomId,
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
  // 卡死看门狗：本地进度零推进检测（lastTime + 最近一次推进时刻 + 最近一次自动重载时刻）
  const stallWatchRef = useRef({
    lastTime: -1,
    lastAdvancedAt: 0,
    lastReloadAt: 0,
  })
  // 因事件抑制被跳过的心跳计数（可观测性：抑制泄漏时暴露问题）
  const suppressedSkipCountRef = useRef(0)

  // 处理服务器心跳：更新本地状态
  const handleServerHeartbeat = useCallback(
    (payload: ServerHeartbeatPayload) => {
      // 缓冲下载期间跳过：useViewerStateSync/usePlaybackStateRequest 在下载时
      // 设置 suppressEventsRef=true，若此处提前释放会破坏下载期间的抑制标记，
      // 导致旧源触发的 video 事件回环。下载完成后下一帧心跳会自然应用最新状态。
      if (suppressEventsRef.current) {
        // 可观测性：源切换/缓冲下载期间跳过属正常；若持续累计（超过抑制租约
        // 上限 5min）说明存在 acquire/release 不配对泄漏，校正链会被静默拦截
        // （症状：观众不再跟随房主，仅换源广播/刷新页面能恢复）。
        suppressedSkipCountRef.current += 1
        if (suppressedSkipCountRef.current % 15 === 0) {
          console.warn(
            `[useServerHeartbeat] 已连续 ${suppressedSkipCountRef.current} 次心跳因事件抑制被跳过（约 ${suppressedSkipCountRef.current * 2}s）——若非源切换/缓冲下载期间出现，请检查抑制配对`
          )
        }
        return
      }
      if (suppressedSkipCountRef.current > 0) {
        suppressedSkipCountRef.current = 0
      }

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

      // ②.5 卡死自愈看门狗：房主在播而本地进度持续零推进（非暂停 / 非 seeking /
      // 非重载中）达 15s，判定播放管线卡死（引擎停摆 / 数据饥饿 / 解码异常），
      // 直接 reloadVideo 重建引擎自愈——等价于用户手动「重载视频」，避免
      // 2s 心跳反复硬 seek 期间的无限转圈。30s 冷却防止不可恢复场景（如 URL
      // 失效）下频繁重建；暂停/seeking 期间持续刷新计时，恢复播放后重新计数。
      if (state.isPlaying && !video.paused && !video.seeking) {
        const watch = stallWatchRef.current
        const now = Date.now()
        if (Math.abs(video.currentTime - watch.lastTime) > 0.05) {
          watch.lastTime = video.currentTime
          watch.lastAdvancedAt = now
        }
        if (
          watch.lastAdvancedAt > 0 &&
          now - watch.lastAdvancedAt > 15000 &&
          now - watch.lastReloadAt > 30000 &&
          !isReloadingRef.current
        ) {
          watch.lastReloadAt = now
          watch.lastAdvancedAt = now
          console.warn(
            '[useServerHeartbeat] 房主播放中但本地进度 15s 无推进，自动重载视频自愈'
          )
          void reloadVideo(video)
          return
        }
      } else {
        stallWatchRef.current.lastTime = video.currentTime
        stallWatchRef.current.lastAdvancedAt = Date.now()
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
        // 持续校正房主离线标记（必须在 handleServerHeartbeat 的 hostOffline
        // 早退守卫之前执行）：服务器心跳恒定广播，携带的 hostOnline 覆盖
        // 「观众在房主离线后才加入/刷新/socket 重连而错过 host-disconnected
        // 事件」的场景——否则观众误以为房主在线，暂停操作每 2s 被心跳的
        // isPlaying=true 拉回播放（无法暂停 bug）。
        // hostOnline=true 时恢复跟随（错过 sharer-ready 的兜底），并设置
        // 重连过渡标记让恢复后的首次校正是平滑的（P3-Opt#15 同路径）。
        if (payload.hostOnline === false && !hostOfflineRef.current) {
          hostOfflineRef.current = true
          hostLeftNotifiedRef.current = false
          useRoomStore.getState().setHostOffline(true)
          message.info('房主已离开，您可以自主控制播放')
        } else if (payload.hostOnline === true && hostOfflineRef.current) {
          hostOfflineRef.current = false
          hostLeftNotifiedRef.current = false
          urlExpiredRef.current = false
          reconnectTransitionRef.current = true
          useRoomStore.getState().setHostOffline(false)
        }
        handleServerHeartbeat({ roomId: '', state: payload.state })
      }
    }
    socket.on(SOCKET_EVENT.SYNC_HEARTBEAT, handleSyncHeartbeat)

    return () => {
      socket.off(SOCKET_EVENT.SYNC_HEARTBEAT, handleSyncHeartbeat)
    }
  }, [socket, isHostRef, handleServerHeartbeat])

  // 观众主动自检（CHECK_STATUS，Step 3）：每 10s 上报本地播放状态，
  // 服务端与权威推算状态比对（±10s 容差），分歧超限通过 ack 下发权威进度。
  // 作为服务器心跳（2s）丢失（socket 重连窗口 / 网络抖动）时的自愈通道；
  // 正常情况下自检不会触发纠偏（容差远大于心跳校正阈值 3s/6s）。
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const checkInFlightRef = { current: false }

    const intervalId = setInterval(() => {
      const video = videoRef.current
      // 守卫：源未就绪 / 抑制期（源切换、缓冲下载）/ 自主控制 / 过期 / seek 进行中 / 上一查在途
      if (!video || !video.currentSrc) return
      if (suppressEventsRef.current) return
      if (hostOfflineRef.current) return
      if (urlExpiredRef.current) return
      if (isReloadingRef.current) return
      if (video.seeking) return
      if (checkInFlightRef.current) return
      checkInFlightRef.current = true

      socket.emit(
        SOCKET_EVENT.CHECK_STATUS,
        {
          roomId,
          currentTime: video.currentTime,
          isPlaying: !video.paused,
          playbackRate: video.playbackRate,
          clientTs: Date.now(),
        },
        (response: { success: boolean; data?: CheckStatusAckData | null }) => {
          checkInFlightRef.current = false
          if (!response?.success || !response.data?.needsSync) return
          const state = response.data.state
          if (!state) return
          // ack 等待期间可能进入抑制 / 自主控制，应用前再校验一次
          if (suppressEventsRef.current || hostOfflineRef.current) return
          // 复用服务器心跳的校正路径（两阶段软同步 / 硬 seek）
          handleServerHeartbeat({ roomId: '', state })
        }
      )
    }, CHECK_STATUS_INTERVAL_MS)

    return () => {
      clearInterval(intervalId)
    }
  }, [
    socket,
    isHostRef,
    videoRef,
    suppressEventsRef,
    roomId,
    handleServerHeartbeat,
  ])

  // 监听 host-disconnected：仅提示，不暂停播放
  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleHostDisconnected = () => {
      hostOfflineRef.current = true
      useRoomStore.getState().setHostOffline(true)
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
      useRoomStore.getState().setHostOffline(false)
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
