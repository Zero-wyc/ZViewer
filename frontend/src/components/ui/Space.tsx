import { cn } from '@/lib/utils'

export interface SpaceProps extends React.HTMLAttributes<HTMLDivElement> {
  direction?: 'horizontal' | 'vertical'
  size?: 'sm' | 'md' | 'lg'
  wrap?: boolean
  align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch'
  justify?: 'start' | 'center' | 'end' | 'between'
  children: React.ReactNode
}

export function Space({
  direction = 'horizontal',
  size = 'md',
  wrap = false,
  align = 'center',
  justify,
  children,
  className,
  ...props
}: SpaceProps) {
  const sizes = {
    sm: 'gap-2',
    md: 'gap-4',
    lg: 'gap-6',
  }

  const aligns = {
    start: 'items-start',
    center: 'items-center',
    end: 'items-end',
    baseline: 'items-baseline',
    stretch: 'items-stretch',
  }

  const justifies = {
    start: 'justify-start',
    center: 'justify-center',
    end: 'justify-end',
    between: 'justify-between',
  }

  return (
    <div
      className={cn(
        'flex',
        direction === 'vertical' ? 'flex-col' : 'flex-row',
        sizes[size],
        aligns[align],
        justify && justifies[justify],
        wrap && 'flex-wrap',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
