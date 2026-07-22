import { useCallback, useMemo, useState } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import { resolveBilibiliWithOptions } from './bilibiliApi'
import type { QualityOption, ResolvedSource } from './types'
import { useRoomStore } from '@/store/roomStore'
import type { WatchTogetherState, Movie } from '@/store/roomStore'
import { safePlay } from '@/modules/sync-playback/safePlay'

function qualitiesEqual(a: QualityOption[], b: QualityOption[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].label !== b[i].label) return false
  }
  return true
}

/**
 * useBilibiliQuality hook 的依赖上下文。
 * 由 useWatchTogether 提供，避免 hook 直接耦合宿主内部状态。
 *
 * 协议精简（v2）：移除 socket/roomId 字段。清晰度切换通过 broadcastState(newState)
 * 推送完整状态（含 currentQn），观众端 useViewerStateSync 接收后由 syncFromState 自动更新 UI。
 * 旧版独立的 quality-change 事件已删除（后端从未实现转发 handler，功能实际失效）。
 */
export interface BilibiliQualityContext {
  videoRef: RefObject<HTMLVideoElement>
  isHostRef: MutableRefObject<boolean>
  suppressEventsRef: MutableRefObject<boolean>
  applySourceToVideo: (
    video: HTMLVideoElement,
    state: WatchTogetherState,
    startTime?: number
  ) => Promise<void>
  setWatchTogether: (state: WatchTogetherState) => void
  broadcastState: (state: WatchTogetherState) => void
  setIsResolving: (v: boolean) => void
  setResolvingMessage: (s: string) => void
}

export interface ApplyQualityChangeOptions {
  /** 是否广播给观众（房主 true，观众 false） */
  broadcast?: boolean
  /** 已解析的结果（来自 MovieListPanel 预解析），不传则内部调用 resolveBilibiliWithOptions */
  resolved?: ResolvedSource
  /** 解析进度消息 */
  message?: string
}

/**
 * Bilibili 清晰度切换统一 Hook。
 * 封装 currentQuality/availableQualities/isSwitchingQuality 状态管理，
 * 以及房主/观众/列表触发的统一切换逻辑。
 */
export function useBilibiliQuality(ctx: BilibiliQualityContext) {
  const [currentQuality, setCurrentQuality] = useState<number | null>(null)
  const [availableQualities, setAvailableQualities] = useState<QualityOption[]>(
    []
  )
  const [isSwitchingQuality, setIsSwitchingQuality] = useState(false)

  /**
   * 统一清晰度切换函数。
   * 根据是否传入 resolved 决定是否内部解析，应用新源、保留进度、失败回退、广播。
   */
  const applyQualityChange = useCallback(
    async (
      movie: Movie,
      qn: number | undefined,
      options: ApplyQualityChangeOptions = {}
    ): Promise<void> => {
      const video = ctx.videoRef.current
      if (!video) return

      const state = useRoomStore.getState().watchTogether
      if (state.sourceType !== 'bilibili' || state.format !== 'dash') return

      const {
        broadcast = false,
        resolved: preResolved,
        message = '正在切换清晰度...',
      } = options

      setIsSwitchingQuality(true)
      ctx.setIsResolving(true)
      ctx.setResolvingMessage(message)
      // eslint-disable-next-line react-hooks/immutability -- ref.current 设计为可变
      ctx.suppressEventsRef.current = true

      const preserveTime = video.currentTime
      const shouldPlay = !video.paused

      try {
        let resolved: ResolvedSource
        if (preResolved) {
          resolved = preResolved
        } else {
          resolved = await resolveBilibiliWithOptions(
            movie.url,
            qn,
            (_step, msg) => ctx.setResolvingMessage(msg)
          )
        }

        if (!resolved.videoUrl) {
          throw new Error('未获取到对应清晰度的播放地址')
        }

        const newState: WatchTogetherState = {
          ...state,
          sourceUrl: resolved.videoUrl,
          audioUrl: resolved.audioUrl,
          videoCodec: resolved.videoCodec,
          audioCodec: resolved.audioCodec,
          format: resolved.format,
          cid: resolved.cid ?? state.cid,
          duration: resolved.duration ?? state.duration,
          currentQn: resolved.currentQn ?? qn,
          acceptQuality: resolved.acceptQuality,
          isPlaying: shouldPlay,
          currentTime: preserveTime,
        }

        ctx.setWatchTogether(newState)
        await ctx.applySourceToVideo(video, newState)
        video.currentTime = preserveTime
        if (shouldPlay) {
          void safePlay(video)
        }

        setCurrentQuality(newState.currentQn ?? null)
        setAvailableQualities(newState.acceptQuality ?? [])

        // 协议精简（v2）：清晰度切换仅通过 broadcastState 推送完整 state（含 currentQn）。
        // 旧版额外 emit 'quality-change' 事件，但后端从未实现转发 handler 导致功能失效。
        // 观众端 useViewerStateSync 接收 state 后由 quality.syncFromState 自动更新 UI。
        if (broadcast && ctx.isHostRef.current) {
          ctx.broadcastState(newState)
        }
      } catch (err) {
        console.error('[useBilibiliQuality] 切换清晰度失败:', err)
        // 回退到原 source
        try {
          await ctx.applySourceToVideo(video, state)
          if (preserveTime > 0) {
            video.currentTime = preserveTime
          }
          if (shouldPlay) {
            void safePlay(video)
          }
        } catch {
          // 忽略恢复失败
        }
      } finally {
        ctx.suppressEventsRef.current = false
        setIsSwitchingQuality(false)
        ctx.setIsResolving(false)
        ctx.setResolvingMessage('')
      }
    },
    // 仅依赖 ctx 中真正用到的稳定引用。
    // ctx 对象本身每次渲染都是新引用，若直接依赖 ctx 会导致 applyQualityChange 每次重建，
    // 进而 quality useMemo 每次返回新对象，下游 useEffect 无限触发 setState →
    // "Maximum update depth exceeded"。
    // 这些字段都是 ref 或 store action，引用稳定，不会在渲染间变化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      ctx.videoRef,
      ctx.isHostRef,
      ctx.suppressEventsRef,
      ctx.applySourceToVideo,
      ctx.setWatchTogether,
      ctx.broadcastState,
      ctx.setIsResolving,
      ctx.setResolvingMessage,
    ]
  )

  /**
   * 同步 watchTogether state 中的清晰度信息到本地状态。
   */
  const syncFromState = useCallback((state: WatchTogetherState) => {
    if (
      state.sourceType === 'bilibili' &&
      state.format === 'dash' &&
      state.sourceUrl
    ) {
      const nextQualities = state.acceptQuality ?? []
      const nextQuality = state.currentQn ?? null
      setAvailableQualities((prev) =>
        qualitiesEqual(prev, nextQualities) ? prev : nextQualities
      )
      setCurrentQuality((prev) => (prev === nextQuality ? prev : nextQuality))
    } else {
      setAvailableQualities((prev) => (prev.length === 0 ? prev : []))
      setCurrentQuality((prev) => (prev === null ? prev : null))
    }
    // 切源时重置切换中标记，避免上一源的切换状态被遗留
    setIsSwitchingQuality((prev) => (prev === false ? prev : false))
  }, [])

  // 用 useMemo 包装返回值，使 quality 对象引用稳定。
  // 否则每次渲染返回新对象字面量，下游 useEffect/useCallback 依赖 quality 时
  // 会无限重建 → syncFromState effect 反复触发 setState → "Maximum update depth exceeded"。
  // 此前房主端 join-request 监听器虽已注册，但 React 一直忙于处理无限更新，
  // 导致 ConfirmModal 无法即时弹出。
  return useMemo(
    () => ({
      currentQuality,
      availableQualities,
      isSwitchingQuality,
      setCurrentQuality,
      setAvailableQualities,
      setIsSwitchingQuality,
      applyQualityChange,
      syncFromState,
    }),
    [
      currentQuality,
      availableQualities,
      isSwitchingQuality,
      applyQualityChange,
      syncFromState,
    ]
  )
}
