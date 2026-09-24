/**
 * seek 等位锁。
 *
 * 解决拖动进度条松手后「倒退再前进」的横跳：seek() 只同步设置
 * audio.currentTime，positionSec 要等下一次 timeupdate 才更新——松手瞬间
 * 展示值会先从拖动终点回退到旧进度再前进。挂锁期间进度条展示值由锁托住，
 * 实际进度追上后自然解锁；失败（元数据未就绪等）时有 2s 超时兜底，绝不
 * 让用户卡在错误进度上。
 *
 * 进度条（拖动）、歌词行点击、观众 seek 申请三条路径共用同一把锁。
 */
import { useCallback, useEffect, useState } from 'react'

/** 等位锁超时兜底（毫秒）：超时后强制回落实际进度 */
const SEEK_LOCK_TIMEOUT_MS = 2000

export interface UseSeekLockOptions {
  /** 本地执行 seek（房主/有控制权时） */
  seek: (sec: number) => void
  /** 当前曲目 key（换曲后旧锁自动失效） */
  currentKey: string | null
}

export function useSeekLock({ seek, currentKey }: UseSeekLockOptions) {
  const [seekLock, setSeekLock] = useState<{
    key: string | null
    sec: number
  } | null>(null)

  /** 本地 seek + 挂锁（自己有权控制时） */
  const seekWithLock = useCallback(
    (time: number) => {
      seek(time)
      setSeekLock({ key: currentKey, sec: time })
    },
    [seek, currentKey]
  )

  /** 只挂锁不 seek（观众申请路径：实际跳转由房主端执行并广播回来） */
  const lockOnly = useCallback(
    (time: number) => {
      setSeekLock({ key: currentKey, sec: time })
    },
    [currentKey]
  )

  // 超时兜底：seek 失败（元数据未就绪等）时实际进度永远追不上，
  // 超时后强制回落实际进度（setState 在定时器回调内，非同步级联）
  useEffect(() => {
    if (seekLock == null) return
    const timer = setTimeout(() => setSeekLock(null), SEEK_LOCK_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [seekLock])

  return { seekLock, seekWithLock, lockOnly }
}
