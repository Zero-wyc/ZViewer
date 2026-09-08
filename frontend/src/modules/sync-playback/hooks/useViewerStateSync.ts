import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import type {
  WatchTogetherState,
  StatePayload,
  ControlPayload,
  SyncHeartbeatPayload,
} from '../types'
import { SOCKET_EVENT } from '../constants'
import { safePlay } from '../safePlay'
import {
  executeSeek,
  mergeStateDiff,
  shouldSoftSync,
  getCatchUpRate,
  getAdaptiveSeekThreshold,
} from '../services'
import type { SeekToResult } from '../services'
import {
  fetchBlobsForBufferMode,
  DownloadError,
  UrlExpiredError,
  DownloadAbortedError,
} from '@/modules/player/services/buffer-mode'

export interface UseViewerStateSyncOptions {
  roomId: string
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
  setWatchTogether: (state: WatchTogetherState) => void
  applySourceToVideo: (
    video: HTMLVideoElement,
    state: WatchTogetherState,
    startTime?: number,
    blobs?: { videoBlob: Blob; audioBlob: Blob }
  ) => Promise<void>
  /** seek 到目标时间（MSE 流不重建 MediaSource，由 useVideoSource 提供） */
  seekTo: (video: HTMLVideoElement, targetTime: number) => Promise<SeekToResult>
  /** MSE seek 失败时调用（如 video.error），用 forceReload 重新加载 */
  reloadVideo: (video: HTMLVideoElement) => Promise<void>
  /**
   * 已应用 sourceUrl 的共享 ref（由 useViewerSync 提升，与 usePlaybackStateRequest 共享）。
   * 观众首次加入时 usePlaybackStateRequest 完成 attach 后会写入此 ref，
   * 避免后续 useViewerStateSync 收到同 sourceUrl 的 state 时误判为 source 变化，
   * 重复触发 applySourceToVideo 覆盖已缓冲的 blob 源。
   */
  lastAppliedSourceUrlRef: MutableRefObject<string | null>
}

export type UseViewerStateSyncReturn = void

/**
 * 观众状态同步 Hook：接收房主的 `watch-together-state` 与 `watch-together-control` 事件，
 * 并应用到本地 video 元素。
 *
 * v3 重构（解决观众端频繁卡顿）：
 *
 * 1. **分离字段同步**：
 *    旧实现每次收到 state 都执行 applySourceToVideo + currentTime 设置 + play/pause，
 *    即使 sourceUrl / isPlaying / playbackRate 都没变也会强制设置 currentTime，
 *    导致视频每 500ms 被打断一次。
 *    新实现按字段变化类型决定操作：
 *    - sourceUrl 变化 → applySourceToVideo（含完整同步）
 *    - isPlaying 变化 → play/pause
 *    - playbackRate 变化 → 设置 playbackRate
 *    - currentTime 不再单独设置（由 host-heartbeat 校正）
 *
 * 2. **串行化 applySourceToVideo（Bug #8 修复）**：
 *    sourceUrl 变化时用 isApplyingRef 锁 + pendingStateRef 缓存最新 state，串行处理。
 *
 * 3. **进度校正由 host-heartbeat 驱动**：
 *    收到 state 时不再设置 currentTime，进度校正完全由 useViewerHeartbeat 处理
 *    （差异 > SEEK_FOLLOW_THRESHOLD=3s 才 seek，小差异让视频自然播放）。
 *
 * 4. **seek 到未缓冲区域的 MSE seek**：
 *    观众端跟随房主 seek 时（通过 control 事件），若目标位置不在缓冲范围内且为 MSE 流，
 *    调用 executeSeek → 引擎 seekTo（不重建媒体源）。用 isReloadingRef 锁防止并发。
 */
export function useViewerStateSync({
  roomId,
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  applySourceToVideo,
  seekTo,
  reloadVideo,
  lastAppliedSourceUrlRef,
}: UseViewerStateSyncOptions): UseViewerStateSyncReturn {
  const { socket } = useSocket()

  // Bug #8 修复：handleState 串行化处理
  const isApplyingRef = useRef(false)
  const pendingStateRef = useRef<WatchTogetherState | null>(null)
  // seek 并发锁：防止 executeSeek 期间重复触发
  const isReloadingRef = useRef(false)
  // 缓存上次应用的 isPlaying，用于判断是否需要 play/pause
  const lastAppliedIsPlayingRef = useRef<boolean | null>(null)
  // 缓存上次应用的 playbackRate，用于判断是否需要设置 playbackRate
  const lastAppliedPlaybackRateRef = useRef<number | null>(null)
  // 缓冲模式：下载取消器，新 source 到来时取消未完成下载避免竞态
  const downloadAbortRef = useRef<AbortController | null>(null)
  // 最近一次收到的广播序号：检测跳号（seq > lastSeq + 1）即说明错失了中间广播
  // （socket 重连窗口），主动请求全量状态自愈，避免 diff 合并基线错位
  const lastSeqRef = useRef(0)

  useEffect(() => {
    if (!socket || isHostRef.current) return

    /**
     * 应用状态变化：按字段分离同步，避免不必要的操作导致视频卡顿。
     *
     * @param state 房主广播的完整状态
     * @param isSourceChange 是否为 sourceUrl 变化触发的调用（需要 applySourceToVideo）
     */
    const applyStateChanges = async (
      state: WatchTogetherState,
      isSourceChange: boolean
    ) => {
      const video = videoRef.current
      if (!video) return

      // 1. sourceUrl 变化 → applySourceToVideo（含完整同步）
      if (isSourceChange) {
        // 缓冲模式：先下载完整 m4s 到 IndexedDB，再用 blob URL 播放
        // 避免播放过程中 B站 URL 过期或网络波动导致卡顿
        let blobs: { videoBlob: Blob; audioBlob: Blob } | undefined
        if (state.bufferMode) {
          // 取消上一个未完成的下载（切换影片时常见竞态）
          if (downloadAbortRef.current) {
            downloadAbortRef.current.abort()
          }
          const controller = new AbortController()
          downloadAbortRef.current = controller

          const setBufferProgress = useRoomStore.getState().setBufferProgress
          setBufferProgress({
            downloaded: 0,
            total: 1,
            title: state.previewTitle || '当前视频',
          })

          try {
            const result = await fetchBlobsForBufferMode({
              state,
              title: state.previewTitle,
              onProgress: (p) => setBufferProgress(p),
              signal: controller.signal,
            })
            blobs = { videoBlob: result.videoBlob, audioBlob: result.audioBlob }
          } catch (err) {
            if (err instanceof DownloadAbortedError) {
              console.log('[useViewerStateSync] 缓冲下载已取消')
            } else if (err instanceof UrlExpiredError) {
              message.error('B站 URL 已过期，请等待房主重新解析')
            } else if (err instanceof DownloadError) {
              message.error(`缓冲下载失败: ${err.message}`)
            } else {
              console.error('[useViewerStateSync] 缓冲下载失败:', err)
              message.error('缓冲下载失败，请等待房主重新广播')
            }
            // 缓冲失败：不应用源（避免半成品导致黑屏），等待房主重新广播
            // 但需要释放 suppressEventsRef 与 isApplyingRef，否则后续事件被吞
            setBufferProgress(null)
            downloadAbortRef.current = null
            // 标记 sourceUrl 已处理（避免下次同 source 再触发），等房主重新广播
            lastAppliedSourceUrlRef.current = state.sourceUrl
            return
          } finally {
            if (downloadAbortRef.current === controller) {
              downloadAbortRef.current = null
            }
          }
          // 下载完成，清空进度覆盖层
          useRoomStore.getState().setBufferProgress(null)
        }

        // 传入 state.currentTime 作为 startTime：引擎（DashPlayer）从该时间对应
        // 的字节位置开始下载，而非从文件头顺序下载到目标位置才播放
        // （房主切清晰度/换片时观众从房主当前进度起播，避免长缓冲）。
        await applySourceToVideo(
          video,
          state,
          state.currentTime || undefined,
          blobs
        )
        // applySourceToVideo 后视频元素可能已替换，重新获取
        const currentVideo = videoRef.current
        if (!currentVideo) return

        // 源变化时完整同步所有字段
        if (state.currentTime > 0) {
          try {
            currentVideo.currentTime = state.currentTime
          } catch {
            // ignore
          }
        }
        if (
          state.playbackRate > 0 &&
          currentVideo.playbackRate !== state.playbackRate
        ) {
          currentVideo.playbackRate = state.playbackRate
        }
        if (state.isPlaying && currentVideo.paused) {
          void safePlay(currentVideo)
        } else if (!state.isPlaying && !currentVideo.paused) {
          currentVideo.pause()
        }

        // 更新缓存
        lastAppliedSourceUrlRef.current = state.sourceUrl
        lastAppliedIsPlayingRef.current = state.isPlaying
        if (state.playbackRate > 0) {
          lastAppliedPlaybackRateRef.current = state.playbackRate
        }
        return
      }

      // 2. 非 sourceUrl 变化：按字段分离同步
      // 2.1 isPlaying 变化 → play/pause
      if (lastAppliedIsPlayingRef.current !== state.isPlaying) {
        if (state.isPlaying && video.paused) {
          void safePlay(video)
        } else if (!state.isPlaying && !video.paused) {
          video.pause()
        }
        lastAppliedIsPlayingRef.current = state.isPlaying
      }

      // 2.2 playbackRate 变化 → 设置 playbackRate
      if (
        lastAppliedPlaybackRateRef.current === null ||
        Math.abs(
          (lastAppliedPlaybackRateRef.current as number) - state.playbackRate
        ) > 0.01
      ) {
        if (state.playbackRate > 0) {
          if (video.playbackRate !== state.playbackRate) {
            video.playbackRate = state.playbackRate
          }
          lastAppliedPlaybackRateRef.current = state.playbackRate
        }
      }

      // 2.3 currentTime 不再单独设置（由 host-heartbeat 校正）
      // 进度校正由 useViewerHeartbeat 处理，避免高频 seek 卡顿
    }

    const handleState = (payload: StatePayload) => {
      // 跳号检测：seq > lastSeq + 1 说明错失了中间广播（socket 重连窗口等），
      // diff 合并基线已错位 → 强制丢弃 diff 用全量 state，并请求全量状态自愈。
      if (typeof payload.seq === 'number' && payload.seq > 0) {
        const lastSeq = lastSeqRef.current
        if (lastSeq > 0 && payload.seq > lastSeq + 1) {
          // 错失广播：用全量 state 覆盖（忽略 diff），并请求房主/服务器最新状态
          socket?.emit(SOCKET_EVENT.REQUEST_STATE, { roomId })
        }
        lastSeqRef.current = payload.seq
      }

      // P1-Opt#7：增量状态合并——优先使用 diff 合并到现有 state，避免全量替换
      const state = payload.diff
        ? mergeStateDiff(
            useRoomStore.getState().watchTogether,
            payload.diff as Partial<WatchTogetherState>
          )
        : payload.state

      // 判断是否为 sourceUrl 变化
      const isSourceChange = lastAppliedSourceUrlRef.current !== state.sourceUrl
      setWatchTogether(state)

      const processState = async (s: WatchTogetherState) => {
        isApplyingRef.current = true
        try {
          await applyStateChanges(s, isSourceChange)
        } catch (err: unknown) {
          console.error('[useViewerStateSync] applyStateChanges failed:', err)
          message.error(err instanceof Error ? err.message : '视频源加载失败')
        } finally {
          isApplyingRef.current = false
        }
      }

      const drain = async () => {
        // 持续消费 pendingStateRef，直到清空
        while (pendingStateRef.current) {
          const next = pendingStateRef.current
          pendingStateRef.current = null
          await processState(next)
        }
        // 释放 drain 启动者获取的那一次抑制
        suppressEventsRef.current = false
      }

      // 抑制计数必须在"确定成为处理者"时才获取（+1），并由处理完成点释放（−1）。
      // 若在函数入口无条件 +1，pending 缓存路径会提前 return 且无对应 -1，
      // drain 只释放启动者的一次 → 计数悬挂 → 心跳校正/事件处理被永久拦截
      // （症状：房主跳转进度后观众不再自动跟随）。

      // 串行化 applySourceToVideo：若上一次 apply 还在进行中，
      // 仅缓存最新 state，等上一次完成后处理最新值。
      if (isSourceChange) {
        pendingStateRef.current = state
        if (isApplyingRef.current) return
        // 成为 drain 启动者：获取抑制，drain 结束时统一释放
        suppressEventsRef.current = true
        void drain()
        return
      }

      // 非 sourceUrl 变化：直接同步，不需要串行化（各自 acquire/release 配对）
      suppressEventsRef.current = true
      void processState(state).then(() => {
        suppressEventsRef.current = false
      })
    }

    const handleControl = (payload: ControlPayload) => {
      const video = videoRef.current
      if (!video) return

      // seek 到未缓冲区域：交给 executeSeek 处理（内部管理锁 + suppressEventsRef）
      if (payload.action === 'seek' && typeof payload.value === 'number') {
        const targetTime = payload.value
        const state = useRoomStore.getState().watchTogether
        void executeSeek({
          video,
          targetTime,
          state,
          seekTo,
          suppressEventsRef,
          isReloadingRef,
          onSeekFailed: reloadVideo,
        }).then((didSeek) => {
          // 未触发 MSE seek 时执行普通 seek
          if (!didSeek) {
            suppressEventsRef.current = true
            video.currentTime = targetTime
            suppressEventsRef.current = false
          }
        })
        return
      }

      // 普通控制：使用 suppressEventsRef 包围，防止本地事件回环
      suppressEventsRef.current = true
      switch (payload.action) {
        case 'play':
          void safePlay(video)
          lastAppliedIsPlayingRef.current = true
          break
        case 'pause':
          video.pause()
          lastAppliedIsPlayingRef.current = false
          break
        case 'rate':
          if (typeof payload.value === 'number' && payload.value > 0) {
            video.playbackRate = payload.value
            lastAppliedPlaybackRateRef.current = payload.value
          }
          break
      }
      suppressEventsRef.current = false
    }

    socket.on(SOCKET_EVENT.STATE, handleState)
    socket.on(SOCKET_EVENT.CONTROL, handleControl)

    // 初始状态请求由 usePlaybackStateRequest 通过 ack 直接获取（不在此处重复 emit）

    return () => {
      socket.off(SOCKET_EVENT.STATE, handleState)
      socket.off(SOCKET_EVENT.CONTROL, handleControl)
    }
  }, [
    socket,
    roomId,
    videoRef,
    setWatchTogether,
    applySourceToVideo,
    seekTo,
    reloadVideo,
    suppressEventsRef,
    isHostRef,
    lastAppliedSourceUrlRef,
  ])
}

/**
 * 观众心跳订阅 Hook：监听房主的 `host-heartbeat` 事件，
 * 用于进度校正与房主离线检测。
 *
 * v3 新增：之前观众端未订阅 host-heartbeat，导致：
 * - 房主在线时观众端无法校正进度漂移
 * - 房主心跳超时检测失效（虽然有 server-heartbeat 兜底）
 *
 * 行为：
 * - 收到 host-heartbeat 时，重置房主离线计时器
 * - 进度差异 > SEEK_FOLLOW_THRESHOLD（3s）时 seek 到房主进度
 * - 小差异不操作，让视频自然播放
 * - isPlaying 变化时同步 play/pause
 */
export function useViewerHeartbeat({
  isHostRef,
  videoRef,
  suppressEventsRef,
}: {
  isHostRef: MutableRefObject<boolean>
  videoRef: RefObject<HTMLVideoElement | null>
  suppressEventsRef: MutableRefObject<boolean>
}): void {
  const { socket } = useSocket()
  // seek 并发锁
  const isReloadingRef = useRef(false)
  // 缓存上次应用的 isPlaying，用于判断是否需要 play/pause
  const lastAppliedIsPlayingRef = useRef<boolean | null>(null)

  // P2-Opt#9：软同步追赶状态
  const catchUpActiveRef = useRef(false)
  const catchUpBaseRateRef = useRef(1)

  useEffect(() => {
    if (!socket || isHostRef.current) return

    const handleHeartbeat = (payload: {
      currentTime: number
      isPlaying: boolean
      playbackRate?: number
      suppressed?: boolean
    }) => {
      const video = videoRef.current
      if (!video) return
      if (suppressEventsRef.current) return

      // suppressed 标记的心跳仅存活检测，不用于状态同步
      if (payload.suppressed) return

      // 从心跳提取 playbackRate（兼容旧版本缺失，缺省按 1x）
      const rate =
        typeof payload.playbackRate === 'number' && payload.playbackRate > 0
          ? payload.playbackRate
          : 1

      // isPlaying 变化时同步 play/pause
      if (lastAppliedIsPlayingRef.current !== payload.isPlaying) {
        suppressEventsRef.current = true
        if (payload.isPlaying && video.paused) {
          void safePlay(video)
        } else if (!payload.isPlaying && !video.paused) {
          video.pause()
        }
        lastAppliedIsPlayingRef.current = payload.isPlaying
        suppressEventsRef.current = false
      }

      // 进度校正：软同步 + 硬 seek 两阶段策略（P2-Opt#9）
      // 软同步区间：差异 > 阈值 但 ≤ HARD_SEEK_THRESHOLD_SEC → 调整 playbackRate 渐进追赶
      // 硬 seek 区间：差异 > HARD_SEEK_THRESHOLD_SEC → 直接跳转
      const diff = Math.abs(video.currentTime - payload.currentTime)
      const threshold = getAdaptiveSeekThreshold(rate)

      if (diff <= threshold) {
        // 差异已收敛 → 取消软同步，恢复基准倍速
        if (catchUpActiveRef.current) {
          catchUpActiveRef.current = false
          video.playbackRate = catchUpBaseRateRef.current
        }
      } else if (shouldSoftSync(video.currentTime, payload.currentTime, rate)) {
        // 软同步：小幅差异通过微调倍速追赶
        if (!catchUpActiveRef.current) {
          catchUpActiveRef.current = true
          catchUpBaseRateRef.current = video.playbackRate
        }
        const catchUpRate = getCatchUpRate(rate)
        if (video.playbackRate !== catchUpRate) {
          video.playbackRate = catchUpRate
        }
      } else {
        // 硬 seek：大幅差异（> HARD_SEEK_THRESHOLD_SEC）直接跳转
        if (catchUpActiveRef.current) {
          catchUpActiveRef.current = false
          video.playbackRate = catchUpBaseRateRef.current
        }
        const state = useRoomStore.getState().watchTogether
        const targetTime = payload.currentTime
        void executeSeek({
          video,
          targetTime,
          state,
          seekTo: async (_video, time) => {
            try {
              _video.currentTime = time
              return { success: true }
            } catch {
              return { success: false }
            }
          },
          suppressEventsRef,
          isReloadingRef,
        }).then((didSeek) => {
          if (!didSeek) {
            suppressEventsRef.current = true
            try {
              video.currentTime = targetTime
            } catch {
              // ignore
            }
            suppressEventsRef.current = false
          }
        })
      }
    }

    // 统一心跳协议（#14）：只监听 sync-heartbeat（source='host'）。
    // 后端同时转发旧 host-heartbeat 与新 sync-heartbeat，若两者都绑定会导致
    // 每条心跳被处理两遍（重复校正计算 + zustand 双倍 notify），故不再绑定旧事件。
    const handleSyncHeartbeat = (payload: SyncHeartbeatPayload) => {
      if (
        payload.source === 'host' &&
        typeof payload.currentTime === 'number'
      ) {
        handleHeartbeat({
          currentTime: payload.currentTime,
          isPlaying: !!payload.isPlaying,
          playbackRate: payload.playbackRate,
          suppressed: payload.suppressed,
        })
      }
    }
    socket.on(SOCKET_EVENT.SYNC_HEARTBEAT, handleSyncHeartbeat)
    return () => {
      socket.off(SOCKET_EVENT.SYNC_HEARTBEAT, handleSyncHeartbeat)
    }
  }, [socket, isHostRef, videoRef, suppressEventsRef])
}
