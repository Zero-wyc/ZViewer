/**
 * 纯净模式（背景视频沉浸）。
 *
 * 背景视频就绪时可用的沉浸态：隐藏面板全部 UI，背景视频经 fixed 提升为
 * 全屏唯一图层。原先内联在 ListenTogetherPanel 中，现连同三条退出路径一起
 * 抽出：Esc 退出、双击退出、背景视频消失时自动退出。
 *
 * 点按层语义（Hydrogen PlayerVideo 同款）：单击延迟 250ms 触发播放/暂停
 * （为双击留判定窗口），双击取消未决单击并直接退出纯净模式。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseImmersiveModeOptions {
  /** 是否可用（仅当背景视频存在时可用；源消失时自动退出避免黑屏） */
  available: boolean
  /** 切换播放/暂停（纯净模式点按层的单击动作） */
  togglePlay: () => void
}

export function useImmersiveMode({
  available,
  togglePlay,
}: UseImmersiveModeOptions) {
  const [immersive, setImmersive] = useState(false)

  // 背景视频消失（切歌到无视频背景的曲目）时自动退出，避免黑屏
  //（render 期调整，替代 effect 内同步 setState，与 prevSongId 同范式）
  const [prevAvailable, setPrevAvailable] = useState(available)
  if (prevAvailable !== available) {
    setPrevAvailable(available)
    if (!available && immersive) setImmersive(false)
  }

  // Esc 退出
  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImmersive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [immersive])

  // 双击退出：单击延迟 250ms 触发切播放暂停（为双击留判定窗口），
  // 双击取消未决单击并直接退出纯净模式（不再渲染右下角退出按钮）
  const tapTimerRef = useRef<number | null>(null)
  // 退出纯净模式 / 卸载时清理未决的单击定时器
  useEffect(() => {
    return () => {
      if (tapTimerRef.current != null) {
        window.clearTimeout(tapTimerRef.current)
        tapTimerRef.current = null
      }
    }
  }, [immersive])

  const onTap = useCallback(
    (e: React.MouseEvent) => {
      if (e.detail >= 2) {
        if (tapTimerRef.current != null) {
          window.clearTimeout(tapTimerRef.current)
          tapTimerRef.current = null
        }
        setImmersive(false)
        return
      }
      if (tapTimerRef.current != null) {
        window.clearTimeout(tapTimerRef.current)
      }
      tapTimerRef.current = window.setTimeout(() => {
        tapTimerRef.current = null
        togglePlay()
      }, 250)
    },
    [togglePlay]
  )

  const enter = useCallback(() => setImmersive(true), [])
  const exit = useCallback(() => setImmersive(false), [])

  return { immersive, enter, exit, onTap }
}
