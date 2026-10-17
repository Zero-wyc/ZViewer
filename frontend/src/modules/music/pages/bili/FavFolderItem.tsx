import { ListMusic } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 收藏夹条目（我的音乐 LibraryItem 同视觉语言：滑入背景 + 图标位 + 双行文字） */
export function FavFolderItem({
  name,
  info,
  cover,
  selected,
  onClick,
}: {
  name: string
  info: string
  /** 收藏夹封面（分页版接口条目带 cover；空串/加载失败回退图标） */
  cover?: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="group relative flex cursor-pointer items-center overflow-hidden p-2"
      aria-selected={selected}
    >
      {/* 滑入背景层（hover 延迟 0.2s，1s cubic-bezier；选中常驻） */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-0 -translate-x-full bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)] will-change-transform transition-transform duration-1000 ease-[cubic-bezier(0.22,0.61,0.36,1)] group-hover:translate-x-0 group-hover:delay-200',
          selected && 'translate-x-0'
        )}
      />
      <div
        className="relative mr-2.5 flex h-[44px] w-[44px] shrink-0 items-center justify-center overflow-hidden"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
          border:
            '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
        }}
      >
        <ListMusic
          className="h-5 w-5 opacity-40"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        />
        {/* 收藏夹封面（absolute 盖住图标位；加载失败隐藏自身露出图标兜底） */}
        {cover && (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        )}
      </div>
      <div className="relative min-w-0 flex-1">
        <p className="truncate text-[17px] font-bold leading-snug text-[var(--md-sys-color-on-surface)]">
          {name}
        </p>
        <p className="truncate text-[14px] font-bold leading-snug text-[var(--md-sys-color-on-surface-variant)]">
          {info}
        </p>
      </div>
    </div>
  )
}
