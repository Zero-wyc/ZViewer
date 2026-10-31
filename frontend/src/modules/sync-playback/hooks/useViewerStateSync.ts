import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState, StatePayload, ControlPayload } from '../types'
import { SOCKET_EVENT } from '../constants'
import { safePlay } from '../safePlay'
import { executeSeek, restoreStateSnapshot } from '../services'
import type { SeekToResult } from '../services'
import {
  fetchBlobsForBufferMode,
  DownloadError,
  UrlExpiredError,
  DownloadAbortedError,
} from '@/modules/player/services/buffer-mode'
import { t } from '@/i18n'

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
 *    - currentTime 不再单独设置（由服务器心跳校正）
 *      例外：房主 forceSync（「同步进度」按钮，payload 无 diff 字段）时
 *      强制应用 currentTime（executeSeek 硬校正 + 失败重建引擎），使按钮
 *      成为绕过心跳校正链死区的强制恢复手段。
 *
 * 2. **串行化 applySourceToVideo（Bug #8 修复）**：
 *    sourceUrl 变化时用 isApplyingRef 锁 + pendingStateRef 缓存最新 state，串行处理。
 *
 * 3. **进度校正由服务器心跳驱动（Step 2，服务器权威化）**：
 *    收到 state 时不再设置 currentTime，进度校正统一由 useServerHeartbeat 处理
 *    （服务器每 2s 广播推算进度，差异超阈值才校正，小差异让视频自然播放）。
 *    房主广播的 state/control 降级为「源信息 + 即时操作事件」通道。
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
      isSourceChange: boolean,
      force = false
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
            title: state.previewTitle || t('当前视频'),
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
              message.error(t('B站 URL 已过期，请等待房主重新解析'))
            } else if (err instanceof DownloadError) {
              message.error(
                t('缓冲下载失败: {{message}}', { message: err.message })
              )
            } else {
              console.error('[useViewerStateSync] 缓冲下载失败:', err)
              message.error(t('缓冲下载失败，请等待房主重新广播'))
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

        // 传入 state.currentTime 作为 startTime：DASH 引擎从该时间对应
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
      // 2.1 isPlaying 变化 → play/pause（forceSync 全量权威广播时跳过增量缓存直接应用）
      if (force || lastAppliedIsPlayingRef.current !== state.isPlaying) {
        if (state.isPlaying && video.paused) {
          void safePlay(video)
        } else if (!state.isPlaying && !video.paused) {
          video.pause()
        }
        lastAppliedIsPlayingRef.current = state.isPlaying
      }

      // 2.2 playbackRate 变化 → 设置 playbackRate
      if (
        force ||
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

      // 2.3 currentTime：常规广播不单独设置（由服务器心跳校正），避免高频 seek 卡顿。
      // forceSync（房主「同步进度」按钮，payload 无 diff 字段）时执行硬校正：
      // 心跳校正链（useServerHeartbeat）在事件抑制/引擎卡死等场景会被静默拦截
      // 或长时间转圈等待，按钮必须能绕过它们把观众拉回房主进度——MSE seek
      // 失败时经 onSeekFailed → reloadVideo 重建引擎，与「重载视频」等效。
      if (force && state.currentTime > 0) {
        const timeDiff = Math.abs(video.currentTime - state.currentTime)
        if (timeDiff > 0.5) {
          void executeSeek({
            video,
            targetTime: state.currentTime,
            state,
            seekTo,
            suppressEventsRef,
            isReloadingRef,
            onSeekFailed: reloadVideo,
          }).then((didSeek) => {
            // 非 MSE 流 / 目标已在缓冲内：普通 seek 即可
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
      }
    }

    const handleState = (payload: StatePayload) => {
      // 跳号检测：seq > lastSeq + 1 说明错失了中间广播（socket 重连窗口等），
      // 当前消息按完整 state 应用，同时请求最新状态以恢复中断期间的进度。
      if (typeof payload.seq === 'number' && payload.seq > 0) {
        const lastSeq = lastSeqRef.current
        if (lastSeq > 0 && payload.seq > lastSeq + 1) {
          // 错失广播：用全量 state 覆盖（忽略 diff），并请求房主/服务器最新状态
          socket?.emit(SOCKET_EVENT.REQUEST_STATE, { roomId })
        }
        lastSeqRef.current = payload.seq
      }

      // state 始终是完整快照；diff 无法表达经 JSON 传输后被省略的 undefined。
      // 例如 B站 → Kazumi 时，旧 audioUrl 必须清空，否则 HLS 会误入 DASH 引擎。
      // diff 字段缺失 = 房主 forceSync（「同步进度」按钮 / 清晰度切换后立即推送）：
      // 广播链路 broadcastState 恒携带 diff（computeStateDiff），仅 forceSync 不带，
      // 据此可靠区分。观众端对这类全量广播做强制应用（含 currentTime 硬校正）。
      const isForceSync = payload.diff === undefined
      const previous = useRoomStore.getState().watchTogether
      const state = restoreStateSnapshot(previous, payload.state)

      // 判断是否为 sourceUrl 变化
      // 引擎门控（playsvideoEnabled）变化同样需要重挂载：URL 不变时引擎选择
      // 依据 state.playsvideoEnabled，不重挂载就会继续用旧引擎（房主在影片
      // 卡片里切换「浏览器转码」后观众应立即跟随）。旧房主上报可能缺该字段，
      // 按「缺省视为开启」归一化后再比，避免无意义重挂载。
      const isSourceChange =
        lastAppliedSourceUrlRef.current !== state.sourceUrl ||
        previous.noProxyFallback !== state.noProxyFallback ||
        (previous.playsvideoEnabled !== false) !==
          (state.playsvideoEnabled !== false)
      setWatchTogether(state)

      const processState = async (s: WatchTogetherState, force = false) => {
        isApplyingRef.current = true
        try {
          await applyStateChanges(s, isSourceChange, force)
        } catch (err: unknown) {
          console.error('[useViewerStateSync] applyStateChanges failed:', err)
          message.error(
            err instanceof Error ? err.message : t('视频源加载失败')
          )
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
      void processState(state, isForceSync).then(() => {
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
