import { cn } from '@/lib/utils'

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  elevation?: 'none' | 'low' | 'medium' | 'high'
}

export function Card({
  children,
  className,
  elevation = 'low',
  ...props
}: CardProps) {
  const shadows = {
    none: 'shadow-none',
    low: 'shadow-sm',
    medium: 'shadow-md',
    high: 'shadow-lg',
  }

  return (
    <div
      className={cn(
        'glass-card relative overflow-hidden p-6 transition-all',
        shadows[elevation],
        'hover:shadow-md',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
