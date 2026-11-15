import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

// 压在房间画面上的小标签：成员名字、隐藏数量、引擎错误。
//
// 为什么必须自己带底：这一层浮在视频/网页上，继承来的 on-surface 是深色，
// 浅色画面里等于看不见。三处以前各写一遍内联样式，改一处忘两处——现在统一
// 从这里出，底色/字号/圆角只有一个事实源。
//
// 只做"一块带底的字"：绝对定位、左右位置这些属于使用方，用 className 传。

export interface Live2DBadgeProps {
  children: ReactNode
  /**
   * 说话中。
   *
   * 加深底色 + 一圈白描边 + 前面自动加一个呼吸点：画面本身是视频，任何品牌色
   * 都可能被背景吃掉，白色描边是对比度最稳的做法。
   */
  speaking?: boolean
  /**
   * 警告语气（引擎加载失败这种）。
   *
   * 不引入红色：`--md-sys-color-error` 在深色视频背景上反而更糊；这里靠更实的
   * 底色把它和普通的成员标签分开就够了。
   */
  alert?: boolean
  title?: string
  className?: string
  style?: CSSProperties
}

export function Live2DBadge({
  children,
  speaking = false,
  alert = false,
  title,
  className,
  style,
}: Live2DBadgeProps) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-[3px]', className)}
      style={{
        padding: '1px 6px',
        borderRadius: 6,
        background: speaking
          ? 'rgba(0,0,0,0.62)'
          : alert
            ? 'rgba(0,0,0,0.55)'
            : 'rgba(0,0,0,0.35)',
        boxShadow: speaking ? '0 0 0 1px rgba(255,255,255,0.7)' : undefined,
        transition: 'background 140ms ease, box-shadow 140ms ease',
        color: alert ? 'rgba(255,255,255,0.9)' : '#fff',
        fontSize: 10,
        lineHeight: 1.5,
        ...style,
      }}
    >
      {speaking && (
        <span
          className="animate-pulse"
          style={{
            width: 4,
            height: 4,
            borderRadius: 2,
            background: '#fff',
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </span>
  )
}
