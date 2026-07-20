import {
  useRef,
  useState,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  type ForwardedRef,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Settings,
  Maximize,
  Minimize2,
  MessageSquare,
  MessageSquareX,
  Send,
  RotateCcw,
  Upload,
  Plus,
  PanelBottomClose,
  ChevronDown,
  Hand,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Slider } from '@/components/ui/Slider'
import { useVideoControls } from './useVideoControls'
import { cn } from '@/lib/utils'
import type { SubtitleTrack } from '@/hooks/useSubtitles'
import { DanmakuStylePanel } from '@/modules/room/watch-together/DanmakuStylePanel'
import type {
  DanmakuStyleState,
  DanmakuTypeFilters,
  DanmakuAdvancedStyle,
} from '@/store/danmakuStore'

const RATE_OPTIONS = [
  { label: '0.5x', value: '0.5' },
  { label: '0.75x', value: '0.75' },
  { label: '1x', value: '1' },
  { label: '1.25x', value: '1.25' },
  { label: '1.5x', value: '1.5' },
  { label: '2x', value: '2' },
]

export interface VideoControlsProps {
  video: HTMLVideoElement | null
  isHost: boolean
  /**
   * 只读模式：观众端启用，隐藏所有可操作控件，
   * 仅显示进度条（不可拖动）、当前时间/总时长，并显示「由房主控制」提示。
   */
  readOnly?: boolean
  isDanmakuEnabled: boolean
  onToggleDanmaku: () => void
  onSendDanmaku?: (text: string) => void
  onSync?: () => void
  containerRef?: React.RefObject<HTMLElement | null>
  isWebFullscreen?: boolean
  onToggleWebFullscreen?: () => void
  // 字幕
  subtitleEnabled?: boolean
  subtitleTracks?: SubtitleTrack[]
  activeTrackIndex?: number
  subtitleFontSize?: number
  onToggleSubtitles?: (enabled: boolean) => void
  onSelectSubtitleTrack?: (index: number) => void
  onAddSubtitleUrl?: (url: string, label?: string) => void
  onAddSubtitleFile?: (file: File) => void
  onChangeSubtitleFontSize?: (size: number) => void
  // 弹幕样式
  danmakuStyle?: DanmakuStyleState
  onDanmakuStyleChange?: (updates: Partial<DanmakuStyleState>) => void
  onDanmakuFilterChange?: (updates: Partial<DanmakuTypeFilters>) => void
  onDanmakuAdvancedChange?: (updates: Partial<DanmakuAdvancedStyle>) => void
  onResetDanmakuStyle?: () => void
  /**
   * 观众端（readOnly=true）拖动进度条松开时触发。
   * 观众端不会直接 seek video.currentTime，而是通过此回调向房主申请跳转。
   * 仅在 readOnly=true 且 isHost=false 时有效。
   */
  onRequestSeek?: (time: number) => void
  /**
   * 观众端（readOnly=true）点击「申请暂停」按钮时触发。
   * 仅在 readOnly=true 且 isHost=false 时有效。
   */
  onRequestPause?: () => void
  /**
   * 房主端「自动通过申请」开关状态。开启后所有 seek/pause 申请自动通过。
   * 仅 isHost=true 时有效。
   */
  autoApproveRequests?: boolean
  /**
   * 房主端切换「自动通过申请」开关。
   * 仅 isHost=true 时有效。
   */
  onToggleAutoApprove?: () => void
}

export interface VideoControlsHandle {
  showControls: () => void
}

export const VideoControls = forwardRef<
  VideoControlsHandle,
  VideoControlsProps
>(function VideoControls(
  {
    video,
    isHost,
    readOnly = false,
    isDanmakuEnabled,
    onToggleDanmaku,
    onSendDanmaku,
    onSync,
    containerRef,
    subtitleEnabled,
    subtitleTracks,
    activeTrackIndex,
    subtitleFontSize,
    onToggleSubtitles,
    onSelectSubtitleTrack,
    onAddSubtitleUrl,
    onAddSubtitleFile,
    onChangeSubtitleFontSize,
    danmakuStyle,
    onDanmakuStyleChange,
    onDanmakuFilterChange,
    onDanmakuAdvancedChange,
    onResetDanmakuStyle,
    onRequestSeek,
    onRequestPause,
    autoApproveRequests,
    onToggleAutoApprove,
  }: VideoControlsProps,
  ref: ForwardedRef<VideoControlsHandle>
) {
  const {
    isPlaying,
    currentTime,
    duration,
    bufferedPercent,
    volume,
    isMuted,
    playbackRate,
    isFullscreen,
    formattedCurrentTime,
    formattedDuration,
    progressPercent,
  } = useVideoControls(video)

  const [danmakuInput, setDanmakuInput] = useState('')
  const [tooltip, setTooltip] = useState<{
    visible: boolean
    x: number
    time: number
    dragging: boolean
  }>({
    visible: false,
    x: 0,
    time: 0,
    dragging: false,
  })
  const trackRef = useRef<HTMLDivElement>(null)

  // 设置菜单（字幕）
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 设置面板坐标（fixed 定位，脱离父容器 overflow-hidden 约束）
  const [settingsPos, setSettingsPos] = useState<{
    top?: number
    bottom?: number
    left?: number
    maxHeight: number
  }>({ maxHeight: 480 })
  const [subtitleUrlInput, setSubtitleUrlInput] = useState('')
  // 设置面板当前激活 Tab：字幕 / 弹幕（默认弹幕，使用频率更高）
  const [settingsTab, setSettingsTab] = useState<'subtitle' | 'danmaku'>(
    'danmaku'
  )
  // 字幕加载器（URL 输入 + 文件上传）默认折叠
  const [showSubtitleLoader, setShowSubtitleLoader] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)
  const settingsPanelRef = useRef<HTMLDivElement>(null)
  const subtitleFileInputRef = useRef<HTMLInputElement>(null)

  // 控制栏显隐：默认显示，静止 3 秒后自动隐藏
  const [controlsVisible, setControlsVisible] = useState(true)
  const controlsRef = useRef<HTMLDivElement>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mouseOverRef = useRef(false)
  const settingsOpenRef = useRef(settingsOpen)

  useEffect(() => {
    settingsOpenRef.current = settingsOpen
  }, [settingsOpen])

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }, [])

  const scheduleHide = useCallback(() => {
    clearIdleTimer()
    if (settingsOpenRef.current) return
    if (!mouseOverRef.current) return
    idleTimerRef.current = setTimeout(() => {
      setControlsVisible(false)
    }, 3000)
  }, [clearIdleTimer])

  useImperativeHandle(ref, () => ({
    showControls: () => {
      setControlsVisible(true)
      if (mouseOverRef.current) {
        scheduleHide()
      }
    },
  }))

  useEffect(() => {
    const container = containerRef?.current
    const controls = controlsRef.current

    const handleMouseMove = () => {
      setControlsVisible(true)
      scheduleHide()
    }
    const handleMouseEnter = () => {
      mouseOverRef.current = true
      setControlsVisible(true)
      scheduleHide()
    }
    const handleMouseLeave = () => {
      mouseOverRef.current = false
      clearIdleTimer()
      setControlsVisible(true)
    }
    const handleGlobalActivity = () => {
      setControlsVisible(true)
      if (mouseOverRef.current) {
        scheduleHide()
      }
    }

    container?.addEventListener('mousemove', handleMouseMove)
    container?.addEventListener('mouseenter', handleMouseEnter)
    container?.addEventListener('mouseleave', handleMouseLeave)
    controls?.addEventListener('mousemove', handleMouseMove)
    controls?.addEventListener('mouseenter', handleMouseEnter)
    // 隐藏控制栏后会将其设为 pointer-events-none，controls 的 mouseleave 会被触发并立即重新显示，
    // 因此不监听 controls 的 mouseleave，仅依赖 container 的 mouseleave。
    document.addEventListener('mousedown', handleGlobalActivity)
    document.addEventListener('keydown', handleGlobalActivity)

    return () => {
      container?.removeEventListener('mousemove', handleMouseMove)
      container?.removeEventListener('mouseenter', handleMouseEnter)
      container?.removeEventListener('mouseleave', handleMouseLeave)
      controls?.removeEventListener('mousemove', handleMouseMove)
      controls?.removeEventListener('mouseenter', handleMouseEnter)
      document.removeEventListener('mousedown', handleGlobalActivity)
      document.removeEventListener('keydown', handleGlobalActivity)
      clearIdleTimer()
    }
  }, [containerRef, scheduleHide, clearIdleTimer])

  useEffect(() => {
    return () => {
      clearIdleTimer()
    }
  }, [clearIdleTimer])

  useEffect(() => {
    if (!settingsOpen) return
    const onMouseDown = (e: MouseEvent) => {
      // 面板已迁移为 fixed 定位，不再是 settingsRef 的子节点，
      // 因此需要同时检查按钮和面板两个 ref，否则点击面板内任意滑块/
      // Switch/Input 都会触发 setSettingsOpen(false)，导致弹幕样式
      // 等设置无法操作。
      const target = e.target as Node
      const inside =
        (settingsRef.current && settingsRef.current.contains(target)) ||
        (settingsPanelRef.current && settingsPanelRef.current.contains(target))
      if (!inside) {
        setSettingsOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    // 窗口尺寸变化时关闭面板：避免坐标错位（fixed 定位不再跟随按钮）
    const onResize = () => setSettingsOpen(false)
    // 滚动时关闭面板（避免 fixed 定位与按钮错位），
    // 但忽略面板自身的内部滚动（面板 overflow-y-auto）。
    const onScroll = (e: Event) => {
      const target = e.target as Node | null
      if (
        target &&
        settingsPanelRef.current &&
        settingsPanelRef.current.contains(target)
      ) {
        return
      }
      setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [settingsOpen])

  const subtitleTrackOptions =
    subtitleTracks?.map((t, i) => ({
      label: t.label,
      value: String(i),
    })) ?? []

  const handleAddSubtitleUrl = () => {
    const url = subtitleUrlInput.trim()
    if (!url) return
    onAddSubtitleUrl?.(url)
    setSubtitleUrlInput('')
  }

  const handleSubtitleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    onAddSubtitleFile?.(file)
    e.target.value = ''
  }

  const computeTimeFromEvent = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track || !duration) return 0
      const rect = track.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return ratio * duration
    },
    [duration]
  )

  const formatTooltipTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    const mm = m.toString().padStart(2, '0')
    const ss = s.toString().padStart(2, '0')
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
  }

  const handleTogglePlay = () => {
    if (!video || !isHost) return
    if (video.paused) {
      void video.play()
    } else {
      video.pause()
    }
  }

  const handleTrackMouseDown = (e: React.MouseEvent) => {
    if (!duration || !video) return
    // 房主：直接 seek；观众（readOnly）：拖动结束后改走 onRequestSeek 申请
    if (!isHost && !readOnly) return
    if (readOnly && !onRequestSeek) return
    e.preventDefault()
    // 拖动期间只更新 tooltip 显示的目标时间，不立即 seek。
    // 原实现每次 mousemove 都设置 video.currentTime，
    // 浏览器要不断解码新位置的视频帧（MSE DASH 流还要重新下载 m4s 分片），
    // 严重阻塞主线程导致整个网页卡顿。
    // 改为：拖动结束时才执行一次 seek，拖动过程仅更新 UI。
    const startTime = computeTimeFromEvent(e.clientX)
    setTooltip((prev) => ({
      ...prev,
      visible: true,
      dragging: true,
      time: startTime,
    }))

    const handleMouseMove = (ev: MouseEvent) => {
      const t = computeTimeFromEvent(ev.clientX)
      // 仅更新 tooltip，不 seek
      setTooltip((prev) => ({ ...prev, time: t }))
    }

    const handleMouseUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      const t = computeTimeFromEvent(ev.clientX)
      if (readOnly) {
        // 观众端：不直接 seek，向房主申请
        onRequestSeek?.(t)
      } else if (isHost && video) {
        // 房主端：松开时才执行一次 seek
        video.currentTime = t
      }
      setTooltip((prev) => ({ ...prev, dragging: false }))
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  const handleTrackMouseMove = (e: React.MouseEvent) => {
    if (!trackRef.current || !duration) return
    const rect = trackRef.current.getBoundingClientRect()
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left))
    const time = computeTimeFromEvent(e.clientX)
    setTooltip((prev) => ({ ...prev, visible: true, x, time }))
  }

  const handleTrackMouseLeave = () => {
    setTooltip((prev) => ({ ...prev, visible: prev.dragging, dragging: false }))
  }

  const handleRateChange = (value: string) => {
    const rate = Number(value)
    if (video && isHost) {
      video.playbackRate = rate
    }
  }

  const handleVolumeChange = (v: number) => {
    if (video) {
      video.volume = v
      video.muted = v === 0
    }
  }

  const handleToggleMute = () => {
    if (!video) return
    video.muted = !video.muted
  }

  const handleFullscreen = async () => {
    const container = containerRef?.current
    if (!container) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await container.requestFullscreen()
      }
    } catch (err) {
      console.error('[VideoControls] fullscreen error:', err)
    }
  }

  const handleSendDanmaku = () => {
    const text = danmakuInput.trim()
    if (!text) return
    onSendDanmaku?.(text)
    setDanmakuInput('')
  }

  const handleDanmakuKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendDanmaku()
    }
  }

  const handleHideControls = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    setControlsVisible(false)
    clearIdleTimer()
  }

  const iconBtnClass =
    'h-8 w-8 shrink-0 p-0 text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'

  const HideIcon = PanelBottomClose || ChevronDown

  return (
    <div
      ref={controlsRef}
      className={cn(
        'absolute bottom-0 left-0 right-0 z-20 p-3 transition-opacity duration-300',
        !controlsVisible && 'opacity-0 pointer-events-none'
      )}
    >
      <div
        className={cn(
          'glass-strong flex flex-col gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 shadow-lg',
          'border-[var(--glass-border)]'
        )}
        style={{
          boxShadow:
            '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-shadow) 40%, transparent)',
        }}
      >
        {/* 进度条 */}
        <div
          ref={trackRef}
          role="slider"
          aria-label="视频进度"
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration)}
          aria-valuenow={Math.floor(currentTime)}
          // 只读模式下不可聚焦
          tabIndex={readOnly ? -1 : isHost ? 0 : -1}
          className={cn(
            'group relative h-5 cursor-default select-none py-2',
            // 房主直接 seek；观众端 readOnly 模式下可拖动申请跳转
            (isHost || (readOnly && onRequestSeek)) && 'cursor-pointer'
          )}
          onMouseDown={handleTrackMouseDown}
          onMouseMove={handleTrackMouseMove}
          onMouseLeave={handleTrackMouseLeave}
          onKeyDown={(e) => {
            // 只读模式下禁用键盘快捷键
            if (readOnly || !isHost || !duration || !video) return
            const step = e.shiftKey ? 10 : 5
            let nextTime = currentTime
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
              e.preventDefault()
              nextTime = Math.max(0, currentTime - step)
            } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
              e.preventDefault()
              nextTime = Math.min(duration, currentTime + step)
            } else if (e.key === 'Home') {
              e.preventDefault()
              nextTime = 0
            } else if (e.key === 'End') {
              e.preventDefault()
              nextTime = duration
            }
            if (nextTime !== currentTime) {
              video.currentTime = nextTime
            }
          }}
        >
          <div
            className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 16%, transparent)',
            }}
          />
          <div
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
            style={{
              width: `${bufferedPercent}%`,
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent)',
            }}
          />
          <div
            className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
            style={{
              // 拖动期间 fill 跟随 tooltip.time 显示目标位置，
              // 避免 video.currentTime 还在原位时 fill 不动让用户感觉拖动没反应
              width: `${
                tooltip.dragging && duration
                  ? (tooltip.time / duration) * 100
                  : progressPercent
              }%`,
              backgroundColor: 'var(--md-sys-color-primary)',
            }}
          />
          {(isHost || readOnly) && (
            <div
              className={cn(
                'absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary)] shadow transition-all',
                // 房主：默认隐藏 hover 显示；观众 readOnly 模式下：常驻显示以提示可拖动申请跳转
                readOnly ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
              style={{
                left: `${
                  tooltip.dragging && duration
                    ? (tooltip.time / duration) * 100
                    : progressPercent
                }%`,
                transform: `translate(-50%, -50%) ${
                  tooltip.dragging ? 'scale(1.3)' : 'scale(1)'
                }`,
              }}
            />
          )}
          {tooltip.visible && (
            <div
              className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-[var(--md-sys-shape-corner)] px-2 py-1 text-xs font-medium"
              style={{
                left: tooltip.x,
                backgroundColor: 'var(--md-sys-color-inverse-surface)',
                color: 'var(--md-sys-color-inverse-on-surface)',
              }}
            >
              {formatTooltipTime(tooltip.time)}
            </div>
          )}
        </div>

        {/* 控制行 */}
        <div className="flex flex-nowrap items-center gap-2">
          {/* 左侧：播放、时间 */}
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className={iconBtnClass}
              disabled={!isHost}
              onClick={handleTogglePlay}
              icon={
                isPlaying ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="h-5 w-5" />
                )
              }
            />
          )}

          {/* 观众端 readOnly 模式：常驻显示「申请暂停」按钮。
              不依赖本地 isPlaying 条件 —— 观众端 video 元素可能因浏览器自动播放策略、
              MSE 加载延迟等处于 paused 状态，即使房主在播放 isPlaying 也可能为 false，
              导致按钮被禁用无法申请。让观众随时可点击，由房主端决定是否处理。 */}
          {readOnly && onRequestPause && (
            <Button
              variant="ghost"
              size="sm"
              className={iconBtnClass}
              onClick={onRequestPause}
              aria-label="申请暂停"
              icon={<Hand className="h-5 w-5" />}
            />
          )}

          <span
            className="shrink-0 min-w-[5.5rem] text-xs tabular-nums"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          >
            {formattedCurrentTime} / {formattedDuration}
          </span>

          {/* 中间：弹幕开关、输入、发送 */}
          <Button
            variant="ghost"
            size="sm"
            className={cn(iconBtnClass, !isDanmakuEnabled && 'opacity-60')}
            onClick={onToggleDanmaku}
            icon={
              isDanmakuEnabled ? (
                <MessageSquare className="h-5 w-5" />
              ) : (
                <MessageSquareX className="h-5 w-5" />
              )
            }
          />

          {/* 弹幕输入框 + 发送按钮：房主和观众都可用。
              弹幕发送通过 onSendDanmaku 回调，本地先 addDanmaku 即时显示，
              再经 socket 广播到聊天区。观众发送的弹幕对所有人生效（这是弹幕本身的语义）。 */}
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              size="sm"
              value={danmakuInput}
              onChange={(e) => setDanmakuInput(e.target.value)}
              onKeyDown={handleDanmakuKeyDown}
              placeholder="发个友善的弹幕见证当下"
              className="flex-1"
            />
            <Button
              variant="primary"
              size="sm"
              className="h-8 w-8 shrink-0 p-0"
              disabled={!danmakuInput.trim()}
              onClick={handleSendDanmaku}
              icon={<Send className="h-4 w-4" />}
            />
          </div>

          {/* 右侧：倍速、音量、设置、全屏 */}
          {!readOnly && (
            <Select
              className="w-20 shrink-0"
              options={RATE_OPTIONS}
              value={String(playbackRate)}
              onChange={handleRateChange}
              disabled={!isHost}
            />
          )}

          {/* 音量控件：房主和观众都可用。
              音量是纯本地状态（仅修改 video.volume / video.muted），
              不通过 socket 广播，观众调节音量只影响自己。 */}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={iconBtnClass}
              onClick={handleToggleMute}
              icon={
                isMuted || volume === 0 ? (
                  <VolumeX className="h-5 w-5" />
                ) : (
                  <Volume2 className="h-5 w-5" />
                )
              }
            />
            <div className="w-20">
              <Slider
                value={isMuted ? 0 : volume}
                min={0}
                max={1}
                step={0.05}
                showValue={false}
                onChange={handleVolumeChange}
              />
            </div>
          </div>

          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className={iconBtnClass}
              disabled={!isHost}
              onClick={onSync}
              icon={<RotateCcw className="h-5 w-5" />}
            />
          )}

          {/* 房主端：「自动通过申请」开关。开启后所有 seek/pause 申请自动通过，无需手动确认 */}
          {!readOnly && isHost && onToggleAutoApprove && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                iconBtnClass,
                autoApproveRequests &&
                  'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)]'
              )}
              aria-label={
                autoApproveRequests ? '关闭自动通过申请' : '开启自动通过申请'
              }
              aria-pressed={autoApproveRequests}
              onClick={onToggleAutoApprove}
              icon={<Zap className="h-5 w-5" />}
            />
          )}

          {/* 设置面板：房主和观众都可用。
              - 房主：字幕 + 弹幕 两个 Tab（字幕为全局同步）
              - 观众：仅弹幕 Tab（弹幕样式为本地状态，不影响其他人） */}
          <div ref={settingsRef} className="relative shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                iconBtnClass,
                settingsOpen &&
                  'bg-[var(--md-sys-color-surface-container-highest)]'
              )}
              aria-label="设置"
              aria-expanded={settingsOpen}
              icon={<Settings className="h-5 w-5" />}
              onClick={() => {
                const next = !settingsOpen
                if (next && settingsRef.current) {
                  // 用 fixed 定位面板，避免父容器 overflow-hidden 裁切。
                  // 根据按钮位置 + 视口可用空间动态计算坐标与最大高度。
                  const rect = settingsRef.current.getBoundingClientRect()
                  const GAP = 8
                  const spaceBelow = window.innerHeight - rect.bottom - GAP
                  const spaceAbove = rect.top - GAP
                  const expandDown = spaceBelow >= spaceAbove
                  // 面板宽度上限：留 16px 边距
                  const width = Math.min(288, window.innerWidth - 16)
                  // 左侧坐标：默认右对齐按钮，但若溢出左侧则贴左边
                  let left = rect.right - width
                  if (left < 8) left = 8
                  if (left + width > window.innerWidth - 8) {
                    left = window.innerWidth - 8 - width
                  }
                  const maxHeight = Math.max(
                    240,
                    expandDown ? spaceBelow : spaceAbove
                  )
                  setSettingsPos({
                    top: expandDown ? rect.bottom + GAP : undefined,
                    bottom: expandDown
                      ? undefined
                      : window.innerHeight - rect.top + GAP,
                    left,
                    maxHeight,
                  })
                }
                setSettingsOpen(next)
              }}
            />
            {settingsOpen &&
              createPortal(
                <div
                  ref={settingsPanelRef}
                  className={cn(
                    'glass-strong fixed z-[200] overflow-y-auto rounded-[var(--md-sys-shape-corner)] border border-[var(--glass-border)] p-2.5 shadow-lg'
                  )}
                  style={{
                    top: settingsPos.top,
                    bottom: settingsPos.bottom,
                    left: settingsPos.left,
                    width: Math.min(260, window.innerWidth - 16),
                    maxHeight: settingsPos.maxHeight,
                    boxShadow:
                      '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-shadow) 40%, transparent)',
                  }}
                >
                  {/* 紧凑 Tab 切换：字幕 / 弹幕
                    - 房主：显示双 Tab（字幕为全局同步）
                    - 观众：隐藏 Tab，仅显示「弹幕」标题（字幕由房主控制）
                    - 弹幕样式未启用（danmakuStyle 为空）：仅显示「字幕」标题 */}
                  {danmakuStyle && isHost ? (
                    <div
                      className="mb-2 grid grid-cols-2 gap-1 rounded-[var(--md-sys-radius-small)] p-0.5"
                      style={{
                        backgroundColor:
                          'color-mix(in srgb, var(--md-sys-color-surface-container-highest) 70%, transparent)',
                      }}
                    >
                      {(['subtitle', 'danmaku'] as const).map((tab) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setSettingsTab(tab)}
                          className={cn(
                            'rounded-[var(--md-sys-radius-small)] py-1 text-[11px] font-medium transition-colors',
                            settingsTab === tab
                              ? 'bg-[var(--md-sys-color-surface)] text-[var(--md-sys-color-primary)] shadow-sm'
                              : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]'
                          )}
                        >
                          {tab === 'subtitle' ? '字幕' : '弹幕'}
                        </button>
                      ))}
                    </div>
                  ) : danmakuStyle && !isHost ? (
                    // 观众端：仅弹幕样式可用，显示「弹幕」标题（无 Tab 切换）
                    <div
                      className="mb-1.5 text-[11px] font-semibold"
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                    >
                      弹幕
                    </div>
                  ) : (
                    <div
                      className="mb-1.5 text-[11px] font-semibold"
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                    >
                      字幕
                    </div>
                  )}

                  {/* 内容区：
                    - 房主端选中字幕 Tab（或无弹幕样式数据）：显示字幕内容
                    - 观众端：强制显示弹幕样式面板（字幕由房主控制，不展示字幕 Tab） */}
                  {isHost && (settingsTab === 'subtitle' || !danmakuStyle) ? (
                    <>
                      <div className="flex items-center justify-between py-0.5">
                        <span
                          className="text-[11px]"
                          style={{
                            color: 'var(--md-sys-color-on-surface-variant)',
                          }}
                        >
                          启用字幕
                        </span>
                        <Switch
                          checked={!!subtitleEnabled}
                          disabled={!isHost}
                          onChange={(e) =>
                            onToggleSubtitles?.(e.target.checked)
                          }
                        />
                      </div>

                      {subtitleEnabled &&
                        subtitleTracks &&
                        subtitleTracks.length > 0 && (
                          <div className="mt-1.5">
                            <Select
                              className="[&_select]:h-7 [&_select]:py-0.5 [&_select]:text-[11px]"
                              options={subtitleTrackOptions}
                              value={String(activeTrackIndex ?? -1)}
                              onChange={(v) =>
                                onSelectSubtitleTrack?.(Number(v))
                              }
                              disabled={!isHost}
                            />
                          </div>
                        )}

                      {isHost && subtitleEnabled && (
                        <>
                          <div
                            className="mt-2 border-t pt-1.5"
                            style={{
                              borderColor:
                                'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => setShowSubtitleLoader((v) => !v)}
                              className="flex w-full items-center justify-between rounded-[var(--md-sys-radius-small)] px-1 py-0.5 text-[11px] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                              style={{
                                color: 'var(--md-sys-color-on-surface-variant)',
                              }}
                            >
                              <span>加载字幕 URL / 文件</span>
                              <ChevronDown
                                className={cn(
                                  'h-3 w-3 transition-transform',
                                  showSubtitleLoader && 'rotate-180'
                                )}
                              />
                            </button>
                            {showSubtitleLoader && (
                              <div className="mt-1.5 space-y-1.5">
                                <div className="flex items-center gap-1">
                                  <Input
                                    size="sm"
                                    value={subtitleUrlInput}
                                    onChange={(e) =>
                                      setSubtitleUrlInput(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        e.preventDefault()
                                        handleAddSubtitleUrl()
                                      }
                                    }}
                                    placeholder="https://.../sub.vtt"
                                    className="flex-1"
                                  />
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    className="h-7 w-7 shrink-0 p-0"
                                    disabled={!subtitleUrlInput.trim()}
                                    onClick={handleAddSubtitleUrl}
                                    icon={<Plus className="h-3.5 w-3.5" />}
                                  />
                                </div>
                                <input
                                  ref={subtitleFileInputRef}
                                  type="file"
                                  accept=".vtt,.srt"
                                  className="hidden"
                                  onChange={handleSubtitleFileChange}
                                />
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  className="h-7 w-full justify-center gap-1 text-[11px]"
                                  icon={<Upload className="h-3 w-3" />}
                                  onClick={() =>
                                    subtitleFileInputRef.current?.click()
                                  }
                                >
                                  上传字幕文件
                                </Button>
                              </div>
                            )}
                          </div>

                          <div
                            className="mt-2 border-t pt-1.5"
                            style={{
                              borderColor:
                                'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
                            }}
                          >
                            <Slider
                              label="字号"
                              value={subtitleFontSize ?? 20}
                              min={12}
                              max={36}
                              step={1}
                              valueFormatter={(v) => `${v}px`}
                              onChange={(v) => onChangeSubtitleFontSize?.(v)}
                            />
                          </div>
                        </>
                      )}

                      {!isHost && (
                        <div
                          className="mt-1.5 text-[10px]"
                          style={{
                            color: 'var(--md-sys-color-on-surface-variant)',
                          }}
                        >
                          字幕由房主控制
                        </div>
                      )}
                    </>
                  ) : (
                    <DanmakuStylePanel
                      style={danmakuStyle!}
                      setStyle={onDanmakuStyleChange ?? (() => {})}
                      setFilters={onDanmakuFilterChange ?? (() => {})}
                      setAdvancedStyle={onDanmakuAdvancedChange ?? (() => {})}
                      resetStyle={onResetDanmakuStyle ?? (() => {})}
                    />
                  )}
                </div>,
                document.body
              )}
          </div>

          <Button
            variant="ghost"
            size="sm"
            className={iconBtnClass}
            aria-label="隐藏控制栏"
            onClick={handleHideControls}
            icon={<HideIcon className="h-5 w-5" />}
          />

          <Button
            variant="ghost"
            size="sm"
            className={iconBtnClass}
            onClick={handleFullscreen}
            icon={
              isFullscreen ? (
                <Minimize2 className="h-5 w-5" />
              ) : (
                <Maximize className="h-5 w-5" />
              )
            }
          />
        </div>
      </div>
    </div>
  )
})
