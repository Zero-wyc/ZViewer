/**
 * PlayerControlBar —— 一起看播放器底部自定义玻璃拟态控制栏。
 *
 * 职责：
 * - 完全替代 ArtPlayer 原生控制栏（进度条、播放、音量、倍速、全屏等）。
 * - 复用 WatchTogetherCore 的业务回调：播放/暂停、seek、音量、倍速、弹幕、同步、重载、设置、全屏。
 * - 房主端可直接操作；观众端进度条只读并触发申请跳转，倍速下拉禁用。
 */
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  VolumeX,
  Settings,
  RotateCcw,
  RotateCw,
  Maximize2,
  Minimize2,
  Maximize,
  Minimize,
  Check,
  MoreHorizontal,
  Eye,
  EyeOff,
} from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import { clearUserPaused, markUserPaused } from '@/modules/player/services/pause-intent'
import { DanmakuInput } from '@/components/VideoPlayer/parts/DanmakuInput'
import type { WatchTogetherState } from '@/modules/sync-playback/types'

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
const VOLUME_STORAGE_KEY = 'zc-player-volume'

/** 弹幕开关图标：圆角屏幕内带"弹"字，关闭时叠加斜线。 */
function DanmakuIcon({ off }: { off?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="10"
        fontWeight="600"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      >
        弹
      </text>
      {off && <line x1="5" y1="5" x2="19" y2="19" />}
    </svg>
  )
}

function useVideoCurrentTime(
  videoRef: React.RefObject<HTMLVideoElement | null>
) {
  const [currentTime, setCurrentTime] = useState(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const update = () => setCurrentTime(video.currentTime)
    update()
    video.addEventListener('timeupdate', update)
    video.addEventListener('seeked', update)
    return () => {
      video.removeEventListener('timeupdate', update)
      video.removeEventListener('seeked', update)
    }
  }, [videoRef])

  return currentTime
}

function useVideoVolume(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const update = () => {
      setVolume(video.volume)
      setMuted(video.muted)
    }
    update()
    video.addEventListener('volumechange', update)
    return () => video.removeEventListener('volumechange', update)
  }, [videoRef])

  return { volume, muted }
}

function useVideoPlaybackRate(
  videoRef: React.RefObject<HTMLVideoElement | null>
) {
  const [rate, setRate] = useState(1)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const update = () => setRate(video.playbackRate)
    update()
    video.addEventListener('ratechange', update)
    return () => video.removeEventListener('ratechange', update)
  }, [videoRef])

  return rate
}

function useVideoBuffered(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  duration: number
) {
  const [bufferedEnd, setBufferedEnd] = useState(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video || duration <= 0) return
    const update = () => {
      const buffered = video.buffered
      let end = 0
      for (let i = 0; i < buffered.length; i++) {
        if (buffered.end(i) > end) end = buffered.end(i)
      }
      setBufferedEnd(Math.min(end, duration))
    }
    update()
    video.addEventListener('progress', update)
    video.addEventListener('timeupdate', update)
    video.addEventListener('loadedmetadata', update)
    return () => {
      video.removeEventListener('progress', update)
      video.removeEventListener('timeupdate', update)
      video.removeEventListener('loadedmetadata', update)
    }
  }, [videoRef, duration])

  return duration > 0 ? bufferedEnd / duration : 0
}

function useVideoDuration(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  storeDuration?: number
) {
  const [duration, setDuration] = useState(() => {
    if (Number.isFinite(storeDuration) && (storeDuration as number) > 0)
      return storeDuration as number
    return 0
  })

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    /** 获取有效时长：优先 storeDuration，其次 serverDuration（HEAD 请求获取），
     *  再次 video.duration（有限时），最后回退到 video.seekable 末尾时间。 */
    const getEffectiveDuration = (): number => {
      // 1. storeDuration（来自后端探测 / 影片记录）
      if (Number.isFinite(storeDuration) && (storeDuration as number) > 0)
        return storeDuration as number
      // 2. video.dataset.serverDuration（转码流场景，由 direct-engine HEAD 请求获取）
      const sd = video.dataset.serverDuration
      if (sd) {
        const d = parseFloat(sd)
        if (Number.isFinite(d) && d > 0) return d
      }
      // 3. video.duration（原生支持的格式）
      if (Number.isFinite(video.duration) && video.duration > 0)
        return video.duration
      // 4. video.seekable 末尾（fragmented MP4 无 moov 时长时的回退）
      if (video.seekable && video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1)
        if (Number.isFinite(end) && end > 0) return end
      }
      return 0
    }

    const update = () => setDuration(getEffectiveDuration())
    update()
    video.addEventListener('loadedmetadata', update)
    video.addEventListener('durationchange', update)
    video.addEventListener('progress', update)
    return () => {
      video.removeEventListener('loadedmetadata', update)
      video.removeEventListener('durationchange', update)
      video.removeEventListener('progress', update)
    }
  }, [videoRef, storeDuration])

  return duration
}

interface PlayerControlBarProps {
  isHost: boolean
  /** 房主已离线：观众进入自主控制模式，可直接 play/pause/seek */
  hostOffline?: boolean
  videoRef: React.RefObject<HTMLVideoElement | null>
  watchTogether: WatchTogetherState
  isPlaying: boolean
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
  isWebFullscreen?: boolean
  onToggleWebFullscreen?: () => void
  danmakuEnabled: boolean
  onToggleDanmaku: () => void
  onSendDanmaku: (text: string) => void
  onSync: () => void
  onReload: () => void
  settingsOpen: boolean
  onToggleSettings: () => void
  settingsButtonRef?: React.Ref<HTMLButtonElement>
  onRequestSeek?: (time: number) => void
  onRequestPause?: () => void
  onRequestPlay?: () => void
  pausePending?: boolean
  playPending?: boolean
  controlBarVisible?: boolean
  controlBarHideMode?: boolean
  onToggleHideMode?: () => void
}

export function PlayerControlBar({
  isHost,
  hostOffline = false,
  videoRef,
  watchTogether,
  isPlaying,
  isFullscreen,
  onToggleFullscreen,
  isWebFullscreen,
  onToggleWebFullscreen,
  danmakuEnabled,
  onToggleDanmaku,
  onSendDanmaku,
  onSync,
  onReload,
  settingsOpen,
  onToggleSettings,
  settingsButtonRef,
  onRequestSeek,
  onRequestPause,
  onRequestPlay,
  pausePending,
  playPending,
  controlBarVisible = true,
  controlBarHideMode = false,
  onToggleHideMode,
}: PlayerControlBarProps) {
  const currentTime = useVideoCurrentTime(videoRef)
  const duration = useVideoDuration(videoRef, watchTogether.duration)
  const progress =
    duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0
  const bufferedProgress = useVideoBuffered(videoRef, duration)
  // 服务器端（房主广播的）进度比例，用于显示同步线
  const serverProgress =
    duration > 0 && Number.isFinite(watchTogether.currentTime)
      ? Math.min(1, Math.max(0, watchTogether.currentTime / duration))
      : null

  // 可直接控制播放：房主或房主离线后的观众
  const canControl = isHost || hostOffline

  // 本地进度与服务器/房主进度的时间差（秒），用于动态调整同步线视觉强度
  const serverTimeDiff =
    Number.isFinite(watchTogether.currentTime) && Number.isFinite(currentTime)
      ? watchTogether.currentTime - currentTime
      : 0
  const absDiffSeconds = Math.abs(serverTimeDiff)

  const { volume, muted } = useVideoVolume(videoRef)
  const playbackRate = useVideoPlaybackRate(videoRef)

  const progressRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const volumeTrackRef = useRef<HTMLDivElement>(null)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const volumeCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevVolumeRef = useRef(volume || 1)

  const openVolume = useCallback(() => {
    if (volumeCloseTimerRef.current) {
      clearTimeout(volumeCloseTimerRef.current)
      volumeCloseTimerRef.current = null
    }
    setVolumeOpen(true)
  }, [])

  const scheduleCloseVolume = useCallback(() => {
    if (volumeCloseTimerRef.current) clearTimeout(volumeCloseTimerRef.current)
    volumeCloseTimerRef.current = setTimeout(() => {
      setVolumeOpen(false)
      volumeCloseTimerRef.current = null
    }, 200)
  }, [])

  const [rateOpen, setRateOpen] = useState(false)
  const rateContainerRef = useRef<HTMLDivElement>(null)

  // 移动端“更多”菜单：收纳使用频率较低的房间/视频操作
  const [moreOpen, setMoreOpen] = useState(false)
  const moreContainerRef = useRef<HTMLDivElement>(null)

  // 初始化时从 localStorage 恢复音量
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const saved = localStorage.getItem(VOLUME_STORAGE_KEY)
    if (saved === null) return
    const v = parseFloat(saved)
    if (!Number.isFinite(v)) return
    const clamped = Math.min(1, Math.max(0, v))
    if (video.volume !== clamped) {
      video.volume = clamped
    }
  }, [videoRef])

  // 音量变化时持久化
  useEffect(() => {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(volume))
  }, [volume])

  // 点击外部关闭倍速下拉
  useEffect(() => {
    if (!rateOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        rateContainerRef.current &&
        !rateContainerRef.current.contains(target)
      ) {
        setRateOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [rateOpen])

  // 点击外部关闭移动端“更多”菜单
  useEffect(() => {
    if (!moreOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        moreContainerRef.current &&
        !moreContainerRef.current.contains(target)
      ) {
        setMoreOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [moreOpen])

  const computeTimeFromClientX = useCallback(
    (clientX: number): number => {
      const el = progressRef.current
      if (!el || duration <= 0) return 0
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return 0
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return ratio * duration
    },
    [duration]
  )

  const handleProgressPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const video = videoRef.current
      if (!video) return
      if (canControl) {
        setDragging(true)
        const time = computeTimeFromClientX(e.clientX)
        if (Number.isFinite(time)) video.currentTime = time

        const handleMove = (ev: PointerEvent) => {
          const t = computeTimeFromClientX(ev.clientX)
          if (Number.isFinite(t)) video.currentTime = t
        }
        const handleUp = () => {
          setDragging(false)
          window.removeEventListener('pointermove', handleMove)
          window.removeEventListener('pointerup', handleUp)
        }
        window.addEventListener('pointermove', handleMove)
        window.addEventListener('pointerup', handleUp)
      } else {
        const handleUp = (ev: PointerEvent) => {
          window.removeEventListener('pointerup', handleUp)
          if (!onRequestSeek) return
          // 允许轻微拖拽，最终以 pointerup 位置计算
          const t = computeTimeFromClientX(ev.clientX)
          if (Number.isFinite(t)) onRequestSeek(t)
        }
        window.addEventListener('pointerup', handleUp)
      }
    },
    [canControl, videoRef, computeTimeFromClientX, onRequestSeek]
  )

  const handlePlayPauseClick = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (canControl) {
      if (video.paused) {
        // 用户主动恢复播放：清除暂停意图，允许异步 attach 完成后自动起播
        clearUserPaused(video)
        void video.play().catch(() => {})
      } else {
        // 用户主动暂停：打意图标记。MKV 的 playsvideo 管线 attach 需数秒，
        // 完成后的补播逻辑会检查该标记，避免覆盖用户暂停（声音复活 bug）
        markUserPaused(video)
        video.pause()
      }
    } else {
      if (isPlaying) {
        onRequestPause?.()
      } else {
        onRequestPlay?.()
      }
    }
  }, [canControl, videoRef, isPlaying, onRequestPause, onRequestPlay])

  const handleVolumePointer = useCallback(
    (clientY: number) => {
      const video = videoRef.current
      if (!video) return
      const el = volumeTrackRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(
        1,
        Math.max(0, (rect.bottom - clientY) / rect.height)
      )
      const v = ratio
      video.muted = v === 0
      video.volume = v
    },
    [videoRef]
  )

  const handleVolumePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      handleVolumePointer(e.clientY)
      const handleMove = (ev: PointerEvent) => handleVolumePointer(ev.clientY)
      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [handleVolumePointer]
  )

  const toggleMute = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.muted) {
      video.muted = false
      if (video.volume === 0) {
        video.volume = prevVolumeRef.current || 0.5
      }
    } else {
      prevVolumeRef.current = video.volume
      video.muted = true
    }
  }, [videoRef])

  // React Compiler 推断依赖与手动指定不一致，但 videoRef 为稳定 ref，无需重创建。
  /* eslint-disable react-hooks/preserve-manual-memoization */
  const handleRateSelect = useCallback(
    (rate: number) => {
      if (!canControl) return
      const video = videoRef.current
      if (video) {
        video.playbackRate = rate
      }
      setRateOpen(false)
    },
    [canControl, videoRef]
  )
  /* eslint-enable react-hooks/preserve-manual-memoization */

  const VolumeIcon =
    muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <div
      className={cn(
        'absolute bottom-0 left-0 right-0 z-[80] p-2 md:p-3',
        !controlBarVisible && 'pointer-events-none'
      )}
    >
      <div
        className={cn(
          'glass-strong flex flex-col gap-1.5 md:gap-2 rounded-lg border border-[var(--glass-border)] p-1.5 md:p-2 shadow-lg',
          controlBarVisible ? 'zart-controlbar-enter' : 'zart-controlbar-exit'
        )}
      >
        {/* 进度条：轨道 + 缓冲 + 已播放 + 服务器同步线 */}
        <div
          ref={progressRef}
          role="slider"
          aria-label={canControl ? '播放进度' : '播放进度（仅房主可拖动）'}
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={currentTime}
          aria-disabled={!canControl}
          className={cn(
            'group relative h-1.5 md:h-2 w-full cursor-pointer overflow-visible rounded-full transition-all',
            canControl && 'hover:h-2 md:hover:h-2.5'
          )}
          style={{ backgroundColor: 'rgba(128, 128, 128, 0.4)' }}
          onPointerDown={handleProgressPointerDown}
        >
          {/* 缓冲进度 */}
          <div
            className="absolute top-0 h-full rounded-full transition-[width] duration-150"
            style={{
              width: `${bufferedProgress * 100}%`,
              backgroundColor: 'rgba(255, 255, 255, 0.35)',
            }}
          />
          {/* 已播放进度 */}
          <div
            className="absolute top-0 h-full rounded-full bg-[var(--md-sys-color-primary)] transition-[width] duration-100"
            style={{ width: `${progress * 100}%` }}
          />
          {/* 服务器/房主进度同步线：始终显示，差异越大越明显，带平滑位移动画 */}
          {serverProgress !== null && duration > 0 && (
            <div
              className="pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 flex-col items-center transition-all duration-150 ease-linear"
              style={{
                left: `${serverProgress * 100}%`,
                opacity: Math.min(1, Math.max(0.35, absDiffSeconds / 3)),
              }}
              title={`${canControl ? '服务器进度' : '房主进度'}: ${formatDuration(watchTogether.currentTime)}${
                absDiffSeconds > 0.5
                  ? ` (${serverTimeDiff > 0 ? '落后' : '超前'} ${formatDuration(absDiffSeconds)})`
                  : ''
              }`}
            >
              <div
                className="h-3.5 w-[3px] rounded-full shadow-[0_0_6px_rgba(0,0,0,0.5)]"
                style={{
                  backgroundColor:
                    absDiffSeconds > 3
                      ? 'var(--md-sys-color-error)'
                      : 'var(--md-sys-color-tertiary)',
                }}
              />
              <div
                className="absolute -top-0.5 h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor:
                    absDiffSeconds > 3
                      ? 'var(--md-sys-color-error)'
                      : 'var(--md-sys-color-tertiary)',
                }}
              />
            </div>
          )}
          {/* 拖动/悬停指示器（缩小尺寸） */}
          <div
            className={cn(
              'absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border-2 border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-on-primary)] shadow transition-opacity duration-150',
              dragging || canControl
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100'
            )}
            style={{ left: `calc(${progress * 100}% - 5px)` }}
          />
        </div>

        {/* 移动端弹幕输入行：放在进度条与按钮行之间，避免与按钮竞争空间 */}
        <div className="flex items-center gap-1 md:hidden">
          <DanmakuInput onSend={onSendDanmaku} placeholder="发弹幕" />
        </div>

        {/* 控制按钮行 */}
        <div className="flex items-center gap-1 md:gap-1.5">
          {/* 播放 / 暂停 */}
          <ControlButton
            label={
              canControl
                ? isPlaying
                  ? '暂停'
                  : '播放'
                : isPlaying
                  ? '申请暂停'
                  : '申请继续播放'
            }
            disabled={!canControl && (isPlaying ? pausePending : playPending)}
            onClick={handlePlayPauseClick}
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </ControlButton>

          {/* 时间 */}
          <div className="select-none px-0.5 md:px-1 text-[10px] md:text-xs font-medium tabular-nums text-[var(--md-sys-color-on-surface)]">
            <span>{formatDuration(currentTime)}</span>
            <span className="mx-0.5 opacity-60">/</span>
            <span className="opacity-80">{formatDuration(duration)}</span>
          </div>

          {/* 弹幕开关：开启时不显示底色，通过图标是否带斜线区分状态 */}
          <ControlButton
            label={danmakuEnabled ? '关闭弹幕' : '开启弹幕'}
            onClick={onToggleDanmaku}
          >
            <DanmakuIcon off={!danmakuEnabled} />
          </ControlButton>

          {/* 弹幕输入框（桌面端显示） */}
          <div className="hidden min-w-0 flex-1 items-center gap-1 md:flex">
            <DanmakuInput onSend={onSendDanmaku} placeholder="发个友善的弹幕" />
          </div>

          {/* 倍速 */}
          <div ref={rateContainerRef} className="relative">
            <ControlButton
              label="播放倍速"
              disabled={!canControl}
              active={rateOpen}
              onClick={() => canControl && setRateOpen((v) => !v)}
            >
              <span className="min-w-[2ch] text-xs font-semibold">
                {playbackRate}x
              </span>
            </ControlButton>
            {rateOpen && canControl && (
              <div className="absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-1 shadow-lg">
                {RATES.map((rate) => {
                  const active = Math.abs(playbackRate - rate) < 0.01
                  return (
                    <button
                      key={rate}
                      type="button"
                      onClick={() => handleRateSelect(rate)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                        active
                          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                          : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                      )}
                    >
                      <span>{rate}x</span>
                      {active && <Check size={12} />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* 音量：容器包含按钮和弹窗，使用延迟关闭避免移动鼠标到弹窗时隐藏 */}
          <div
            className="relative flex items-center"
            onMouseEnter={openVolume}
            onMouseLeave={scheduleCloseVolume}
          >
            <ControlButton
              label={muted || volume === 0 ? '取消静音' : '静音'}
              onClick={toggleMute}
            >
              <VolumeIcon size={18} />
            </ControlButton>
            {volumeOpen && (
              <div
                className="absolute bottom-full left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-2 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-2 pb-3 pt-4 shadow-lg"
                onMouseEnter={openVolume}
                onMouseLeave={scheduleCloseVolume}
              >
                <span className="w-5 text-center text-[11px] font-medium text-[var(--md-sys-color-on-surface)]">
                  {Math.round((muted ? 0 : volume) * 100)}
                </span>
                <div
                  ref={volumeTrackRef}
                  className="relative h-24 w-1.5 cursor-pointer rounded-full bg-[var(--md-sys-color-on-surface)]/20"
                  onPointerDown={handleVolumePointerDown}
                >
                  <div
                    className="absolute bottom-0 left-0 right-0 rounded-full bg-[var(--md-sys-color-primary)]"
                    style={{ height: `${(muted ? 0 : volume) * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 房主专属：同步进度（桌面端直接显示） */}
          {isHost && (
            <div className="hidden md:block">
              <ControlButton label="同步进度" onClick={onSync}>
                <RotateCcw size={18} />
              </ControlButton>
            </div>
          )}

          {/* 重载视频：桌面端直接显示 */}
          <div className="hidden md:block">
            <ControlButton label="重载视频" onClick={onReload}>
              <RotateCw size={18} />
            </ControlButton>
          </div>

          {/* 隐藏/显示控制栏 */}
          <ControlButton
            label={controlBarHideMode ? '显示控制栏' : '隐藏控制栏'}
            active={controlBarHideMode}
            onClick={onToggleHideMode}
          >
            {controlBarHideMode ? <Eye size={18} /> : <EyeOff size={18} />}
          </ControlButton>

          {/* 设置 */}
          <ControlButton
            ref={settingsButtonRef}
            label="设置"
            active={settingsOpen}
            onClick={onToggleSettings}
          >
            <Settings size={18} />
          </ControlButton>

          {/* 网页全屏：桌面端直接显示 */}
          <div className="hidden md:block">
            <ControlButton
              label={isWebFullscreen ? '退出网页全屏' : '网页全屏'}
              onClick={onToggleWebFullscreen}
            >
              {isWebFullscreen ? (
                <Minimize size={18} />
              ) : (
                <Maximize size={18} />
              )}
            </ControlButton>
          </div>

          {/* 移动端“更多”菜单：收纳同步/重载/网页全屏 */}
          <div ref={moreContainerRef} className="relative md:hidden">
            <ControlButton
              label="更多"
              active={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              <MoreHorizontal size={18} />
            </ControlButton>
            {moreOpen && (
              <div className="absolute right-0 bottom-full z-30 mb-2 w-36 overflow-hidden rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-1 shadow-lg">
                {isHost && (
                  <button
                    type="button"
                    onClick={() => {
                      onSync()
                      setMoreOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-[var(--md-sys-color-on-surface)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  >
                    <RotateCcw size={14} />
                    同步进度
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    onReload()
                    setMoreOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-[var(--md-sys-color-on-surface)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                >
                  <RotateCw size={14} />
                  重载视频
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onToggleWebFullscreen?.()
                    setMoreOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-[var(--md-sys-color-on-surface)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                >
                  {isWebFullscreen ? (
                    <Minimize size={14} />
                  ) : (
                    <Maximize size={14} />
                  )}
                  {isWebFullscreen ? '退出网页全屏' : '网页全屏'}
                </button>
              </div>
            )}
          </div>

          {/* 全屏 */}
          <ControlButton
            label={isFullscreen ? '退出全屏' : '全屏'}
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </ControlButton>
        </div>
      </div>
    </div>
  )
}

interface ControlButtonProps {
  label: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}

const ControlButton = forwardRef<HTMLButtonElement, ControlButtonProps>(
  function ControlButton({ label, active, disabled, onClick, children }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation()
          onClick?.()
        }}
        className={cn(
          'flex h-7 w-7 md:h-8 md:w-8 shrink-0 items-center justify-center rounded-lg text-[var(--md-sys-color-on-surface)] outline-none',
          'transition-all duration-200',
          'hover:bg-[var(--md-sys-color-surface-container-highest)]',
          'focus-visible:ring-2 focus-visible:ring-[var(--md-sys-color-primary)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--md-sys-color-surface)]',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
          active &&
            'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
        )}
      >
        {children}
      </button>
    )
  }
)

export { ControlButton }
