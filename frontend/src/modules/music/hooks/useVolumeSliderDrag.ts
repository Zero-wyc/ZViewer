import { useCallback, useRef, useState } from 'react'

/**
 * 音量横条滑块拖拽（ListenTogetherPanel 播放卡 / MusicWidgetBar 顶栏共用）。
 *
 * - 拖动期间即时跟手（无过渡），松手后的变化由消费端按 0.3s 平滑补间
 *   （Hydrogen vue-slider :duration=0.3 等价语义）。
 * - 拖动期间锁定页面：body overflow hidden 防触屏拖动带动整页滚动、
 *   pointermove preventDefault 阻断拖出滑条后的文本选择；
 *   配合滑条常挂的 touch-slider（touch-action: none）双重兜底。
 * - 仅本地生效，不参与房间同步（音量始终走消费端传入的 setVolume）。
 */
export function useVolumeSliderDrag(setVolume: (v: number) => void) {
  const volumeTrackRef = useRef<HTMLDivElement>(null)
  const [volumeDragging, setVolumeDragging] = useState(false)

  const handleVolumePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setVolumeDragging(true)
      // 页面锁定：拖动期间禁滚动（恢复时还原原值，避免覆盖外部状态）
      const prevOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
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
      const handleMove = (ev: PointerEvent) => {
        // pointermove 挂在 window（非 passive），preventDefault 阻断
        // 拖出滑条范围后的文本选择
        ev.preventDefault()
        compute(ev.clientX)
      }
      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        window.removeEventListener('pointercancel', handleUp)
        document.body.style.overflow = prevOverflow
        setVolumeDragging(false)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
      window.addEventListener('pointercancel', handleUp)
    },
    [setVolume]
  )

  return { volumeTrackRef, volumeDragging, handleVolumePointerDown }
}
