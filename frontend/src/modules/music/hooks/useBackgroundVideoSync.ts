/**
 * 自定义视频背景同步 Hook（Hydrogen PlayerVideo 的播放侧复刻）。
 *
 * 背景 MV 与音频是两个独立媒体元素：画面要跟随音频进度走，而二者会随时间
 * 自然漂移（编解码、缓冲、自动播放策略都可能让视频停在原地）。本 hook 负责
 * 这条链路的全部播放侧行为，原先内联在 ListenTogetherPanel 里：
 *
 * - **可见性门控**：源就绪 ≠ 画面就绪。等 video 上报 canplay/playing 后才
 *   淡入，未就绪期间透出封面模糊背景；可见性按「已就绪 URL = 当前源 URL」
 *   派生，切歌/重解析瞬间自动回到未就绪态（无需清理 effect）
 * - **attach**：源就绪后交给播放引擎（按 format 选 MSE/Direct），attach 完成
 *   （CLI DASH 要拉 init 段/扫描 sidx，可耗时数秒）立刻对齐进度并恢复播放
 * - **漂移校正**：正常 1x 漂移远小于阈值，只在卡顿/seek 后安排——先经去抖
 *   窗口（拖动期间只更新目标，停止后仅一次 seek），再进入「倍速追赶」用
 *   playbackRate 渐进吸收残余漂移（顺序解码远比再次 seek 便宜）
 * - **跟随暂停**：视频元素恒静音（音频由音轨承担），仅跟随音频 play/pause
 *
 * 调参常量见 constants.ts（`BG_VIDEO_*`）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePlayerSource } from '@/modules/player'
import {
  BG_VIDEO_CATCHUP_EPSILON_SEC,
  BG_VIDEO_CATCHUP_GAIN_SEC,
  BG_VIDEO_MAX_RATE,
  BG_VIDEO_MIN_RATE,
  BG_VIDEO_SEEK_DEBOUNCE_MS,
  BG_VIDEO_SYNC_THRESHOLD_SEC,
} from '../constants'
import { getPositionSec } from './usePlaybackPosition'
import type {
  MusicVideoBgStatus,
  MusicVideoSource,
} from './useMusicVideoBackground'

export interface BackgroundVideoSyncOptions {
  /** 当前背景视频源（null = 当前曲目无关联视频） */
  source: MusicVideoSource | null
  /** 源解析状态（'ready' 才允许 attach / 播放） */
  status: MusicVideoBgStatus
  /** 音频是否在播放（视频跟随暂停/继续） */
  isPlaying: boolean
}

export function useBackgroundVideoSync({
  source,
  status,
  isPlaying,
}: BackgroundVideoSyncOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sourceUrl = source?.url ?? null

  /** 已就绪（首帧可播）的源 URL：与当前源一致才认为画面可见 */
  const [readyUrl, setReadyUrl] = useState<string | null>(null)
  const visible = sourceUrl != null && readyUrl === sourceUrl
  /** 背景视频是否已就绪可用于纯净模式（有源即可，不等首帧） */
  const hasSource = sourceUrl != null

  // 进度同步辅助态：seek 去抖定时器 / 待 seek 目标 / seek 后倍速追赶模式
  const seekDebounceRef = useRef<number | null>(null)
  const seekPendingRef = useRef<number | null>(null)
  const catchUpRef = useRef(false)
  const { attachSource, cleanup } = usePlayerSource({ videoRef })

  /**
   * 把视频进度拉回音频进度（音频长于视频时按视频时长取模循环）。
   * force = true 时无视一切直接跳（metadata 就绪 / 切歌 / 中途加入房间）。
   */
  const syncBgVideoTime = useCallback((force: boolean) => {
    const video = videoRef.current
    if (!video || video.readyState < 1) return
    const dur = video.duration
    if (!Number.isFinite(dur) || dur <= 0) return
    const target = getPositionSec() % dur
    if (force) {
      // 强制对齐（metadata 就绪/切歌）：清追赶态后直接跳
      if (seekDebounceRef.current != null) {
        clearTimeout(seekDebounceRef.current)
        seekDebounceRef.current = null
      }
      seekPendingRef.current = null
      catchUpRef.current = false
      if (video.playbackRate !== 1) video.playbackRate = 1
      try {
        video.currentTime = target
      } catch {
        // 引擎未就绪等 seek 失败静默忽略，等待下轮校正
      }
      return
    }
    const drift = target - video.currentTime // 正 = 视频落后于音频
    // 缓冲不足（readyState < HAVE_FUTURE_DATA）时跳过漂移校正：DASH/MSE
    // 引擎每次 seek 都要重新拉取分片，连续 seek 会引发缓冲风暴（切歌/
    // 换分辨率后的持续卡顿即由此而来）——等缓冲恢复后下一轮再对齐
    if (video.readyState < 3) return
    if (Math.abs(drift) > BG_VIDEO_SYNC_THRESHOLD_SEC) {
      // 大漂移：去抖 seek——窗口内重复触发只刷新目标，最终一次跳转
      seekPendingRef.current = target
      if (seekDebounceRef.current == null) {
        seekDebounceRef.current = window.setTimeout(() => {
          seekDebounceRef.current = null
          const pending = seekPendingRef.current
          seekPendingRef.current = null
          if (pending == null) return
          try {
            // 目标可能已随音频前移/换源，按当前时长取模保护
            video.currentTime = pending % (video.duration || 1)
            catchUpRef.current = true // seek 后倍速吸收残余漂移
          } catch {
            // 引擎未就绪等 seek 失败静默忽略，等待下轮校正
          }
        }, BG_VIDEO_SEEK_DEBOUNCE_MS)
      }
      return
    }
    if (catchUpRef.current) {
      // 追赶模式：漂移在阈值内但尚未对齐——倍速渐进吸收，避免二次 seek
      if (Math.abs(drift) <= BG_VIDEO_CATCHUP_EPSILON_SEC) {
        catchUpRef.current = false
        if (video.playbackRate !== 1) video.playbackRate = 1
      } else {
        // 落后则略加速追上，超前则略减速让音频追上（无声背景，无感知）
        const rate = Math.min(
          BG_VIDEO_MAX_RATE,
          Math.max(BG_VIDEO_MIN_RATE, 1 + drift / BG_VIDEO_CATCHUP_GAIN_SEC)
        )
        if (Math.abs(video.playbackRate - rate) > 0.01) {
          try {
            video.playbackRate = rate
          } catch {
            // ignore
          }
        }
      }
    }
  }, [])

  // 解析成功 → attach 到背景 video（引擎按 format 选 MSE/Direct；B站 CDN
  // 直链由引擎经后端代理注入 Referer，CLI 模式本身已是本地代理 URL）
  useEffect(() => {
    const video = videoRef.current
    if (!video || status !== 'ready' || !source?.url) {
      return
    }
    void attachSource(video, {
      url: source.url,
      audioUrl: source.audioUrl,
      format: source.format,
      videoCodec: source.videoCodec,
      audioCodec: source.audioCodec,
      // DASH 流容器时长不可靠：显式传给引擎写 MPD duration，
      // 缺失时 video.duration 无效、背景视频进度同步失效
      duration: source.duration,
    }).then(() => {
      // attach 完成（CLI DASH 引擎要拉 init 段/扫描 sidx，可耗时数秒）后
      // 对齐音频进度并恢复播放——play() 此前只在 isPlaying/status 变化时
      // 触发一次，attach 慢时那次 play() 落在尚未就绪的元素上被静默拒绝，
      // 视频停在原地被 1s 校正循环反复大漂移 seek（表现为切歌/换分辨率后
      // 持续卡顿，暂停再播放才恢复）
      syncBgVideoTime(true)
      if (isPlaying) {
        void video.play().catch(() => {
          // ignore：自动播放策略拒绝
        })
      }
    })
  }, [status, source, attachSource, isPlaying, syncBgVideoTime])

  // 卸载时释放引擎资源（blobUrl / MSE）
  useEffect(() => cleanup, [cleanup])

  // 背景视频跟随音乐播放/暂停（Hydrogen videoIsPlaying 同语义；元素静音）
  useEffect(() => {
    const video = videoRef.current
    if (!video || status !== 'ready') return
    if (isPlaying) {
      void video.play().catch(() => {
        // ignore：自动播放策略拒绝
      })
    } else if (!video.paused) {
      video.pause()
    }
  }, [isPlaying, status])

  // 漂移校正驱动：interval 1s 命令式读取进度（positionSec 高频更新不再
  // 经由 React effect 触发）；播放中正常 1x 漂移远小于阈值，仅卡顿/seek
  // 后才安排校正。未就绪时不排程（sync 内部亦有护栏）
  useEffect(() => {
    if (!sourceUrl) return
    const timer = setInterval(() => syncBgVideoTime(false), 1000)
    return () => clearInterval(timer)
  }, [sourceUrl, syncBgVideoTime])

  // 卸载时清 seek 去抖定时器（追赶态随元素销毁失效，无需处理）
  useEffect(
    () => () => {
      if (seekDebounceRef.current != null) {
        clearTimeout(seekDebounceRef.current)
        seekDebounceRef.current = null
      }
    },
    []
  )

  /** video 元素事件接线：门控升级（canplay/playing）与强制对齐（metadata） */
  const videoHandlers = useMemo(
    () => ({
      onLoadedMetadata: () => syncBgVideoTime(true),
      onCanPlay: () => setReadyUrl(sourceUrl),
      onPlaying: () => setReadyUrl(sourceUrl),
    }),
    [syncBgVideoTime, sourceUrl]
  )

  return {
    /** 背景 video 元素 ref（挂到 <video>） */
    videoRef,
    /** 画面是否可显现（源已就绪且首帧可播） */
    visible,
    /** 是否存在可用背景源（纯净模式可用性判定） */
    hasSource,
    /** 手动强制对齐（如外部感知到元信息刷新） */
    syncNow: syncBgVideoTime,
    /** video 元素事件接线 */
    videoHandlers,
  }
}
