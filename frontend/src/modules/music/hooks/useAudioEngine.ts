import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { useMusicSettingsStore } from '../store-settings'
import type { MusicQueueItem, PlayMode } from '../types'
import {
  mountMediaElement,
  playAudioWithRetry,
  unmountMediaElement,
} from './audioElement'

interface UseAudioEngineOptions {
  /** 本地音量镜像（创建音频元素时应用；音量本身由调用方持有状态） */
  volumeRef: MutableRefObject<number>
  /** ended 处理器的最新实现（handleEnded 随依赖重建，经 ref 间接调用） */
  endedHandlerRef: MutableRefObject<() => void>
  /** 预载目标（下一首；null 表示无需预载）——顺序/随机规则由调用方决定 */
  peekNextSong: () => MusicQueueItem | null
  /** 队列条目 → 音频流地址（B站 条目取已解析缓存） */
  buildUrl: (item: MusicQueueItem) => string
  /**
   * 预载 effect 的重算触发依赖：当前曲目 / 队列 / 播放模式变化即重新预载，
   * 与重构前 `useEffect` 的依赖表一致。
   */
  currentKey: string | null
  queue: MusicQueueItem[]
  playMode: PlayMode
}

export interface AudioEngine {
  /** 主播放元素（未创建前为 null；同步状态与自检只读） */
  audioRef: MutableRefObject<HTMLAudioElement | null>
  /** 惰性获取主播放元素（首次调用创建并挂 DOM，创建时应用持久化音量） */
  getAudio: () => HTMLAudioElement
  /**
   * 加载指定流地址并起播/暂停。预载元素已缓冲同一首歌时直接升格为主播放
   * 元素并迁移事件监听（零网络/零加载等待），否则退回主元素重新 load。
   */
  playSource: (url: string, positionSec: number, shouldPlay: boolean) => void
  /** 房间媒体拆除：暂停主/预载元素；full 时连 src 一并丢弃（断线仅暂停） */
  stopAll: (full: boolean) => void
  /** 卸载释放：主/预载元素资源全清并清空内部引用 */
  dispose: () => void
}

/**
 * 一起听音频引擎：主播放元素与无缝预载元素的生命周期。
 *
 * 职责边界：
 * - 本 hook 只管「元素」——创建、挂 DOM、绑定生命周期事件、预缓冲下一首、
 *   预载升格、停止与释放。
 * - 调用方只管「播什么」——队列/播放模式解析、B站 音频懒解析、同步广播。
 *
 * 两个元素都是惰性创建且不渲染进 React 树（MediaSession 系统媒体通知要求
 * 媒体元素在 DOM 内，见 mountMediaElement）。事件处理器元素无关化：全部经
 * `e.currentTarget` / ref 访问状态，因此同一组监听器可在「主播放元素 ↔
 * 预载元素」之间迁移（升格时迁移）。
 */
export function useAudioEngine({
  volumeRef,
  endedHandlerRef,
  peekNextSong,
  buildUrl,
  currentKey,
  queue,
  playMode,
}: UseAudioEngineOptions): AudioEngine {
  /** 主播放元素（惰性创建，不挂 React 树） */
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** 换曲后的起始进度（loadedmetadata 时应用） */
  const pendingSeekRef = useRef(0)
  /** 无缝衔接（设置：歌曲无缝衔接）的预缓冲元素 */
  const preloadRef = useRef<HTMLAudioElement | null>(null)
  const gaplessPlayback = useMusicSettingsStore((s) => s.gaplessPlayback)

  /** 惰性获取 audio 元素（首次使用时创建并挂 DOM，创建时应用持久化音量） */
  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio()
      audio.preload = 'auto'
      audio.muted = volumeRef.current === 0
      audio.volume = volumeRef.current
      mountMediaElement(audio)
      audioRef.current = audio
    }
    return audioRef.current
  }, [volumeRef])

  /**
   * 六个音频生命周期事件的稳定 handler 集合（useState 惰性初始化，仅创建一次；
   * 项目 lint 规则禁止 render 期读写 ref，故不用 useRef 惰性初始化）。
   */
  const [audioHandlers] = useState<{
    timeupdate: (e: Event) => void
    play: () => void
    pause: () => void
    ended: () => void
    loadedmetadata: (e: Event) => void
    error: (e: Event) => void
  }>(() => ({
    timeupdate: (e) => {
      const el = e.currentTarget as HTMLAudioElement
      useMusicStore.getState().setPositionSec(el.currentTime)
    },
    play: () => {
      useMusicStore.getState().setPlaying(true)
    },
    pause: () => {
      useMusicStore.getState().setPlaying(false)
    },
    ended: () => {
      endedHandlerRef.current()
    },
    loadedmetadata: (e) => {
      // 换曲后的起始进度（如观众从房主进度起播）
      const el = e.currentTarget as HTMLAudioElement
      if (pendingSeekRef.current > 0) {
        try {
          el.currentTime = pendingSeekRef.current
        } catch {
          // ignore
        }
        pendingSeekRef.current = 0
      }
    },
    error: (e) => {
      // 流加载失败（无版权/纯 VIP 未登录/解析失败等后端结构化错误；
      // 直链模式下 CDN 链接过期/失效同样在此报错，不回退代理流）
      const el = e.currentTarget as HTMLAudioElement
      console.error(
        '[useListenTogether] 音频流加载失败:',
        el.error?.code,
        el.error?.message
      )
      message.error('音频加载失败，请稍后重试或切换其他曲目')
    },
  }))

  /** 在指定音频元素上挂载生命周期事件（初始化/升格共用） */
  const attachAudioHandlers = useCallback(
    (el: HTMLAudioElement) => {
      el.addEventListener('timeupdate', audioHandlers.timeupdate)
      el.addEventListener('play', audioHandlers.play)
      el.addEventListener('pause', audioHandlers.pause)
      el.addEventListener('ended', audioHandlers.ended)
      el.addEventListener('loadedmetadata', audioHandlers.loadedmetadata)
      el.addEventListener('error', audioHandlers.error)
    },
    [audioHandlers]
  )

  /** 从指定音频元素上卸载生命周期事件（升格时从旧主元素移除） */
  const detachAudioHandlers = useCallback(
    (el: HTMLAudioElement) => {
      el.removeEventListener('timeupdate', audioHandlers.timeupdate)
      el.removeEventListener('play', audioHandlers.play)
      el.removeEventListener('pause', audioHandlers.pause)
      el.removeEventListener('ended', audioHandlers.ended)
      el.removeEventListener('loadedmetadata', audioHandlers.loadedmetadata)
      el.removeEventListener('error', audioHandlers.error)
    },
    [audioHandlers]
  )

  /** 复位指定音频元素：停止并释放已缓冲的流资源，
   *  同时从 DOM 移除（挂载与退役配对，防隐藏元素残留堆积） */
  const resetAudioElement = useCallback((el: HTMLAudioElement) => {
    el.pause()
    el.removeAttribute('src')
    try {
      // 空源 load()：中止当前加载并释放缓冲（MDN 推荐的资源释放方式）
      el.load()
    } catch {
      // ignore
    }
    unmountMediaElement(el)
  }, [])

  // 初始主元素的挂载/卸载：handler 集合元素无关（升格时随元素迁移）
  useEffect(() => {
    const audio = getAudio()
    attachAudioHandlers(audio)
    return () => detachAudioHandlers(audio)
  }, [getAudio, attachAudioHandlers, detachAudioHandlers])

  // 预缓冲下一首：提前建立 HTTP/媒体缓存，切歌时近乎零等待
  //（gaplessPlayback 的 Web 等价实现；封面预取不受开关限制，资源极轻）
  useEffect(() => {
    const target = peekNextSong()
    // 封面预取：提前拉取下一首封面进 HTTP 缓存（同 URL 重复预取由浏览器
    // HTTP 缓存兜底，不产生额外网络请求）
    if (target?.cover) {
      const img = new Image()
      img.src = target.cover
    }
    const targetUrl = target ? buildUrl(target) : null
    // 幂等复用（同 key 同 quality 复用）：目标未变且预载元素健康时
    // 保留已缓冲进度，避免队列重排等无关变化触发重复加载
    const existing = preloadRef.current
    if (
      gaplessPlayback &&
      targetUrl != null &&
      existing != null &&
      existing.src === targetUrl &&
      existing.error == null
    ) {
      return
    }
    // 退役旧预载元素：停止并释放已缓冲的流资源
    //（若已被升格为主播放元素，preloadRef 已在升格时被消费置 null，不在此误停主播放）
    if (existing) {
      resetAudioElement(existing)
    }
    preloadRef.current = null
    if (!gaplessPlayback || !target || targetUrl == null) return
    const el = new Audio()
    el.preload = 'auto'
    // 预载元素同步主元素的音量/静音（升格接管时仍会再校准一次）
    const currentAudio = audioRef.current
    if (currentAudio) {
      el.volume = currentAudio.volume
      el.muted = currentAudio.muted
    }
    // 挂 DOM：预载元素升格为主播放元素后承载 MediaSession 展示
    mountMediaElement(el)
    el.src = targetUrl
    preloadRef.current = el
    return () => {
      // 该元素已被升格为主播放元素时（preloadRef 不再指向它），绝不能暂停
      if (preloadRef.current === el) {
        el.pause()
        preloadRef.current = null
      }
    }
  }, [
    gaplessPlayback,
    peekNextSong,
    buildUrl,
    currentKey,
    queue,
    playMode,
    resetAudioElement,
  ])

  const playSource = useCallback(
    (url: string, positionSec: number, shouldPlay: boolean) => {
      const audio = getAudio()

      // ===== 预载升格路径 =====
      // 条件：同一 URL（流地址稳定：同 songId/level/roomId/token）、
      // readyState ≥ HAVE_FUTURE_DATA（可连续播放）、无加载错误
      const preloaded = preloadRef.current
      if (
        preloaded != null &&
        preloaded !== audio &&
        preloaded.src === url &&
        preloaded.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
        preloaded.error == null
      ) {
        // 1) 事件迁移：先从旧主元素摘除（避免 pause 触发暂停状态镜像）
        detachAudioHandlers(audio)
        // 2) 停止旧播放（事件已摘除，不会误镜像暂停状态）并从 DOM 移除
        //    （元素角色已被预载元素接替，残留隐藏元素会堆积）
        audio.pause()
        unmountMediaElement(audio)
        // 3) 挂载事件并接管角色；预载槽消费置空（预载 effect 会重新预载下一首）
        attachAudioHandlers(preloaded)
        audioRef.current = preloaded
        preloadRef.current = null
        // 4) 同步音量/静音（主元素是音量设置的权威来源）
        preloaded.volume = audio.volume
        preloaded.muted = audio.muted
        // 5) 元数据已就绪（readyState 校验），起始进度直接生效
        if (positionSec > 0) {
          try {
            preloaded.currentTime = positionSec
          } catch {
            // ignore
          }
        }
        if (shouldPlay) {
          playAudioWithRetry(preloaded)
        } else {
          preloaded.pause()
        }
        return
      }

      // ===== 原路径（未命中预载） =====
      if (audio.src === url && audio.readyState >= 1) {
        // 同一曲目且元数据已就绪（重播/循环）：直接 seek
        try {
          audio.currentTime = positionSec
        } catch {
          // ignore
        }
      } else {
        // 新曲目或仍在加载：记录起始进度，待 loadedmetadata 后应用
        pendingSeekRef.current = positionSec
        if (audio.src !== url) {
          audio.src = url
          audio.load()
        }
      }
      if (shouldPlay) {
        playAudioWithRetry(audio)
      } else {
        audio.pause()
      }
    },
    [getAudio, attachAudioHandlers, detachAudioHandlers]
  )

  /** 停止指定元素；full 时丢弃 src（预载元素同时从 DOM 移除，防隐藏元素残留） */
  const stopAll = useCallback((full: boolean) => {
    const stopEl = (el: HTMLAudioElement) => {
      el.pause()
      if (full) {
        el.removeAttribute('src')
        el.load()
      }
    }
    if (audioRef.current) stopEl(audioRef.current)
    if (preloadRef.current) {
      stopEl(preloadRef.current)
      if (full) {
        // 引用即将丢弃，从 DOM 一并移除（否则隐藏元素残留 body 无法 GC）
        unmountMediaElement(preloadRef.current)
        preloadRef.current = null
      }
    }
  }, [])

  const dispose = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.srcObject = null
      audio.removeAttribute('src')
      audio.load()
      unmountMediaElement(audio)
    }
    audioRef.current = null
    const preload = preloadRef.current
    if (preload) {
      preload.pause()
      preload.removeAttribute('src')
      try {
        preload.load()
      } catch {
        // ignore
      }
      unmountMediaElement(preload)
    }
    preloadRef.current = null
    pendingSeekRef.current = 0
  }, [])

  return { audioRef, getAudio, playSource, stopAll, dispose }
}
