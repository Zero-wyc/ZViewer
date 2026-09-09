/**
 * 底部播放控制栏（Hydrogen MusicWidget 悬浮范式，fixed 居中悬浮于底部）。
 *
 * 悬浮形态（移植 Hydrogen .musicWidget 规格）：
 * fixed 水平居中 + 底距 35px + 定宽 722px + 弥散阴影为唯一悬浮感来源；
 * 容器由 MusicAppShell 提供（fixed bottom-[35px] left-1/2 -translate-x-1/2），
 * 本组件只负责卡片本体（M3 适配：glass 玻璃质感 + 圆角）。
 *
 * 结构：
 * - 顶部细进度条：absolute -top-[3px]，h-1 hover:h-2 过渡，primary 填充；
 *   hover 显示「当前 / 总时长」小字；canControl 可拖动 seek，观众只读
 * - 左：封面缩略图（点击 → playerOverlayOpen 打开完整播放器覆盖层，
 *   hover 显示上箭头遮罩）+ 歌名（单行截断，无歌时「一起听」）+ 歌手
 * - 中：三键控制（prev / play-pause / next；canControl 直接控制，
 *   否则 requestControl 走申请制）
 * - 右：音量横条滑块（仅本地生效）+ VOLUME 标签 + 数字 + 队列按钮
 *   （ListMusic → queuePopupOpen 弹出队列弹窗）
 */
import { useCallback, useRef } from 'react'
import {
  ChevronUp,
  ListMusic,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from 'lucide-react'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { cn, formatDuration } from '@/lib/utils'

export function MusicWidgetBar() {
  const {
    togglePlay,
    next,
    prev,
    seek,
    requestControl,
    canControl,
    currentSong,
    isPlaying,
    positionSec,
    volume,
    setVolume,
  } = useMusicPlayer()

  const setPlayerOverlayOpen = useMusicStore((s) => s.setPlayerOverlayOpen)
  const setQueuePopupOpen = useMusicStore((s) => s.setQueuePopupOpen)

  // ===== 进度条（细滑块；canControl 可拖动 seek，观众只读展示） =====
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
    if (canControl) togglePlay()
    else requestControl(isPlaying ? 'pause' : 'play')
  }, [canControl, togglePlay, requestControl, isPlaying])

  const handleNext = useCallback(() => {
    if (canControl) next()
    else requestControl('next')
  }, [canControl, next, requestControl])

  const handlePrev = useCallback(() => {
    if (canControl) prev()
    else requestControl('prev')
  }, [canControl, prev, requestControl])

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

  const cover = currentSong?.cover

  return (
    <div
      className="glass-card relative h-[72px]"
      style={{
        // 悬浮感核心（Hydrogen 暗色 --shadow 规格）：比 glass-card 默认阴影
        // 更弥散更深，覆盖其内置 box-shadow
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      }}
    >
      {/* ===== 顶部细进度条（hover 加粗并显示时间） ===== */}
      <div className="pointer-events-none absolute -top-[3px] left-0 right-0">
        <div
          ref={progressRef}
          role="slider"
          aria-label={canControl ? '播放进度' : '播放进度（仅房主可拖动）'}
          aria-valuemin={0}
          aria-valuemax={Math.round(durationSec)}
          aria-valuenow={Math.round(positionSec)}
          aria-disabled={!canControl}
          className={cn(
            'pointer-events-auto group relative h-1 transition-all duration-200 hover:h-2',
            canControl && 'cursor-pointer'
          )}
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent)',
          }}
          onPointerDown={handleProgressPointerDown}
        >
          <div
            className="absolute left-0 top-0 h-full bg-[var(--md-sys-color-primary)]"
            style={{ width: `${progressRatio * 100}%` }}
          />
          {/* hover 显示当前/总时长小字 */}
          <div className="pointer-events-none absolute right-1 top-1 hidden items-center gap-1 px-1 text-[10px] tabular-nums text-[var(--md-sys-color-on-surface)] group-hover:flex">
            {formatDuration(positionSec)} / {formatDuration(durationSec)}
          </div>
        </div>
      </div>

      {/* ===== 左：封面缩略图 + 歌曲信息 ===== */}
      <div className="absolute left-4 top-1/2 flex min-w-0 -translate-y-1/2 items-center gap-2">
        {/* 封面：点击打开完整播放器覆盖层（hover 上箭头遮罩）；无歌时禁用 */}
        <button
          type="button"
          disabled={!cover}
          className={cn(
            'group/cover relative h-11 w-11 shrink-0 overflow-hidden border',
            cover ? 'cursor-pointer' : 'cursor-default'
          )}
          style={{
            borderColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
            backgroundColor: 'var(--md-sys-color-surface-container-high)',
          }}
          onClick={cover ? () => setPlayerOverlayOpen(true) : undefined}
          title={cover ? '打开完整播放器' : undefined}
          aria-label={cover ? '打开完整播放器' : undefined}
        >
          {cover ? (
            <img src={cover} alt="" className="h-full w-full object-cover" />
          ) : (
            <ListMusic
              className="m-auto h-4 w-4 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
          )}
          {/* hover 遮罩 + 上箭头（Hydrogen open-player 范式；无歌不渲染） */}
          {cover && (
            <span
              className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover/cover:opacity-100"
              style={{
                backgroundColor: 'color-mix(in srgb, black 50%, transparent)',
              }}
            >
              <ChevronUp className="h-4 w-4 text-white" />
            </span>
          )}
        </button>
        {/* 歌名 + 歌手（单行截断；无歌时「一起听」占位） */}
        <div className="w-40 min-w-0 select-text md:w-48">
          <div
            className="truncate text-base font-medium text-[var(--md-sys-color-on-surface)]"
            title={currentSong?.name}
          >
            {currentSong?.name ?? '一起听'}
          </div>
          <div className="truncate text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {currentSong?.artist ?? ''}
          </div>
        </div>
      </div>

      {/* ===== 中：三键控制（上一首 / 播放暂停 / 下一首） ===== */}
      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center">
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
          onClick={handlePrev}
          title={canControl ? '上一首' : '向房主申请切换上一首'}
          aria-label="上一首"
        >
          <SkipBack className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="mx-4 flex h-6 w-6 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
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
          className="flex h-6 w-6 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
          onClick={handleNext}
          title={canControl ? '下一首' : '向房主申请切换下一首'}
          aria-label="下一首"
        >
          <SkipForward className="h-5 w-5" />
        </button>
      </div>

      {/* ===== 右：音量横条滑块 + VOLUME 标签 + 队列按钮 ===== */}
      <div className="absolute right-4 top-1/2 hidden -translate-y-1/2 items-center gap-3 md:flex">
        {/* 音量（Hydrogen volume-container：滑条 + 上方 VOLUME 标签与数字） */}
        <div className="relative w-[110px]">
          <div
            ref={volumeTrackRef}
            role="slider"
            aria-label="音量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(volume * 100)}
            className="relative h-[7px] cursor-pointer"
            style={{
              border: '1px solid var(--md-sys-color-on-surface)',
              boxShadow: '0 0 0 0.5px var(--md-sys-color-on-surface)',
            }}
            onPointerDown={handleVolumePointerDown}
          >
            <div
              className="absolute left-0 top-0 h-full bg-[var(--md-sys-color-on-surface)]"
              style={{ width: `${volume * 100}%` }}
            />
          </div>
          <div className="absolute -top-[13px] left-0 flex items-center gap-1.5">
            <span className="text-[8px] tracking-widest text-[var(--md-sys-color-on-surface-variant)]">
              VOLUME
            </span>
            <span
              className="text-[8px] tabular-nums"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            >
              {Math.round(volume * 100)}
            </span>
          </div>
        </div>
        {/* 队列按钮：弹出 MusicQueuePopup */}
        <button
          type="button"
          className="flex h-6 w-6 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
          onClick={() => setQueuePopupOpen(true)}
          title="播放队列"
          aria-label="播放队列"
        >
          <ListMusic className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
