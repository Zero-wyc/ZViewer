/**
 * 一起听主区域面板（房主与观众共用，Hydrogen MusicPlayer.vue + Player.vue 范式）。
 *
 * 整页布局（flex 横排居中）：
 * - 毛玻璃封面背景（backdrop）：封面图 absolute 铺满 120%（-10% 偏移），
 *   blur(50px) saturate(140%) brightness(1.08) scale(1.08)，上叠 surface 30%
 *   遮罩；无封面时不渲染，切歌时淡入淡出
 * - 左侧播放卡（42vh 宽）：半透明 surface 50% + backdrop-blur，rounded-2xl，
 *   四角 L 形角标装饰；内容自上而下：封面（正方形占满卡宽）/ 歌名歌手 /
 *   时间行 + 进度条 / 三键控制行 / 音量横条滑块
 * - 右侧歌词面板（flex-1，与左卡间距约 50px）：lrc.ts 解析 + 二分查找高亮，
 *   当前行 on-surface、其余 on-surface-variant 淡化；翻译为同行下方小字；
 *   播放模式按钮（仅房主）置于歌词面板左上角
 * - 提示区（页面左上角 absolute）：房主离线提示 / syncNotice（房主审批带
 *   通过/拒绝小按钮，5s 自动消失），文字提示非弹窗
 *
 * 播放引擎与同步逻辑由 MusicPlayerProvider 持有（内部 useListenTogether），
 * 本组件经 useMusicPlayer 消费；观众无直接控制权时控制按钮走申请制
 * （requestControl），房主端左上角提示申请并通过/拒绝。
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Music,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat1,
  Shuffle,
  Check,
  X,
} from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { useMusicStore } from '../store'
import { useMusicPlayer, MusicPlayerContext } from '../hooks/useMusicPlayer'
import { MusicPlayerProvider } from '../MusicPlayerContext'
import { mergeLyrics, type LyricLine } from '../utils/lrc'
import type { PlayMode } from '../types'
import { cn, formatDuration } from '@/lib/utils'

export interface ListenTogetherPanelProps {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  /** 网页全屏模式（放大左右留白排版） */
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
  // 页面级集成：RoomPage/WatchPage 用 MusicPlayerProvider 包裹整个 RoomLayout，
  // 使侧栏 MusicQueuePanel 与主播放器共享同一引擎。此时直接复用外层实例，
  // 避免嵌套 Provider 重复创建音频引擎（双引擎会导致侧栏切歌与主播放器不同步）。
  const outerPlayer = useContext(MusicPlayerContext)
  if (outerPlayer) {
    return (
      <ListenTogetherInner isHost={isHost} isWebFullscreen={isWebFullscreen} />
    )
  }
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

  // ===== 进度条（细滑块，primary 色；canControl 可拖动 seek，观众只读） =====
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

  // ===== 控制按钮（观众点击走申请，房主/房主离线 canControl 直接控制） =====
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

  // ===== 音量横条滑块（仅本地生效不参与房间同步） =====
  const volumeTrackRef = useRef<HTMLDivElement>(null)

  const handleVolumePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const compute = (clientX: number) => {
        const el = volumeTrackRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0) return
        const ratio = Math.min(
          1,
          Math.max(0, (clientX - rect.left) / rect.width)
        )
        setVolume(ratio)
      }
      compute(e.clientX)
      const handleMove = (ev: PointerEvent) => compute(ev.clientX)
      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [setVolume]
  )

  const PlayModeIcon =
    playMode === 'repeat-one'
      ? Repeat1
      : playMode === 'shuffle'
        ? Shuffle
        : Repeat

  // ===== 渲染 =====
  const queueEmpty = queue.length === 0
  const cover = currentSong?.cover

  return (
    <div className="glass-card zen-card relative flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* ===== 毛玻璃封面背景（无封面时不渲染，切歌时淡入淡出） ===== */}
      {cover && (
        <div
          key={songId}
          className="zen-cover-fade pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[120%] w-[120%] overflow-hidden"
          aria-hidden="true"
        >
          <img
            src={cover}
            alt=""
            className="h-full w-full object-cover"
            style={{
              filter: 'blur(50px) saturate(140%) brightness(1.08)',
              transform: 'scale(1.08)',
            }}
            onError={(e) => {
              e.currentTarget.parentElement?.style.setProperty(
                'display',
                'none'
              )
            }}
          />
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--md-sys-color-surface)_30%,transparent)]" />
        </div>
      )}

      {/* ===== 左上角提示区：房主离线提示 + syncNotice（含房主审批按钮） ===== */}
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
        <div className="relative z-[1] flex flex-1 flex-col items-center justify-center gap-3">
          <div
            className="flex h-16 w-16 items-center justify-center rounded-full"
            style={{ backgroundColor: 'var(--glass-bg)' }}
          >
            <Music
              className="h-8 w-8 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
          </div>
          <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
            还没有歌曲
          </span>
          <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            在右侧面板搜索添加
          </span>
        </div>
      ) : (
        /* ===== 主内容：左播放卡 + 右歌词面板 ===== */
        <div
          className={cn(
            'relative z-[1] flex min-h-0 flex-1 items-stretch justify-center',
            isWebFullscreen ? 'px-8 py-6' : 'px-4 py-4 md:px-6'
          )}
        >
          {/* ===== 左侧播放卡（42vh 宽，高撑满主区，Hydrogen 核心视觉） ===== */}
          <div
            className={cn(
              'relative mr-[50px] flex w-[42vh] max-w-[calc(100%-2rem)]',
              'shrink-0 flex-col rounded-2xl p-4',
              'bg-[color-mix(in_srgb,var(--md-sys-color-surface)_50%,transparent)] backdrop-blur'
            )}
          >
            {/* 四角 L 形角标装饰（Hydrogen c-border：4vh L 形，inset 8px） */}
            <span
              className="pointer-events-none absolute left-2 top-2 h-[4vh] max-h-8 w-[4vh] max-w-8 border-l-2 border-t-2"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)',
              }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute right-2 top-2 h-[4vh] max-h-8 w-[4vh] max-w-8 border-r-2 border-t-2"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)',
              }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute bottom-2 right-2 h-[4vh] max-h-8 w-[4vh] max-w-8 border-b-2 border-r-2"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)',
              }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute bottom-2 left-2 h-[4vh] max-h-8 w-[4vh] max-w-8 border-b-2 border-l-2"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)',
              }}
              aria-hidden="true"
            />

            {/* 封面：正方形占满卡宽（空间不足时等比收缩居中） */}
            <div className="flex min-h-0 flex-1 items-center justify-center p-3">
              {cover ? (
                <img
                  src={cover}
                  alt={currentSong?.name ?? ''}
                  className="aspect-square max-h-full w-full rounded-lg object-cover"
                />
              ) : (
                <div
                  className="flex aspect-square w-full items-center justify-center rounded-lg"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                  }}
                >
                  <Music
                    className="h-10 w-10 opacity-40"
                    style={{
                      color: 'var(--md-sys-color-on-surface-variant)',
                    }}
                  />
                </div>
              )}
            </div>

            {/* 歌曲信息：歌名 + 歌手 */}
            <div className="shrink-0 px-3">
              <div
                className="truncate text-xl font-bold leading-tight text-[var(--md-sys-color-on-surface)]"
                title={currentSong?.name}
              >
                {currentSong?.name ?? '等待播放'}
              </div>
              <div className="mt-1 truncate text-sm text-[var(--md-sys-color-on-surface-variant)]">
                {currentSong?.artist ?? ' '}
              </div>
            </div>

            {/* 进度区：时间行 + 细滑块（canControl 可拖动 seek，观众只读） */}
            <div className="mt-3 shrink-0 px-3">
              <div className="flex items-center justify-between text-xs tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                <span>{formatDuration(positionSec)}</span>
                <span>{formatDuration(durationSec)}</span>
              </div>
              <div
                ref={progressRef}
                role="slider"
                aria-label={
                  canControl ? '播放进度' : '播放进度（仅房主可拖动）'
                }
                aria-valuemin={0}
                aria-valuemax={Math.round(durationSec)}
                aria-valuenow={Math.round(positionSec)}
                aria-disabled={!canControl}
                className={cn(
                  'group relative mt-1.5 h-1 rounded-full transition-all',
                  canControl && 'cursor-pointer'
                )}
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 16%, transparent)',
                }}
                onPointerDown={handleProgressPointerDown}
              >
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-[var(--md-sys-color-primary)]"
                  style={{ width: `${progressRatio * 100}%` }}
                />
                <div
                  className={cn(
                    'absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full bg-[var(--md-sys-color-primary)] transition-opacity duration-150',
                    canControl
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100'
                  )}
                  style={{
                    left: `calc(${progressRatio * 100}% - 5px)`,
                  }}
                />
              </div>
            </div>

            {/* 控制行：居中三键（上一首 / 播放暂停 / 下一首） */}
            <div className="mt-3 flex shrink-0 items-center justify-evenly px-3">
              <button
                type="button"
                className="flex h-[22px] w-[22px] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                onClick={handlePrev}
                title={canControl ? '上一首' : '向房主申请切换上一首'}
                aria-label="上一首"
              >
                <SkipBack className="h-[22px] w-[22px]" />
              </button>
              <button
                type="button"
                className="flex h-[28px] w-[28px] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
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
                  <Pause className="h-[28px] w-[28px]" />
                ) : (
                  <Play className="ml-0.5 h-[28px] w-[28px]" />
                )}
              </button>
              <button
                type="button"
                className="flex h-[22px] w-[22px] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                onClick={handleNext}
                title={canControl ? '下一首' : '向房主申请切换下一首'}
                aria-label="下一首"
              >
                <SkipForward className="h-[22px] w-[22px]" />
              </button>
            </div>

            {/* 音量区：横条滑块 + VOLUME 标签与百分比 */}
            <div className="mt-3 shrink-0 px-3 pb-1">
              <div
                ref={volumeTrackRef}
                role="slider"
                aria-label="音量"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(volume * 100)}
                className="relative h-1 cursor-pointer rounded-full"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 16%, transparent)',
                }}
                onPointerDown={handleVolumePointerDown}
              >
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-[var(--md-sys-color-primary)]"
                  style={{ width: `${volume * 100}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                <span>VOLUME</span>
                <span className="tabular-nums">{Math.round(volume * 100)}</span>
              </div>
            </div>
          </div>

          {/* ===== 右侧歌词面板（flex-1） ===== */}
          <div className="relative flex h-full min-w-0 flex-1 flex-col">
            {/* 播放模式按钮（仅房主，歌词面板左上角） */}
            {isHost && (
              <div className="shrink-0 pb-2">
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] transition-all hover:opacity-70 active:scale-90"
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
              </div>
            )}

            {/* 歌词滚动区（当前行高亮 + 平滑滚动中央偏上） */}
            <div
              ref={lyricScrollRef}
              className="zen-scroll min-h-0 flex-1 overflow-y-auto"
            >
              {lyricLines.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <span className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
                    纯音乐，请欣赏
                  </span>
                </div>
              ) : (
                <div className="flex flex-col items-start pb-[35%] pt-[30%]">
                  {lyricLines.map((line, i) => {
                    const active = i === activeLyricIndex
                    return (
                      <div
                        key={`${line.time}-${i}`}
                        ref={(el) => {
                          lyricLineRefs.current[i] = el
                        }}
                        className={cn(
                          'max-w-full px-6 py-3 text-left transition-colors duration-300',
                          isWebFullscreen && 'px-8'
                        )}
                      >
                        <p
                          className={cn(
                            'm-0 leading-relaxed',
                            active
                              ? 'text-lg font-medium text-[var(--md-sys-color-on-surface)]'
                              : 'text-base text-[color:color-mix(in_srgb,var(--md-sys-color-on-surface-variant)_60%,transparent)]'
                          )}
                        >
                          {line.text}
                        </p>
                        {line.translation && (
                          <p
                            className={cn(
                              'm-0 mt-1 text-sm leading-relaxed',
                              active
                                ? 'text-[color:color-mix(in_srgb,var(--md-sys-color-on-surface-variant)_80%,transparent)]'
                                : 'text-[color:color-mix(in_srgb,var(--md-sys-color-on-surface-variant)_50%,transparent)]'
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
        </div>
      )}
    </div>
  )
}
