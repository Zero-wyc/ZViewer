/**
 * usePlayerSource Hook（v2 重写）。
 *
 * 负责将 PlayerSource 应用到 <video> 元素，使用 selectEngine 选择合适的引擎并调用 attach。
 *
 * 核心职责：
 * 1. 引擎选择与 attach（MSE / HLS / FLV / Direct）
 * 2. 资源清理（blobUrl / audioSync / engine cleanup）
 * 3. appliedSourceUrl 跟踪：避免同一源被重复加载
 * 4. 全量操作串行化：attach / forceReload 进入同一条 Promise 队列，
 *    天然消除并发 attach 互相 abort 的问题
 *
 * 相比 v1 的改进：
 * - Promise 队列替代 isAttaching/isReloading 双锁与 5s 等待循环；
 * - 不再读写 video._mseAbortController：引擎的下载中断由
 *   engine cleanup（DashPlayer.cleanup 内部 abort attach 请求）负责；
 * - forceReload 多次调用合并为最新 source 的一次重载。
 *
 * 该 Hook 是引擎无关的：不关心是房主还是观众，也不依赖 WatchTogetherState。
 * 调用方（如 sync-playback/useVideoSource）负责传入 PlayerSource 与处理副作用。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject, MutableRefObject } from 'react'
import {
  selectEngine,
  shouldUsePlaysVideo,
  resetVideoElement,
  directEngine,
} from '@/modules/player'
import type { PlayerSource, PlayerController } from '@/modules/player'
import { refreshAccessToken } from '@/lib/api'

/** 引擎实例直查表（仅回退场景使用；selectEngine 不应返回 playsvideo 的兜底） */
const ENGINES = { direct: directEngine } as const
import {
  isBrowserPlayableFormat,
  getUnsupportedFormatMessage,
} from '@/lib/mediaFormat'

/**
 * 判断引擎错误是否为鉴权失效（401/403）。
 *
 * 媒体 URL（appendAuthToken）嵌入的 access token 过期时，playsvideo
 * worker 的取流错误为 `Error fetching <url>: 403 Forbidden`；这类错误
 * 可通过刷新 token 后重试自愈（媒体请求不走 apiFetch，无内置刷新）。
 */
function isAuthExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b(401|403)\b/.test(msg)
}

export interface UsePlayerSourceOptions {
  videoRef: RefObject<HTMLVideoElement | null>
}

export interface UsePlayerSourceReturn {
  /**
   * 将媒体源应用到 video 元素。
   *
   * - 同一 sourceUrl 不重复加载（通过 appliedSourceUrlRef 跟踪）
   * - 格式预检：浏览器不支持的格式直接抛错
   * - 切换前 cleanup 旧引擎资源 + resetVideoElement
   * - 失败时回滚 appliedSourceUrlRef，允许下次重试
   *
   * @returns Promise 在 metadata 就绪后 resolve（readyState >= 1）
   */
  attachSource: (video: HTMLVideoElement, source: PlayerSource) => Promise<void>
  /** 清理所有引擎资源（blobUrl / audioSync / engine cleanup） */
  cleanup: () => void
  /** 当前已应用的 sourceUrl（用于去重与 seek-to-unbuffered 逻辑） */
  appliedSourceUrlRef: MutableRefObject<string | null>
  /**
   * 引擎控制器实例（DASH 引擎返回，供外部调用 seekTo）。
   * 使用 PlayerController 接口抽象，无需感知底层引擎实现。
   */
  playerRef: MutableRefObject<PlayerController | null>
  /**
   * seek 到目标时间。不重建 MediaSource。
   * 仅对 MSE 流有效，非 MSE 流直接设置 video.currentTime。
   * @returns { success: true } 成功 | { success: false, needReload: true } 需要上层 forceReload
   *   | { success: false, needReload: false } 不需要 reload（正常 abort / 非 MSE 流）
   */
  seekTo: (
    video: HTMLVideoElement,
    targetTime: number
  ) => Promise<{
    success: boolean
    needReload?: boolean
    message?: string
  }>
  /**
   * 强制重新 attach 源（重载按钮用）。
   * 调用方传入 source.startTime 可让 MSE 从目标位置附近开始下载。
   */
  forceReload: (video: HTMLVideoElement, source: PlayerSource) => Promise<void>
}

export function usePlayerSource(
  options: UsePlayerSourceOptions
): UsePlayerSourceReturn {
  const blobUrlRef = useRef<string | null>(null)
  const engineCleanupRef = useRef<(() => void) | null>(null)
  const appliedSourceUrlRef = useRef<string | null>(null)
  const playerRef = useRef<PlayerController | null>(null)
  // MKV 快速路径的原生 error 监听器清理（新 attach 前移除旧的，防累积）
  const mkvErrorCleanupRef = useRef<(() => void) | null>(null)
  // 串行操作队列：所有 attach / reload 依次执行，杜绝并发互相 abort
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  // forceReload 合并：多次调用只执行最新 source 的一次重载
  const pendingReloadRef = useRef<PlayerSource | null>(null)
  const reloadScheduledRef = useRef(false)
  // attachInner 的稳定自引用：token 刷新后的递归重试需要引用自身，
  // 直接在 useCallback 内访问自身会触发 eslint no-use-before-define。
  const attachInnerRef = useRef<
    (
      video: HTMLVideoElement,
      source: PlayerSource,
      authRetried?: boolean
    ) => Promise<void>
  >(async () => {})
  // 卸载标记：切换影片时 WatchTogetherPanel 按 key 整体重挂载
  // （usePlayerRemountKey），旧面板的 loadMovie effect 已启动的 attach
  // 会在卸载后继续完成。没有该标记时，attach 会把引擎挂到已被 React
  // 移除的游离 video 上，其声音持续输出（每切一次片泄漏一个声音源）。
  const mountedRef = useRef(true)

  /** 将操作排入串行队列（前驱无论成败都继续执行） */
  const enqueue = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(task, task)
    queueRef.current = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }, [])

  const cleanup = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
    // 移除 MKV 快速路径的原生 error 监听器（换源/清理时不再需要）
    if (mkvErrorCleanupRef.current) {
      mkvErrorCleanupRef.current()
      mkvErrorCleanupRef.current = null
    }
    const engineCleanup = engineCleanupRef.current
    engineCleanupRef.current = null
    if (engineCleanup) {
      try {
        // 引擎 cleanup（如 DashPlayer）内部中断下载并释放资源；
        // hls/flv 引擎销毁实例。放在 try 中避免清理异常阻断后续 attach。
        engineCleanup()
      } catch {
        /* ignore */
      }
    }
    playerRef.current = null
    // 清空"已应用源"标记：引擎销毁后同 URL 重播不应被去重快速路径跳过，
    // 否则清片/清理后再播放同一 URL 会黑屏。
    appliedSourceUrlRef.current = null
  }, [])

  /**
   * attach 的内部实现（不入队）。调用方必须已处于串行上下文中。
   * 切换顺序：先 cleanup 旧引擎（中断其下载），再 reset video，最后 attach 新引擎。
   */
  const attachInner = useCallback(
    async (
      video: HTMLVideoElement,
      source: PlayerSource,
      authRetried = false
    ): Promise<void> => {
      const previousUrl = appliedSourceUrlRef.current
      try {
        // cleanup 会清空 appliedSourceUrlRef（引擎销毁后旧标记失效），
        // 因此新源的标记必须在 cleanup 之后写入。
        cleanup()
        resetVideoElement(video)
        appliedSourceUrlRef.current = source.url
        // playsvideo 的启用由 shouldUsePlaysVideo 依据容器/音轨与浏览器
        // 能力决定，不受任何开关门控（自研引擎已移除，playsvideo 是唯一
        // 的浏览器端重封装与转码路径）。
        let engine = selectEngine(source)
        try {
          const result = await engine.attach(video, source)
          if (!mountedRef.current) {
            // 组件已卸载（影片切换重挂载）：attach 在游离 video 上完成，
            // 立即销毁引擎防止其继续输出声音（引擎内部可能已起播）。
            try {
              result.cleanup?.()
            } catch {
              /* ignore */
            }
            return
          }
          if (result.blobUrl) {
            blobUrlRef.current = result.blobUrl
          }
          engineCleanupRef.current = result.cleanup
          playerRef.current = result.player ?? null
        } catch (err) {
          // 鉴权失效：媒体 URL（appendAuthToken）嵌入的 access token 过期，
          // 引擎取流报 401/403。媒体请求不走 apiFetch（无内置刷新），
          // 此处强制 refresh 后重试一次；引擎内 appendAuthToken 实时读取
          // localStorage，重试自动携带新 token。authRetried 防止无限循环。
          if (isAuthExpiredError(err) && !authRetried) {
            const refreshed = await refreshAccessToken()
            if (refreshed) {
              console.warn(
                '[usePlayerSource] 媒体请求鉴权失效，token 已刷新，重试 attach'
              )
              return attachInnerRef.current(video, source, true)
            }
          }
          if (
            source.mkvFastPath &&
            engine.type === 'direct' &&
            !source.forcePlaysVideo
          ) {
            // MKV 快速路径：原生 attach 失败（metadata 就绪前 error 事件，
            // 如 HEVC-10bit 视频编码 Chrome 原生不支持）时回退 playsvideo
            // 重封装管线。与下方 onNativeError 监听器互补：那个覆盖
            // attach 成功后的播放期 error，这里覆盖 attach 期间的 error。
            console.warn(
              '[usePlayerSource] MKV 原生 attach 失败，回退 playsvideo 管线:',
              err
            )
            source.forcePlaysVideo = true
            resetVideoElement(video)
            const pipelineSource: PlayerSource = {
              ...source,
              forcePlaysVideo: true,
            }
            const pipelineEngine = selectEngine(pipelineSource)
            const result = await pipelineEngine.attach(video, pipelineSource)
            if (!mountedRef.current) {
              try {
                result.cleanup?.()
              } catch {
                /* ignore */
              }
              return
            }
            if (result.blobUrl) {
              blobUrlRef.current = result.blobUrl
            }
            engineCleanupRef.current = result.cleanup
            playerRef.current = result.player ?? null
          } else if (engine.type === 'playsvideo') {
            // playsvideo 引擎失败（容器不支持 / 探测超时 / 媒体流不可达等）
            // 时自动回退 direct 原生播放：宁可无声也不能让整段视频放不出来。
            console.warn(
              '[usePlayerSource] playsvideo 引擎挂载失败，回退原生播放:',
              err
            )
            resetVideoElement(video)
            // 回退要彻底回到原生：连音轨编码一并清掉，否则 DTS 等不兼容
            // 编码会让 selectEngine 再次选中 playsvideo，形成自我回退死循环。
            engine = selectEngine({
              ...source,
              format: undefined,
              audioCodec: undefined,
            })
            if (engine.type === 'playsvideo') {
              // 防御：selectEngine 不应再返回 playsvideo，此处兜底直取 direct
              engine = ENGINES.direct
            }
            const result2 = await engine.attach(video, source)
            if (!mountedRef.current) {
              try {
                result2.cleanup?.()
              } catch {
                /* ignore */
              }
              return
            }
            if (result2.blobUrl) {
              blobUrlRef.current = result2.blobUrl
            }
            engineCleanupRef.current = result2.cleanup
            playerRef.current = result2.player ?? null
          } else {
            throw err
          }
        }

        // MKV 快速路径：原生播放失败（video.error，如编码变体不受支持）
        // 时自动回退 playsvideo 管线。监听器一次性，换源/清理时移除；
        // 触发过的源对象会被置 forcePlaysVideo，防止重复回退。
        if (
          source.mkvFastPath &&
          engine.type === 'direct' &&
          !source.forcePlaysVideo
        ) {
          const onNativeError = () => {
            if (appliedSourceUrlRef.current !== source.url) return
            video.removeEventListener('error', onNativeError)
            if (mkvErrorCleanupRef.current === removeNativeError) {
              mkvErrorCleanupRef.current = null
            }
            const atTime = video.currentTime
            const wasPlaying = !video.paused
            console.warn(
              '[usePlayerSource] MKV 原生播放失败（video error），回退 playsvideo 管线'
            )
            source.forcePlaysVideo = true
            void enqueue(async () => {
              if (appliedSourceUrlRef.current !== source.url) return
              if (!mountedRef.current) return
              cleanup()
              resetVideoElement(video)
              appliedSourceUrlRef.current = source.url
              const pipelineSource: PlayerSource = {
                ...source,
                forcePlaysVideo: true,
              }
              const pipelineEngine = selectEngine(pipelineSource)
              const result = await pipelineEngine.attach(video, pipelineSource)
              if (!mountedRef.current) {
                try {
                  result.cleanup?.()
                } catch {
                  /* ignore */
                }
                return
              }
              if (result.blobUrl) {
                blobUrlRef.current = result.blobUrl
              }
              engineCleanupRef.current = result.cleanup
              playerRef.current = result.player ?? null
              // 恢复回退前的播放位置与播放状态
              if (atTime > 0) {
                try {
                  video.currentTime = atTime
                } catch {
                  /* ignore */
                }
              }
              if (wasPlaying && mountedRef.current) {
                void video.play().catch(() => {})
              }
            })
          }
          const removeNativeError = () => {
            video.removeEventListener('error', onNativeError)
          }
          video.addEventListener('error', onNativeError)
          mkvErrorCleanupRef.current = removeNativeError
        }
      } catch (err) {
        // 加载失败时回滚 appliedSourceUrlRef，允许下次重试
        appliedSourceUrlRef.current = previousUrl
        throw err
      }
    },
    [cleanup, enqueue]
  )
  // 更新稳定自引用（commit 后同步，供 token 刷新重试递归调用；
  // attach 由用户交互触发，晚于首次 effect 执行，无空窗）
  useEffect(() => {
    attachInnerRef.current = attachInner
  }, [attachInner])

  // 卸载感知：组件卸载（影片切换重挂载）后，进行中的 attach 完成时
  // 依据 mountedRef 拒绝落地并立即销毁引擎，防止游离 video 持续发声。
  // 卸载的同时清理引擎资源并暂停游离 video（React 已将其移出 DOM，
  // 浏览器不会因移出而停止播放）。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const video = options.videoRef.current
      if (video) {
        try {
          video.pause()
        } catch {
          /* ignore */
        }
      }
      cleanup()
      if (video) {
        resetVideoElement(video)
      }
    }
    // cleanup 是稳定引用（依赖为空）；_options.videoRef 是 RefObject，
    // 卸载时读取一次即弃，无需纳入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const attachSource = useCallback(
    async (video: HTMLVideoElement, source: PlayerSource) => {
      if (!source.url) {
        return
      }

      // 同一 sourceUrl 不重复加载（快速路径，不入队）
      if (appliedSourceUrlRef.current === source.url) {
        return
      }

      // 格式预检：浏览器 <video> 仅原生支持 mp4/webm/mov/mkv，DASH 通过 MSE 支持。
      // mkv 需 Chrome 91+ 且编码为 H.264/AAC。avi/wmv/ts 等容器直接赋值会抛 NotSupportedError。
      //
      // 但 avi/ts/wmv 可由 playsvideo 重封装为 fMP4 播放，因此不能一律拒绝——
      // 仅当「playsvideo 不会接管本源」时才判定为不可播。
      // 预检放在更新 appliedSourceUrlRef 之前，失败时不污染"已应用"标记。
      if (
        source.format &&
        !isBrowserPlayableFormat(source.format) &&
        !shouldUsePlaysVideo(source)
      ) {
        throw new Error(getUnsupportedFormatMessage(source.format))
      }

      await enqueue(async () => {
        // 入队期间可能已被其他操作应用了同一源（如 forceReload），再次去重
        if (appliedSourceUrlRef.current === source.url) {
          return
        }
        await attachInner(video, source)
      })
    },
    [enqueue, attachInner]
  )

  /**
   * seek 到目标时间。不重建 MediaSource。
   *
   * 引擎控制器存在时委托其 seekTo（abort 下载 → 清缓冲 → 从目标位置续传）；
   * 不存在（非 MSE 流）返回 { success: false }，调用方执行普通 seek。
   * needReload=true 表示不可恢复错误（video.error），需要上层 forceReload。
   */
  const seekTo = useCallback(
    async (
      _video: HTMLVideoElement,
      targetTime: number
    ): Promise<{
      success: boolean
      needReload?: boolean
      busy?: boolean
      message?: string
    }> => {
      const player = playerRef.current
      if (!player || !player.isAttached) {
        return { success: false }
      }
      return player.seekTo(targetTime)
    },
    []
  )

  /**
   * 强制重新 attach 源（重载按钮用）。
   *
   * - 串行化：进入与 attachSource 相同的队列，自然等待进行中的 attach 完成；
   * - 合并：执行期间再次调用仅更新 pendingReload，当前重载完成后继续执行最新一次；
   * - 彻底清理：cleanup + resetVideoElement + 重置 appliedSourceUrlRef。
   *
   * 调用方可通过 source.startTime 指定从目标位置附近开始下载（MSE 引擎）。
   */
  const forceReload = useCallback(
    async (video: HTMLVideoElement, source: PlayerSource) => {
      pendingReloadRef.current = source
      if (reloadScheduledRef.current) return
      reloadScheduledRef.current = true

      try {
        await enqueue(async () => {
          const latest = pendingReloadRef.current ?? source
          pendingReloadRef.current = null
          cleanup()
          resetVideoElement(video)
          await attachInner(video, latest)
        })
      } finally {
        reloadScheduledRef.current = false
        // 执行期间有新的重载请求：继续执行最新 source
        if (pendingReloadRef.current) {
          const next = pendingReloadRef.current
          pendingReloadRef.current = null
          void forceReload(video, next)
        }
      }
    },
    [enqueue, cleanup, attachInner]
  )

  return {
    attachSource,
    cleanup,
    appliedSourceUrlRef,
    playerRef,
    seekTo,
    forceReload,
  }
}
