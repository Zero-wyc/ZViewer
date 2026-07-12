import {
  useRef,
  useState,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Settings,
  Maximize,
  Maximize2,
  Minimize2,
  MessageSquare,
  MessageSquareX,
  Send,
  RotateCcw,
  Captions,
  Upload,
  Plus,
  PanelBottomClose,
  ChevronDown,
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
import {
  getBilibiliParseOptions,
  setBilibiliParseOptions,
  type BilibiliCodec,
} from '@/modules/room/watch-together/resolveSource'
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
}

export function VideoControls({
  video,
  isHost,
  isDanmakuEnabled,
  onToggleDanmaku,
  onSendDanmaku,
  onSync,
  containerRef,
  isWebFullscreen: externalWebFullscreen,
  onToggleWebFullscreen,
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
}: VideoControlsProps) {
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

  const isWebFullscreen = externalWebFullscreen ?? false

  // 设置菜单（字幕）
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsExpandDown, setSettingsExpandDown] = useState(false)
  const [subtitleUrlInput, setSubtitleUrlInput] = useState('')
  const settingsRef = useRef<HTMLDivElement>(null)
  const subtitleFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!settingsOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (
        settingsRef.current &&
        !settingsRef.current.contains(e.target as Node)
      ) {
        setSettingsOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
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
    if (!isHost || !duration || !video) return
    e.preventDefault()
    const time = computeTimeFromEvent(e.clientX)
    // eslint-disable-next-line react-hooks/immutability
    video.currentTime = time
    setTooltip((prev) => ({ ...prev, visible: true, dragging: true }))

    const handleMouseMove = (ev: MouseEvent) => {
      const t = computeTimeFromEvent(ev.clientX)
      if (video) video.currentTime = t
    }

    const handleMouseUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      const t = computeTimeFromEvent(ev.clientX)
      if (video) video.currentTime = t
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
      // eslint-disable-next-line react-hooks/immutability
      video.playbackRate = rate
    }
  }

  const handleVolumeChange = (v: number) => {
    if (video) {
      // eslint-disable-next-line react-hooks/immutability
      video.volume = v
      video.muted = v === 0
    }
  }

  const handleToggleMute = () => {
    if (!video) return
    // eslint-disable-next-line react-hooks/immutability
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

  const handleWebFullscreen = () => {
    onToggleWebFullscreen?.()
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

  const iconBtnClass =
    'h-8 w-8 shrink-0 p-0 text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'

  return (
    <div className="absolute bottom-0 left-0 right-0 z-20 p-3">
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
          tabIndex={isHost ? 0 : -1}
          className={cn(
            'group relative h-5 cursor-default select-none py-2',
            isHost && 'cursor-pointer'
          )}
          onMouseDown={handleTrackMouseDown}
          onMouseMove={handleTrackMouseMove}
          onMouseLeave={handleTrackMouseLeave}
          onKeyDown={(e) => {
            if (!isHost || !duration || !video) return
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
              // eslint-disable-next-line react-hooks/immutability
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
              width: `${progressPercent}%`,
              backgroundColor: 'var(--md-sys-color-primary)',
            }}
          />
          {isHost && (
            <div
              className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary)] opacity-0 shadow transition-all group-hover:opacity-100"
              style={{
                left: `${progressPercent}%`,
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
        <div className="flex flex-wrap items-center gap-2">
          {/* 左侧：播放、时间 */}
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

          <div className="flex min-w-[10rem] flex-1 items-center gap-1">
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
          <Select
            className="w-20 shrink-0"
            options={RATE_OPTIONS}
            value={String(playbackRate)}
            onChange={handleRateChange}
            disabled={!isHost}
          />

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

          <Button
            variant="ghost"
            size="sm"
            className={iconBtnClass}
            disabled={!isHost}
            onClick={onSync}
            icon={<RotateCcw className="h-5 w-5" />}
          />

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
                  const rect = settingsRef.current.getBoundingClientRect()
                  const spaceAbove = rect.top
                  const spaceBelow = window.innerHeight - rect.bottom
                  setSettingsExpandDown(spaceBelow >= spaceAbove)
                }
                setSettingsOpen(next)
              }}
            />
            {settingsOpen && (
              <div
                className={cn(
                  'glass-strong absolute right-0 z-30 max-h-[70vh] w-72 overflow-y-auto rounded-[var(--md-sys-shape-corner)] border border-[var(--glass-border)] p-3 shadow-lg',
                  settingsExpandDown ? 'top-full mt-2' : 'bottom-full mb-2'
                )}
                style={{
                  boxShadow:
                    '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-shadow) 40%, transparent)',
                }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Captions
                    className="h-4 w-4"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                  <span
                    className="text-xs font-semibold"
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                  >
                    字幕
                  </span>
                </div>

                <div className="flex items-center justify-between py-1">
                  <span
                    className="text-xs"
                    style={{
                      color: 'var(--md-sys-color-on-surface-variant)',
                    }}
                  >
                    启用字幕
                  </span>
                  <Switch
                    checked={!!subtitleEnabled}
                    disabled={!isHost}
                    onChange={(e) => onToggleSubtitles?.(e.target.checked)}
                  />
                </div>

                {subtitleEnabled &&
                  subtitleTracks &&
                  subtitleTracks.length > 0 && (
                    <div className="mt-2">
                      <div
                        className="mb-1 text-[11px]"
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      >
                        字幕轨道
                      </div>
                      <Select
                        className="[&_select]:h-8 [&_select]:py-1"
                        options={subtitleTrackOptions}
                        value={String(activeTrackIndex ?? -1)}
                        onChange={(v) => onSelectSubtitleTrack?.(Number(v))}
                        disabled={!isHost}
                      />
                    </div>
                  )}

                {isHost && subtitleEnabled && (
                  <>
                    <div
                      className="mt-3 border-t pt-2"
                      style={{
                        borderColor:
                          'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                      }}
                    >
                      <div
                        className="mb-1 text-[11px]"
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      >
                        加载字幕 URL（.vtt）
                      </div>
                      <div className="flex items-center gap-1">
                        <Input
                          size="sm"
                          value={subtitleUrlInput}
                          onChange={(e) => setSubtitleUrlInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              handleAddSubtitleUrl()
                            }
                          }}
                          placeholder="https://example.com/sub.vtt"
                          className="flex-1"
                        />
                        <Button
                          variant="primary"
                          size="sm"
                          className="h-8 w-8 shrink-0 p-0"
                          disabled={!subtitleUrlInput.trim()}
                          onClick={handleAddSubtitleUrl}
                          icon={<Plus className="h-4 w-4" />}
                        />
                      </div>
                    </div>

                    <div className="mt-2">
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
                        className="h-8 w-full justify-center gap-1 text-xs"
                        icon={<Upload className="h-3.5 w-3.5" />}
                        onClick={() => subtitleFileInputRef.current?.click()}
                      >
                        上传字幕文件
                      </Button>
                    </div>

                    <div
                      className="mt-3 border-t pt-2"
                      style={{
                        borderColor:
                          'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                      }}
                    >
                      <Slider
                        label="字幕字号"
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
                    className="mt-2 text-[10px]"
                    style={{
                      color: 'var(--md-sys-color-on-surface-variant)',
                    }}
                  >
                    字幕由房主控制
                  </div>
                )}

                {danmakuStyle && (
                  <>
                    <div
                      className="my-3 border-t"
                      style={{
                        borderColor:
                          'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                      }}
                    />
                    <DanmakuStylePanel
                      style={danmakuStyle}
                      setStyle={onDanmakuStyleChange ?? (() => {})}
                      setFilters={onDanmakuFilterChange ?? (() => {})}
                      setAdvancedStyle={onDanmakuAdvancedChange ?? (() => {})}
                      resetStyle={onResetDanmakuStyle ?? (() => {})}
                    />
                  </>
                )}
              </div>
            )}
          </div>

          <Button
            variant="ghost"
            size="sm"
            className={iconBtnClass}
            onClick={handleWebFullscreen}
            icon={
              isWebFullscreen ? (
                <Minimize2 className="h-5 w-5" />
              ) : (
                <Maximize2 className="h-5 w-5" />
              )
            }
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
}
