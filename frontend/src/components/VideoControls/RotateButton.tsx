import { RectangleHorizontal, RectangleVertical } from 'lucide-react'
import { t } from '@/i18n'
import { IconButton } from './IconButton'

export interface RotateButtonProps {
  /** 当前是否已强制横屏 */
  forcedLandscape: boolean
  /** 切换横屏 / 竖屏 */
  onToggle: () => void
  /** 传给 IconButton 的尺寸（控制栏内一般用 bar） */
  size?: 'sm' | 'md' | 'bar'
  /** 点击时阻止冒泡（播放器覆盖层防误触） */
  stopPropagation?: boolean
}

/**
 * 播放器全屏后的横屏 / 竖屏切换按钮。
 * 仅在触屏设备且已进入全屏时由调用方渲染（见 usePlayerRotation）。
 */
export function RotateButton({
  forcedLandscape,
  onToggle,
  size = 'bar',
  stopPropagation = false,
}: RotateButtonProps): JSX.Element {
  const label = forcedLandscape ? t('竖屏') : t('横屏')
  return (
    <IconButton
      size={size}
      stopPropagation={stopPropagation}
      label={label}
      active={forcedLandscape}
      onClick={onToggle}
      icon={
        forcedLandscape ? (
          <RectangleVertical size={18} />
        ) : (
          <RectangleHorizontal size={18} />
        )
      }
    />
  )
}
