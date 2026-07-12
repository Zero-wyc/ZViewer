import { useEffect, useState } from 'react'
import { User } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string
  alt?: string
  size?: 'sm' | 'md' | 'lg'
  fallback?: React.ReactNode
}

export function Avatar({
  src,
  alt,
  size = 'md',
  fallback,
  className,
  ...props
}: AvatarProps) {
  const [error, setError] = useState(false)
  const sizes = {
    sm: 'h-6 w-6',
    md: 'h-8 w-8',
    lg: 'h-12 w-12',
  }

  useEffect(() => {
    setError(false)
  }, [src])

  return (
    <div
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full',
        sizes[size],
        className
      )}
      style={{
        backgroundColor: 'var(--md-sys-color-surface-container-high)',
        color: 'var(--md-sys-color-on-surface)',
        border: '1px solid var(--md-sys-color-outline)',
      }}
      {...props}
    >
      {src && !error ? (
        <img
          src={src}
          alt={alt || 'avatar'}
          className="h-full w-full object-cover"
          onError={() => setError(true)}
        />
      ) : (
        fallback || <User className="h-[55%] w-[55%]" />
      )}
    </div>
  )
}
