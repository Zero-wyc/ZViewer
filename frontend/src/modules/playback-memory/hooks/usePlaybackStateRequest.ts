/**
 * usePlaybackStateRequest Hook
 *
 * 观众加入房间或房主重连时，向服务器请求当前播放状态。
 *
 * 旧架构：emit watch-together-request-state，后端广播给房主，房主响应。
 * 新架构：emit watch-together-request-state，后端直接通过 ack 返回推算后的状态。
 *
 * 优势：
 * - 房主离线时观众仍可获取状态（从服务器持久化读取）
 * - 减少一次 socket 往返（ack vs 广播+响应）
 */
import { useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState } from '@/modules/sync-playback/types'
import { SOCKET_EVENT } from '@/modules/sync-playback/constants'
import { safePlay } from '@/modules/sync-playback/safePlay'
import { restoreStateSnapshot } from '@/modules/sync-playback/services/state-merge'
import type { RequestStateAckData } from '../types'
import {
  fetchBlobsForBufferMode,
  DownloadError,
  UrlExpiredError,
  DownloadAbortedError,
} from '@/modules/player/services/buffer-mode'
import { t } from '@/i18n'

export interface UsePlaybackStateRequestOptions {
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
  /**
   * 已应用 sourceUrl 的共享 ref（由 useViewerSync 提升，与 useViewerStateSync 共享）。
   * attach 完成后写入此 ref，避免后续 useViewerStateSync 收到同 sourceUrl 的 state 时
   * 误判为 source 变化，重复触发 applySourceToVideo 覆盖已缓冲的 blob 源。
   */
  lastAppliedSourceUrlRef: MutableRefObject<string | null>
}

export type UsePlaybackStateRequestReturn = void

export function usePlaybackStateRequest({
  roomId,
  isHostRef,
  videoRef,
  suppressEventsRef,
  setWatchTogether,
  applySourceToVideo,
  lastAppliedSourceUrlRef,
}: UsePlaybackStateRequestOptions): UsePlaybackStateRequestReturn {
  const { socket } = useSocket()
  const requestedRef = useRef(false)
  // 服务器暂无播放状态时的重试（房主可能刚开始播放 / 状态尚未持久化）
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 缓冲模式下载的取消控制器：卸载/房间切换时中断下载，避免孤儿任务占用带宽
  const downloadAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!socket || isHostRef.current) return
    if (requestedRef.current) return
    requestedRef.current = true

    const requestState = () => {
      // emit 请求状态，ack 回调直接返回推算后的状态
      socket.emit(
        SOCKET_EVENT.REQUEST_STATE,
        { roomId },
        (response: {
          success: boolean
          data?: RequestStateAckData | null
          message?: string
        }) => {
          if (!response.success || !response.data?.state) {
            // 服务器无播放状态：短间隔重试，避免观众加入后一直黑屏等待
            if (retryCountRef.current < 10) {
              retryCountRef.current += 1
              retryTimerRef.current = setTimeout(requestState, 1500)
            }
            return
          }

          retryCountRef.current = 10 // 拿到状态后停止重试

          const state = restoreStateSnapshot(
            useRoomStore.getState().watchTogether,
            response.data.state
          )

          // hostOnline=false：观众在房主离线后才加入/刷新页面，直接进入
          // 自主控制模式（roomStore.hostOffline → canControl）。否则观众
          // 误以为房主在线：暂停走「向房主申请」死路，且服务器心跳每 2s
          // 用 isPlaying=true 把暂停拉回播放（无法暂停 bug）。
          if (response.data.hostOnline === false) {
            useRoomStore.getState().setHostOffline(true)
          } else if (response.data.hostOnline === true) {
            useRoomStore.getState().setHostOffline(false)
          }

          // 重试等待期间可能已通过房主广播（useViewerStateSync）应用过该源，
          // 此时不再重复 attach，避免重复解析 / 覆盖已就绪的播放器
          if (
            lastAppliedSourceUrlRef.current === state.sourceUrl &&
            useRoomStore.getState().watchTogether.noProxyFallback ===
              state.noProxyFallback
          ) {
            return
          }
          const video = videoRef.current
          if (!video) return

          const downloadController = new AbortController()
          downloadAbortRef.current = downloadController

          // attach 开始前即标记 sourceUrl 已应用：消除 useViewerStateSync 在
          // attach 进行中收到同源 state 时误判 isSourceChange 并发起第二个
          // attach 的竞态窗口（两个并发 attach 互相 reset → 黑屏）。
          // 失败时回滚，允许下一次重试。
          const previousAppliedUrl = lastAppliedSourceUrlRef.current
          lastAppliedSourceUrlRef.current = state.sourceUrl

          suppressEventsRef.current = true
          setWatchTogether(state)

          /** 缓冲模式：先下载 m4s 到 IndexedDB 再 attach */
          const fetchBlobsIfNeeded = async (): Promise<
            { videoBlob: Blob; audioBlob: Blob } | undefined
          > => {
            if (!state.bufferMode) return undefined
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
                signal: downloadController.signal,
              })
              return {
                videoBlob: result.videoBlob,
                audioBlob: result.audioBlob,
              }
            } catch (err) {
              if (err instanceof DownloadAbortedError) {
                console.log('[usePlaybackStateRequest] 缓冲下载已取消')
              } else if (err instanceof UrlExpiredError) {
                message.error(t('B站 URL 已过期，请等待房主重新解析'))
              } else if (err instanceof DownloadError) {
                message.error(`缓冲下载失败: ${err.message}`)
              } else {
                console.error('[usePlaybackStateRequest] 缓冲下载失败:', err)
                message.error(t('缓冲下载失败，请等待房主重新广播'))
              }
              return null // 区分 undefined（不需要缓冲）和 null（缓冲失败）
            } finally {
              useRoomStore.getState().setBufferProgress(null)
            }
          }

          void (async () => {
            const blobs = await fetchBlobsIfNeeded()
            if (blobs === null) {
              // 缓冲失败：不应用源，回滚 sourceUrl 标记，等待房主重新广播
              lastAppliedSourceUrlRef.current = previousAppliedUrl
              suppressEventsRef.current = false
              return
            }
            // 直接以房主当前进度作为起始位置加载（引擎支持 startTime），
            // 首帧即对齐房主位置，省去 attach 完成后再 seek 的等待
            const startTime =
              state.currentTime > 0 ? state.currentTime : undefined
            await applySourceToVideo(
              video,
              state,
              startTime,
              blobs ?? undefined
            )
            const currentVideo = videoRef.current
            if (!currentVideo) return

            // sourceUrl 已在 attach 前标记，此处无需重复写入

            // 设置进度
            if (state.currentTime > 0) {
              try {
                currentVideo.currentTime = state.currentTime
              } catch {
                // ignore
              }
            }
            // 设置倍速
            if (
              state.playbackRate > 0 &&
              currentVideo.playbackRate !== state.playbackRate
            ) {
              currentVideo.playbackRate = state.playbackRate
            }
            // 播放/暂停
            if (state.isPlaying && currentVideo.paused) {
              void safePlay(currentVideo)
            } else if (!state.isPlaying && !currentVideo.paused) {
              currentVideo.pause()
            }
            suppressEventsRef.current = false
          })().catch((err: unknown) => {
            console.error('[usePlaybackStateRequest] 恢复状态失败:', err)
            // attach 失败：回滚 sourceUrl 标记，允许下一次重试
            lastAppliedSourceUrlRef.current = previousAppliedUrl
            suppressEventsRef.current = false
            message.error(
              err instanceof Error ? err.message : t('状态恢复失败')
            )
          })
        }
      )
    }

    requestState()

    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      downloadAbortRef.current?.abort()
      downloadAbortRef.current = null
    }
  }, [
    socket,
    roomId,
    isHostRef,
    videoRef,
    suppressEventsRef,
    setWatchTogether,
    applySourceToVideo,
    lastAppliedSourceUrlRef,
  ])
}
