/**
 * usePlayerSource Hook（v2 重写）。
 *
 * 负责将 PlayerSource 应用到 <video> 元素，使用 selectEngine 选择合适的引擎并调用 attach。
 *
 * 核心职责：
 * 1. 引擎选择与 attach（MSE / HLS / FLV / Direct）
 * 2. 资源清理（blobUrl / engine cleanup）
 * 3. appliedSourceUrl 跟踪：避免同一源被重复加载
 * 4. 全量操作串行化：attach / forceReload 进入同一条 Promise 队列，
 *    天然消除并发 attach 互相 abort 的问题
 * 5. MKV 快速路径回退（原生 → playsvideo 管线）与播放期错误提示
 *
 * 相比 v1 的改进：
 * - Promise 队列替代 isAttaching/isReloading 双锁与 5s 等待循环；
 * - 不再读写 video._mseAbortController：引擎的下载中断由
 *   engine cleanup（DashPlayer.cleanup 内部 abort attach 请求）负责；
 * - forceReload 多次调用合并为最新 source 的一次重载。
 *
 * 错误提示分工（attach 期 / 播放期）：
 * - attach 期失败：throw → 调用方（loadMovie / 恢复 effect）catch 提示
 * - 播放期失败：本 Hook 注册 video error 监听，经 options.onPlaybackError
 *   回调提示——错误知情权在引擎层（它知道回退是否可用/进行中），上层
 *   无需再做 1s 窗口 / 死亡判定等时序猜测。
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
  resolveProxyUrl,
  isLocalUrl,
  isRelativeUrl,
} from '@/modules/player'
import type {
  PlayerSource,
  PlayerController,
  EngineAttachResult,
} from '@/modules/player'
import { refreshAccessToken } from '@/lib/api'
import { formatVideoLoadError } from '@/modules/player/utils'

import {
  isBrowserPlayableFormat,
  getUnsupportedFormatMessage,
} from '@/lib/mediaFormat'

/**
 * 判断引擎错误是否为本站 API 媒体地址的鉴权失效（401/403）。
 *
 * 仅当源经代理策略决策后落在本站 API（/api/ 相对路径或同源绝对地址）时，
 * 401/403 才可能是 URL 内嵌 token 过期——媒体 URL（appendAuthToken）的
 * access token 过期可通过刷新后重试自愈（媒体请求不走 apiFetch，无内置
 * 刷新）。第三方源直连的 403（如 B站 MP4 CDN 签名过期）刷新 token 无效，
 * 不应触发无谓的刷新重试往返。
 */
function isAuthExpiredError(err: unknown, source: PlayerSource): boolean {
  let routed: string
  try {
    routed = resolveProxyUrl(source.url, source.headers, source.format, {
      noProxyFallback: source.noProxyFallback === true,
    })
  } catch {
    return false
  }
  if (!isRelativeUrl(routed) && !isLocalUrl(routed)) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /\b(401|403)\b/.test(msg)
}

export interface UsePlayerSourceOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  /**
   * 播放期错误回调：attach 成功后发生的 video.error 且无引擎层恢复
   * 路径（或恢复失败）时调用。调用方负责展示；B站源的播放期错误由
   * 其自动重载链路负责，调用方应自行过滤。
   */
  onPlaybackError?: (err: Error) => void
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
  /** 清理所有引擎资源（blobUrl / engine cleanup） */
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

/** MKV 快速路径回退 playsvideo 管线的结果 */
type PlaysVideoFallbackOutcome =
  | { kind: 'attached' }
  /** 引擎被两级开关禁用（系统级 / 影片级任一关闭） */
  | { kind: 'disabled' }
  /** 组件已卸载（影片切换重挂载），无需任何处理 */
  | { kind: 'unmounted' }
  /** 管线 attach 失败 */
  | { kind: 'error'; error: unknown }

export function usePlayerSource(
  options: UsePlayerSourceOptions
): UsePlayerSourceReturn {
  const blobUrlRef = useRef<string | null>(null)
  const engineCleanupRef = useRef<(() => void) | null>(null)
  const appliedSourceUrlRef = useRef<string | null>(null)
  const playerRef = useRef<PlayerController | null>(null)
  // 播放期 error 监听器清理（新 attach 前移除旧的，防累积）
  const playbackErrorCleanupRef = useRef<(() => void) | null>(null)
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
  // attachPlaysVideoFallback 的稳定自引用：播放期 error 监听器（经
  // registerPlaybackErrorWatch 创建）需要引用它，两者 useCallback 相互
  // 依赖，以 ref 断开循环
  const attachPlaysVideoFallbackRef = useRef<
    (
      video: HTMLVideoElement,
      source: PlayerSource,
      resume?: { time: number; playing: boolean }
    ) => Promise<PlaysVideoFallbackOutcome>
  >(async () => ({ kind: 'disabled' }))
  // 播放期错误回调的稳定引用（调用方可能每次渲染传入新函数）
  const onPlaybackErrorRef = useRef(options.onPlaybackError)
  // 卸载标记：切换影片时 WatchTogetherPanel 按 key 整体重挂载
  // （usePlayerRemountKey），旧面板的 loadMovie effect 已启动的 attach
  // 会在卸载后继续完成。没有该标记时，attach 会把引擎挂到已被 React
  // 移除的游离 video 上，其声音持续输出（每切一次片泄漏一个声音源）。
  const mountedRef = useRef(true)

  useEffect(() => {
    onPlaybackErrorRef.current = options.onPlaybackError
  }, [options.onPlaybackError])

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
    // 移除播放期 error 监听器（换源/清理时不再需要）
    if (playbackErrorCleanupRef.current) {
      playbackErrorCleanupRef.current()
      playbackErrorCleanupRef.current = null
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
   * attach 结果落地：卸载时立即销毁引擎（防游离 video 持续出声），
   * 正常时记录 blobUrl / 清理句柄 / 控制器。
   *
   * @returns 是否落地成功（false = 组件已卸载，调用方应直接终止）
   */
  const applyAttachResult = useCallback(
    (result: EngineAttachResult): boolean => {
      if (!mountedRef.current) {
        try {
          result.cleanup?.()
        } catch {
          /* ignore */
        }
        return false
      }
      if (result.blobUrl) {
        blobUrlRef.current = result.blobUrl
      }
      engineCleanupRef.current = result.cleanup
      playerRef.current = result.player ?? null
      return true
    },
    []
  )

  /**
   * 注册播放期 error 监听（一次性）。
   *
   * attach 成功（含 MKV 回退成功）后调用。播放期 video.error 没有
   * 引擎层恢复路径时经 onPlaybackError 回调提示；MKV 快速路径的
   * direct 源例外——原生播放失败先尝试回退 playsvideo 管线，
   * 回退不可用或失败时才提示。
   */
  const registerPlaybackErrorWatch = useCallback(
    (
      video: HTMLVideoElement,
      watchedSource: PlayerSource,
      engineType: string
    ) => {
      const onVideoError = () => {
        // 源已被后续操作切换：本监听器过期，静默自移除
        if (appliedSourceUrlRef.current !== watchedSource.url) return
        video.removeEventListener('error', onVideoError)
        if (playbackErrorCleanupRef.current === removeListener) {
          playbackErrorCleanupRef.current = null
        }
        // 同步快照错误详情：回退重挂载会 reset video，error 对象随之失效
        const reason = formatVideoLoadError(video.error?.code)

        // MKV 快速路径：原生播放失败（video.error，如编码变体不受支持）
        // → 回退 playsvideo 管线，恢复播放位置与播放状态
        if (
          watchedSource.mkvFastPath &&
          engineType === 'direct' &&
          !watchedSource.forcePlaysVideo
        ) {
          const atTime = video.currentTime
          const wasPlaying = !video.paused
          console.warn(
            '[usePlayerSource] MKV 原生播放失败（video error），回退 playsvideo 管线'
          )
          void enqueue(async () => {
            if (appliedSourceUrlRef.current !== watchedSource.url) return
            if (!mountedRef.current) return
            const outcome = await attachPlaysVideoFallbackRef.current(
              video,
              watchedSource,
              { time: atTime, playing: wasPlaying }
            )
            if (outcome.kind === 'disabled') {
              // 引擎被两级开关禁用：无回退路径，提示开启引导
              onPlaybackErrorRef.current?.(
                new Error(
                  `原生播放中断：${reason}。` +
                    '可在「系统设置」或该影片的解析设置中开启「浏览器转码引擎」后重试'
                )
              )
            } else if (outcome.kind === 'error') {
              onPlaybackErrorRef.current?.(
                new Error(
                  `回退浏览器转码引擎失败：${
                    outcome.error instanceof Error
                      ? outcome.error.message
                      : String(outcome.error)
                  }。可尝试重载影片`
                )
              )
            }
            // attached / unmounted：无需提示
          })
          return
        }

        // 无恢复路径：直接提示（直链模式给出更具体的修复指引）
        if (watchedSource.noProxyFallback) {
          onPlaybackErrorRef.current?.(
            new Error(`直链播放中断：${reason}。可尝试重载或重新添加影片`)
          )
        } else {
          onPlaybackErrorRef.current?.(
            new Error(`播放中断：${reason}。可尝试重载影片`)
          )
        }
      }
      const removeListener = () => {
        video.removeEventListener('error', onVideoError)
      }
      // 移除旧监听（连续 attach / 回退重挂载场景，防累积）
      playbackErrorCleanupRef.current?.()
      video.addEventListener('error', onVideoError)
      playbackErrorCleanupRef.current = removeListener
    },
    [enqueue]
  )

  /**
   * MKV 快速路径回退：改由 playsvideo 管线重挂载（attach 期与播放期共用）。
   *
   * 调用方负责解读结果：attach 期 disabled 抛开启引导、error 向上抛；
   * 播放期经 onPlaybackError 回调提示。
   */
  const attachPlaysVideoFallback = useCallback(
    async (
      video: HTMLVideoElement,
      source: PlayerSource,
      resume?: { time: number; playing: boolean }
    ): Promise<PlaysVideoFallbackOutcome> => {
      // 置位运行时回退标记：后续同源重载（forceReload）直接走管线，
      // 避免重复原生失败；亦防止回退后的播放期监听再次进入回退分支
      source.forcePlaysVideo = true
      const pipelineSource: PlayerSource = { ...source, forcePlaysVideo: true }
      const pipelineEngine = selectEngine(pipelineSource)
      if (pipelineEngine.type === 'direct') {
        // 引擎被两级开关（系统级 / 影片级）禁用：尊重用户选择不启动管线
        return { kind: 'disabled' }
      }
      cleanup()
      resetVideoElement(video)
      appliedSourceUrlRef.current = source.url
      try {
        const result = await pipelineEngine.attach(video, pipelineSource)
        if (!applyAttachResult(result)) return { kind: 'unmounted' }
        // 恢复回退前的播放位置与播放状态（播放期回退传入 resume）
        if (resume && resume.time > 0) {
          try {
            video.currentTime = resume.time
          } catch {
            /* ignore */
          }
        }
        if (resume?.playing && mountedRef.current) {
          void video.play().catch(() => {})
        }
        registerPlaybackErrorWatch(video, pipelineSource, pipelineEngine.type)
        return { kind: 'attached' }
      } catch (err) {
        return { kind: 'error', error: err }
      }
    },
    [cleanup, applyAttachResult, registerPlaybackErrorWatch]
  )
  useEffect(() => {
    attachPlaysVideoFallbackRef.current = attachPlaysVideoFallback
  }, [attachPlaysVideoFallback])

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
        const engine = selectEngine(source)
        try {
          const result = await engine.attach(video, source)
          if (!applyAttachResult(result)) return
        } catch (err) {
          // 鉴权失效：媒体 URL（appendAuthToken）嵌入的 access token 过期，
          // 引擎取流报 401/403。媒体请求不走 apiFetch（无内置刷新），
          // 此处强制 refresh 后重试一次；引擎内 appendAuthToken 实时读取
          // localStorage，重试自动携带新 token。authRetried 防止无限循环。
          if (isAuthExpiredError(err, source) && !authRetried) {
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
            // 重封装管线。与播放期监听器（registerPlaybackErrorWatch）
            // 互补：那个覆盖 attach 成功后的 error，这里覆盖 attach 期间的
            // error。
            console.warn(
              '[usePlayerSource] MKV 原生 attach 失败，回退 playsvideo 管线:',
              err
            )
            const outcome = await attachPlaysVideoFallback(video, source)
            if (outcome.kind === 'disabled') {
              // 引擎被两级开关禁用（系统级/影片级任一关闭）：尊重用户
              // 选择不启动管线，回退路径不存在，直接抛出带开启引导的
              // 错误（经调用方 message.error 展示），而非静默黑屏。
              throw new Error(
                `原生播放失败：${formatVideoLoadError(video.error?.code)}。` +
                  '可在「系统设置」或该影片的解析设置中开启「浏览器转码引擎」后重试',
                { cause: err }
              )
            }
            if (outcome.kind === 'error') throw outcome.error
            // attached / unmounted：结束本次 attach
            return
          }
          if (engine.type === 'playsvideo') {
            // playsvideo 引擎失败（容器不支持 / 探测超时 / 媒体流不可达
            // 等）：不再静默回退原生播放——回退原生会造成无声（DTS 等编
            // 码）或再次解码失败的困惑体验，直接抛错由调用方提示，用户
            // 可选择重载影片或关闭引擎改用原生。
            throw new Error(
              `浏览器转码引擎（playsvideo）播放失败：${
                err instanceof Error ? err.message : String(err)
              }，可尝试重载影片`,
              { cause: err }
            )
          }
          throw err
        }

        // attach 成功：注册播放期 error 监听（回退 / 提示的统一入口）
        registerPlaybackErrorWatch(video, source, engine.type)
      } catch (err) {
        // 加载失败时回滚 appliedSourceUrlRef，允许下次重试
        appliedSourceUrlRef.current = previousUrl
        throw err
      }
    },
    [
      cleanup,
      applyAttachResult,
      attachPlaysVideoFallback,
      registerPlaybackErrorWatch,
    ]
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
