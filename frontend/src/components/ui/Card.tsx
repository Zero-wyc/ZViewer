import { cn } from '@/lib/utils'
import { useSpotlight } from '@/hooks/useAnimations'

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  elevation?: 'none' | 'low' | 'medium' | 'high'
}

export function Card({
  children,
  className,
  elevation = 'low',
  disableAnimation = false,
  ...props
}: CardProps & { disableAnimation?: boolean }) {
  // spotlight：仅对启用动画的卡片启用鼠标位置感知光晕
  const spotlightRef = useSpotlight<HTMLDivElement>()

  const shadows = {
    none: 'shadow-none',
    low: 'shadow-sm',
    medium: 'shadow-md',
    high: 'shadow-lg',
  }

  return (
    <div
      ref={disableAnimation ? undefined : spotlightRef}
      className={cn(
        'glass-card relative overflow-hidden p-6',
        shadows[elevation],
        !disableAnimation && 'zen-card',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
