import { useCallback, useRef, useState } from 'react'
import { usePlaybackPosition } from '../hooks/usePlaybackPosition'
import { cn, formatDuration } from '@/lib/utils'

/**
 * 播放进度条（Hydrogen 样式：1.3vh 黑条 + 0.5px 描边；canControl 可拖动）。
 * 独立组件：进度经 usePlaybackPosition(0.25) 量化订阅——positionSec 的
 * 高频更新只重渲染本组件（含拖动预览），不拖累整块播放面板。
 * seek 等位锁状态由父级持有（歌词行点击 seek 共用同一把锁），经 props 传入。
 */
export function PlayerProgressBar({
  durationSec,
  canControl,
  currentKey,
  seekLock,
  onSeek,
  onRequestSeek,
}: {
  durationSec: number
  canControl: boolean
  currentKey: string | null
  /** seek 等位锁快照（父级持有：进度条拖动与歌词行点击共用） */
  seekLock: { key: string | null; sec: number } | null
  /** 执行 seek 并挂等位锁（父级实现：seek + setSeekLock） */
  onSeek: (sec: number) => void
  /** 观众 seek 申请路径（可选；缺省时进度条观众只读） */
  onRequestSeek?: (sec: number) => void
}) {
  const positionSec = usePlaybackPosition(0.25)
  const progressRef = useRef<HTMLDivElement>(null)

  /** 拖动预览值（拖动期间进度条即时跟手，松手后才真 seek） */
  const [dragPreviewSec, setDragPreviewSec] = useState<number | null>(null)

  /** 进度条展示秒数：拖动预览 > seek 等位锁 > 实际播放进度 */
  const seekLockActive =
    seekLock != null &&
    seekLock.key === currentKey &&
    Math.abs(positionSec - seekLock.sec) > 0.75
  const progressDisplaySec =
    dragPreviewSec ?? (seekLockActive && seekLock ? seekLock.sec : positionSec)
  const progressDisplayRatio =
    durationSec > 0
      ? Math.min(1, Math.max(0, progressDisplaySec / durationSec))
      : 0

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

  /**
   * 拖动进度（canControl 直接 seek；观众走 onRequestSeek 申请——
   * 房主「自动通过」开启时立即生效，关闭时转左上角审批）。
   * Hydrogen vue-slider 模式复刻：拖动态 animateTime=0（即时跟手、无
   * transition 门），松手后外部值变化以 0.5s ease 平滑重定向（对应
   * :duration=0.5 与组件默认缓动）；松手 seek 后由 seek 等位锁托住展示
   * 值，杜绝「回退旧进度再前进」的横跳。
   */
  const handleProgressPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (durationSec <= 0) return
      if (!canControl && !onRequestSeek) return
      e.preventDefault()
      e.stopPropagation()
      setDragPreviewSec(computeTimeFromClientX(e.clientX))
      const handleMove = (ev: PointerEvent) => {
        setDragPreviewSec(computeTimeFromClientX(ev.clientX))
      }
      const handleUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        const target = computeTimeFromClientX(ev.clientX)
        if (canControl) onSeek(target)
        else onRequestSeek?.(target)
        // 松手即清预览：等位锁接管展示值（锁定在 seek 目标），
        // 实际进度追上后以 0.5s ease 平滑恢复跟播
        setDragPreviewSec(null)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [canControl, onRequestSeek, durationSec, onSeek, computeTimeFromClientX]
  )

  return (
    <>
      <div className="flex items-center justify-between text-[max(1.5vh,11px)] font-bold tabular-nums text-[var(--md-sys-color-on-surface)]">
        <span>{formatDuration(progressDisplaySec)}</span>
        <span>{formatDuration(durationSec)}</span>
      </div>
      <div
        ref={progressRef}
        role="slider"
        aria-label={
          canControl
            ? '播放进度'
            : onRequestSeek
              ? '播放进度（拖动将向房主申请调节）'
              : '播放进度（仅房主可拖动）'
        }
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(positionSec)}
        aria-disabled={!canControl && !onRequestSeek}
        className={cn(
          'touch-slider relative mt-[max(1vh,6px)] h-[max(1.3vh,6px)]',
          (canControl || onRequestSeek) && 'cursor-pointer'
        )}
        style={{
          boxShadow: '0 0 0 0.5px var(--md-sys-color-on-surface)',
        }}
        onPointerDown={handleProgressPointerDown}
      >
        <div
          className="absolute left-0 top-0 h-full"
          style={{
            // 拖动预览值即时跟手（无过渡）；松手后位置值变化
            // 以 0.5s ease 平滑补间（Hydrogen vue-slider
            // :duration=0.5 与组件默认缓动）
            width: `${progressDisplayRatio * 100}%`,
            backgroundColor: 'var(--md-sys-color-on-surface)',
            transition: dragPreviewSec != null ? 'none' : 'width 0.5s ease',
          }}
        />
      </div>
    </>
  )
}
