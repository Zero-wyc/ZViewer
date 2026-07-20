import { cn } from '@/lib/utils'

export interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  tip?: string
  size?: number
}

export function Spinner({ tip, size = 24, className }: SpinnerProps) {
  const strokeWidth = Math.max(2, size / 12)
  const orbitRadius = size * 0.5
  const coreRadius = size * 0.18

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 text-[var(--md-sys-color-primary)]',
        className
      )}
    >
      <div
        className="relative"
        style={{ width: size * 1.4, height: size * 1.4 }}
      >
        {/* 最外层扩散光环 */}
        <div
          className="zen-spinner-ring-expand absolute inset-0 rounded-full"
          style={{
            border: `${Math.max(1, strokeWidth * 0.6)}px solid color-mix(in srgb, currentColor 30%, transparent)`,
          }}
        />

        {/* 外轨道环 */}
        <svg
          className="zen-spinner-orbit absolute inset-0"
          width={size * 1.4}
          height={size * 1.4}
          viewBox={`0 0 ${size * 1.4} ${size * 1.4}`}
        >
          <circle
            cx={size * 0.7}
            cy={size * 0.7}
            r={orbitRadius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${size * 1.2} ${size * 2.6}`}
            opacity={0.35}
          />
        </svg>

        {/* 内层反向轨道 */}
        <svg
          className="zen-spinner-orbit-reverse absolute inset-0"
          width={size * 1.4}
          height={size * 1.4}
          viewBox={`0 0 ${size * 1.4} ${size * 1.4}`}
        >
          <circle
            cx={size * 0.7}
            cy={size * 0.7}
            r={orbitRadius * 0.7}
            fill="none"
            stroke="currentColor"
            strokeWidth={Math.max(1, strokeWidth * 0.7)}
            strokeLinecap="round"
            strokeDasharray={`${size * 0.6} ${size * 1.8}`}
            opacity={0.25}
          />
        </svg>

        {/* 内核脉冲 */}
        <div
          className="zen-spinner-pulse absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: coreRadius * 2,
            height: coreRadius * 2,
            backgroundColor: 'currentColor',
            boxShadow: `0 0 ${size * 0.6}px ${size * 0.18}px color-mix(in srgb, currentColor 35%, transparent)`,
          }}
        />

        {/* 装饰光点 */}
        <div
          className="zen-spinner-orbit absolute rounded-full"
          style={{
            width: size * 0.14,
            height: size * 0.14,
            top: size * 0.08,
            left: `calc(50% - ${size * 0.07}px)`,
            backgroundColor: 'currentColor',
            transformOrigin: `50% ${size * 0.62}px`,
            opacity: 0.9,
            boxShadow: `0 0 ${size * 0.2}px color-mix(in srgb, currentColor 50%, transparent)`,
          }}
        />
      </div>
      {tip && (
        <span className="text-sm text-[var(--md-sys-color-on-surface-variant)] zen-text-reveal">
          {tip}
        </span>
      )}
    </div>
  )
}
