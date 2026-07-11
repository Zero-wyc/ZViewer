import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  tip?: string
  size?: number
}

export function Spinner({ tip, size = 24, className }: SpinnerProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 text-[var(--md-sys-color-on-surface-variant)]',
        className
      )}
    >
      <Loader2 className="animate-spin" style={{ width: size, height: size }} />
      {tip && <span className="text-sm">{tip}</span>}
    </div>
  )
}
