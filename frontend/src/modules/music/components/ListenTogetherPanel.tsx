/**
 * 一起听主区域面板（房主与观众共用）。
 *
 * 布局：上下两段——上部左侧方形封面 + 右侧歌词滚动区（高亮当前行并平滑滚动，
 * 原文下方小字显示翻译）；下部控制条（进度条 / 上一首 / 播放暂停 / 下一首 /
 * 播放模式（仅房主） / 音量竖条）。
 *
 * 播放引擎与同步逻辑由 MusicPlayerProvider 持有（内部 useListenTogether），
 * 本组件经 useMusicPlayer 消费；观众无直接控制权时控制按钮走申请制
 * （requestControl），房主端左上角提示申请并通过/拒绝。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Music,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Shuffle,
  Volume2,
  VolumeX,
  Check,
  X,
} from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { Text, Paragraph } from '@/components/ui/Typography'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { MusicPlayerProvider } from '../MusicPlayerContext'
import { mergeLyrics, type LyricLine } from '../utils/lrc'
import type { PlayMode } from '../types'
import { cn, formatDuration } from '@/lib/utils'

export interface ListenTogetherPanelProps {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  /** 网页全屏模式（放大封面与歌词排版） */
  isWebFullscreen?: boolean
}

/** 网易云 /lyric 原始响应（后端透传结构） */
interface NcmLyricResponse {
  lrc?: { lyric?: string }
  tlyric?: { lyric?: string }
}

/** syncNotice 自动消失时长（毫秒） */
const SYNC_NOTICE_AUTO_DISMISS_MS = 5000

/** 歌词高亮提前量（秒）：接近下一行时间标签前即切换高亮 */
const LYRIC_ADVANCE_SEC = 0.2

/** 播放模式轮换顺序 */
const PLAY_MODE_ORDER: PlayMode[] = ['sequence', 'repeat-one', 'shuffle']

const PLAY_MODE_META: Record<PlayMode, { label: string; next: string }> = {
  sequence: { label: '顺序循环', next: '切换为单曲循环' },
  'repeat-one': { label: '单曲循环', next: '切换为随机播放' },
  shuffle: { label: '随机播放', next: '切换为顺序循环' },
}

export function ListenTogetherPanel({
  socket,
  roomId,
  isHost,
  username,
  isWebFullscreen,
}: ListenTogetherPanelProps) {
  return (
    <MusicPlayerProvider
      socket={socket}
      roomId={roomId}
      isHost={isHost}
      username={username}
    >
      <ListenTogetherInner isHost={isHost} isWebFullscreen={isWebFullscreen} />
    </MusicPlayerProvider>
  )
}

function ListenTogetherInner({
  isHost,
  isWebFullscreen,
}: {
  isHost: boolean
  isWebFullscreen?: boolean
}) {
  const {
    togglePlay,
    next,
    prev,
    seek,
    setPlayMode,
    requestControl,
    approveControl,
    rejectControl,
    currentSong,
    canControl,
    hostOffline,
    syncNotice,
    setSyncNotice,
    positionSec,
    isPlaying,
    playMode,
    volume,
    setVolume,
  } = useMusicPlayer()

  const queue = useMusicStore((s) => s.queue)

  // ===== 歌词 =====
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([])
  const lyricScrollRef = useRef<HTMLDivElement>(null)
  const lyricLineRefs = useRef<Array<HTMLDivElement | null>>([])

  // 切歌时请求歌词（请求期间保留旧词避免闪烁，失败/纯音乐时清空）
  const songId = currentSong?.songId
  useEffect(() => {
    if (songId == null) return
    let cancelled = false
    const loadLyric = async () => {
      try {
        const { data } = await apiGet<NcmLyricResponse>(
          `/api/music/ncm/lyric?id=${songId}`
        )
        if (cancelled) return
        setLyricLines(
          mergeLyrics(data?.lrc?.lyric ?? '', data?.tlyric?.lyric ?? '')
        )
      } catch (err) {
        console.error('[ListenTogetherPanel] 获取歌词失败:', err)
        if (!cancelled) setLyricLines([])
      }
    }
    void loadLyric()
    return () => {
      cancelled = true
    }
  }, [songId])

  /** 当前高亮歌词行（最后一个 time <= positionSec + 提前量的行，二分查找） */
  const activeLyricIndex = useMemo(() => {
    if (lyricLines.length === 0) return -1
    let ans = -1
    let lo = 0
    let hi = lyricLines.length - 1
    const target = positionSec + LYRIC_ADVANCE_SEC
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (lyricLines[mid].time <= target) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }, [lyricLines, positionSec])

  // 高亮行变化时平滑滚动到容器中央偏上（只滚动歌词容器，不影响页面）
  useEffect(() => {
    if (activeLyricIndex < 0) return
    const container = lyricScrollRef.current
    const el = lyricLineRefs.current[activeLyricIndex]
    if (!container || !el) return
    const target =
      el.offsetTop - container.clientHeight * 0.4 + el.clientHeight / 2
    container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [activeLyricIndex])

  // ===== syncNotice：5s 自动消失 =====
  useEffect(() => {
    if (!syncNotice) return
    const timer = setTimeout(
      () => setSyncNotice(null),
      SYNC_NOTICE_AUTO_DISMISS_MS
    )
    return () => clearTimeout(timer)
  }, [syncNotice, setSyncNotice])

  // ===== 进度条 =====
  const durationSec = currentSong ? currentSong.durationMs / 1000 : 0
  const progressRatio =
    durationSec > 0 ? Math.min(1, Math.max(0, positionSec / durationSec)) : 0
  const progressRef = useRef<HTMLDivElement>(null)

  const computeTimeFromClientX = useCallback(
    (clientX: number): number => {
      const el = progressRef.current
      if (!el || durationSec <= 0) return 0
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return 0
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return ratio * durationSec
    },
    [durationSec]
  )

  /** 拖动进度（仅 canControl；观众只读展示） */
  const handleProgressPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!canControl || durationSec <= 0) return
      e.preventDefault()
      e.stopPropagation()
      seek(computeTimeFromClientX(e.clientX))
      const handleMove = (ev: PointerEvent) => {
        seek(computeTimeFromClientX(ev.clientX))
      }
      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [canControl, durationSec, seek, computeTimeFromClientX]
  )

  // ===== 控制按钮 =====
  const handlePlayPause = useCallback(() => {
    if (canControl) {
      togglePlay()
    } else {
      requestControl(isPlaying ? 'pause' : 'play')
    }
  }, [canControl, togglePlay, requestControl, isPlaying])

  const handleNext = useCallback(() => {
    if (canControl) next()
    else requestControl('next')
  }, [canControl, next, requestControl])

  const handlePrev = useCallback(() => {
    if (canControl) prev()
    else requestControl('prev')
  }, [canControl, prev, requestControl])

  /** 播放模式轮换（仅房主，切换后广播同步） */
  const handleTogglePlayMode = useCallback(() => {
    const idx = PLAY_MODE_ORDER.indexOf(playMode)
    const nextMode =
      PLAY_MODE_ORDER[(idx + 1) % PLAY_MODE_ORDER.length] ?? 'sequence'
    setPlayMode(nextMode)
  }, [playMode, setPlayMode])

  // ===== 音量竖条（hover 弹出，对齐播放器控制栏惯例） =====
  const [volumeOpen, setVolumeOpen] = useState(false)
  const volumeCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const volumeTrackRef = useRef<HTMLDivElement>(null)

  const openVolume = useCallback(() => {
    if (volumeCloseTimerRef.current) {
      clearTimeout(volumeCloseTimerRef.current)
      volumeCloseTimerRef.current = null
    }
    setVolumeOpen(true)
  }, [])

  const scheduleCloseVolume = useCallback(() => {
    if (volumeCloseTimerRef.current) clearTimeout(volumeCloseTimerRef.current)
    volumeCloseTimerRef.current = setTimeout(() => setVolumeOpen(false), 200)
  }, [])

  useEffect(() => {
    const timerRef = volumeCloseTimerRef
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleVolumePointer = useCallback(
    (clientY: number) => {
      const el = volumeTrackRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.min(
        1,
        Math.max(0, (rect.bottom - clientY) / rect.height)
      )
      setVolume(ratio)
    },
    [setVolume]
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

  const PlayModeIcon =
    playMode === 'repeat-one'
      ? Repeat1
      : playMode === 'shuffle'
        ? Shuffle
        : Repeat
  const VolumeIcon = volume === 0 ? VolumeX : Volume2

  const iconBtn =
    'flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] transition-all hover:bg-[var(--md-sys-color-surface-container-highest)] active:scale-95'

  // ===== 渲染 =====
  const queueEmpty = queue.length === 0

  return (
    <div className="glass-card zen-card relative flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* ===== 主区域 ===== */}
      <div className="relative flex min-h-0 flex-1 gap-6 p-4 md:p-6">
        {/* 左上角提示区：房主离线提示 + syncNotice（含房主审批按钮） */}
        <div className="pointer-events-none absolute left-4 top-4 z-30 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2">
          {hostOffline && !canControl && (
            <div
              className="pointer-events-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-tertiary) 15%, transparent)',
                color: 'var(--md-sys-color-tertiary)',
              }}
            >
              房主已离开，您可以自主控制播放
            </div>
          )}
          {syncNotice && (
            <div
              className="pointer-events-auto flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                color: 'var(--md-sys-color-on-surface)',
              }}
            >
              <span>{syncNotice}</span>
              {isHost && (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={approveControl}
                    className="flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                    title="通过申请"
                  >
                    <Check className="h-3 w-3" />
                    通过
                  </button>
                  <button
                    type="button"
                    onClick={rejectControl}
                    className="flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                    style={{ color: 'var(--md-sys-color-error)' }}
                    title="拒绝申请"
                  >
                    <X className="h-3 w-3" />
                    拒绝
                  </button>
                </span>
              )}
            </div>
          )}
        </div>

        {queueEmpty ? (
          /* 空队列：主区域居中空状态 */
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <div
              className="flex h-16 w-16 items-center justify-center rounded-full"
              style={{ backgroundColor: 'var(--glass-bg)' }}
            >
              <Music
                className="h-8 w-8 opacity-40"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              />
            </div>
            <Text className="text-sm font-medium">还没有歌曲</Text>
            <Text type="secondary" className="text-xs">
              在右侧面板搜索添加
            </Text>
          </div>
        ) : (
          <>
            {/* 左侧封面（正方形 rounded-large；小屏隐藏，歌名信息保留在歌词区顶部） */}
            <div className="hidden shrink-0 md:block">
              <div
                className={cn(
                  'relative aspect-square overflow-hidden rounded-2xl',
                  isWebFullscreen ? 'w-64 lg:w-72' : 'w-48 lg:w-56'
                )}
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                }}
              >
                {currentSong?.cover ? (
                  <img
                    src={currentSong.cover}
                    alt={currentSong.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Music
                      className="h-10 w-10 opacity-40"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* 右侧：歌名信息 + 歌词滚动区 */}
            <div className="relative flex min-w-0 flex-1 flex-col">
              <div className="shrink-0 pb-3 text-center">
                <Paragraph
                  className="m-0 truncate text-lg font-semibold leading-tight"
                  title={currentSong?.name}
                >
                  {currentSong?.name ?? '等待播放'}
                </Paragraph>
                <Text
                  type="secondary"
                  className="mt-0.5 block truncate text-xs"
                >
                  {currentSong?.artist ?? ' '}
                </Text>
              </div>

              <div
                ref={lyricScrollRef}
                className="zen-scroll min-h-0 flex-1 overflow-y-auto"
              >
                {lyricLines.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <Text type="secondary" className="text-sm">
                      纯音乐，请欣赏
                    </Text>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-5 pb-[35%] pt-[30%]">
                    {lyricLines.map((line, i) => {
                      const active = i === activeLyricIndex
                      return (
                        <div
                          key={`${line.time}-${i}`}
                          ref={(el) => {
                            lyricLineRefs.current[i] = el
                          }}
                          className="max-w-full px-4 text-center transition-all duration-300"
                        >
                          <p
                            className={cn(
                              'm-0 leading-relaxed transition-colors',
                              active
                                ? 'text-base font-medium text-[var(--md-sys-color-primary)]'
                                : 'text-sm text-[var(--md-sys-color-on-surface-variant)]'
                            )}
                          >
                            {line.text}
                          </p>
                          {line.translation && (
                            <p
                              className={cn(
                                'm-0 mt-0.5 text-xs leading-relaxed transition-colors',
                                active
                                  ? 'text-[var(--md-sys-color-primary)] opacity-80'
                                  : 'text-[var(--md-sys-color-on-surface-variant)] opacity-60'
                              )}
                            >
                              {line.translation}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ===== 控制条 ===== */}
      <div
        className="glass shrink-0 border-t border-[var(--glass-border)] px-4 py-3"
        style={{ backgroundColor: 'var(--glass-bg)' }}
      >
        {/* 进度条：canControl 可拖动 seek，观众只读 */}
        <div
          ref={progressRef}
          role="slider"
          aria-label={canControl ? '播放进度' : '播放进度（仅房主可拖动）'}
          aria-valuemin={0}
          aria-valuemax={Math.round(durationSec)}
          aria-valuenow={Math.round(positionSec)}
          aria-disabled={!canControl}
          className={cn(
            'group relative h-1.5 w-full overflow-visible rounded-full transition-all',
            canControl && 'cursor-pointer hover:h-2'
          )}
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 16%, transparent)',
          }}
          onPointerDown={handleProgressPointerDown}
        >
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-[var(--md-sys-color-primary)] transition-[width] duration-100"
            style={{ width: `${progressRatio * 100}%` }}
          />
          <div
            className={cn(
              'absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border-2 bg-[var(--md-sys-color-on-primary)] shadow transition-opacity duration-150',
              canControl ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
            style={{
              left: `calc(${progressRatio * 100}% - 5px)`,
              borderColor: 'var(--md-sys-color-primary)',
            }}
          />
        </div>

        {/* 按钮行：上一首 / 播放暂停 / 下一首 / 时间 / 歌名 / 播放模式（房主）/ 音量 */}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className={iconBtn}
            onClick={handlePrev}
            title={canControl ? '上一首' : '向房主申请切换上一首'}
            aria-label="上一首"
          >
            <SkipBack className="h-5 w-5" />
          </button>

          <button
            type="button"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all hover:scale-105 active:scale-95"
            style={{
              backgroundColor: 'var(--md-sys-color-primary)',
              color: 'var(--md-sys-color-on-primary)',
              boxShadow:
                '0 2px 8px -2px color-mix(in srgb, var(--md-sys-color-primary) 50%, transparent)',
            }}
            onClick={handlePlayPause}
            title={
              canControl
                ? isPlaying
                  ? '暂停'
                  : '播放'
                : isPlaying
                  ? '申请暂停'
                  : '申请继续播放'
            }
            aria-label="播放或暂停"
          >
            {isPlaying ? (
              <Pause className="h-5 w-5" />
            ) : (
              <Play className="ml-0.5 h-5 w-5" />
            )}
          </button>

          <button
            type="button"
            className={iconBtn}
            onClick={handleNext}
            title={canControl ? '下一首' : '向房主申请切换下一首'}
            aria-label="下一首"
          >
            <SkipForward className="h-5 w-5" />
          </button>

          {/* 时间：当前 / 总时长 */}
          <div className="select-none px-1 text-xs font-medium tabular-nums text-[var(--md-sys-color-on-surface)]">
            <span>{formatDuration(positionSec)}</span>
            <span className="mx-0.5 opacity-60">/</span>
            <span className="opacity-80">{formatDuration(durationSec)}</span>
          </div>

          {/* 中间：当前歌名（truncate） */}
          <div className="hidden min-w-0 flex-1 items-center justify-center sm:flex">
            <Text
              type="secondary"
              className="max-w-full truncate text-xs"
              title={currentSong?.name}
            >
              {currentSong ? `${currentSong.name} · ${currentSong.artist}` : ''}
            </Text>
          </div>

          {/* 播放模式（仅房主）：顺序循环 / 单曲循环 / 随机 轮换 */}
          {isHost && (
            <button
              type="button"
              className={iconBtn}
              onClick={handleTogglePlayMode}
              title={`${PLAY_MODE_META[playMode].label}（点击${PLAY_MODE_META[playMode].next}）`}
              aria-label={`播放模式：${PLAY_MODE_META[playMode].label}`}
            >
              <PlayModeIcon
                className="h-5 w-5"
                style={
                  playMode !== 'sequence'
                    ? { color: 'var(--md-sys-color-primary)' }
                    : undefined
                }
              />
            </button>
          )}

          {/* 音量：hover 弹出竖条滑块 */}
          <div
            className="relative flex items-center"
            onMouseEnter={openVolume}
            onMouseLeave={scheduleCloseVolume}
          >
            <button
              type="button"
              className={iconBtn}
              onClick={() => setVolume(volume === 0 ? 0.5 : 0)}
              title={volume === 0 ? '取消静音' : '静音'}
              aria-label={volume === 0 ? '取消静音' : '静音'}
            >
              <VolumeIcon className="h-5 w-5" />
            </button>
            {volumeOpen && (
              <div
                className="absolute bottom-full left-1/2 z-30 mb-2 flex -translate-x-1/2 flex-col items-center gap-2 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg)] p-2 pb-3 pt-4 shadow-lg"
                onMouseEnter={openVolume}
                onMouseLeave={scheduleCloseVolume}
              >
                <span className="w-5 text-center text-[11px] font-medium text-[var(--md-sys-color-on-surface)]">
                  {Math.round(volume * 100)}
                </span>
                <div
                  ref={volumeTrackRef}
                  role="slider"
                  aria-label="音量"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(volume * 100)}
                  className="relative h-24 w-1.5 cursor-pointer rounded-full bg-[var(--md-sys-color-on-surface)]/20"
                  onPointerDown={handleVolumePointerDown}
                >
                  <div
                    className="absolute bottom-0 left-0 right-0 rounded-full bg-[var(--md-sys-color-primary)]"
                    style={{ height: `${volume * 100}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
