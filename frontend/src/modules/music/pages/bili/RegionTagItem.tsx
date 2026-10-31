import {
  Ban,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Settings2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

/** 音乐分区种类行（左列；选中滑入背景同 FavFolderItem 语言；
 *  设置按钮打开多 tag 规则弹窗、右上角屏蔽词按钮打开分类屏蔽词弹窗，hover 显示删除；
 *  排序编辑模式下隐藏配置按钮，改为拖拽把手（鼠标）/ 上移下移箭头（触屏兜底） */
export function RegionTagItem({
  name,
  selected,
  removable = false,
  editing = false,
  onClick,
  onOpenRules,
  onOpenBlockWords,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  name: string
  selected: boolean
  removable?: boolean
  /** 排序编辑模式：隐藏配置按钮，显示拖拽把手 / 上下移箭头 */
  editing?: boolean
  onClick: () => void
  /** 分类标签规则设置（多 tag 筛选）入口 */
  onOpenRules?: () => void
  /** 分区限定屏蔽词设置入口（左栏分类条目右上角） */
  onOpenBlockWords?: () => void
  onRemove?: () => void
  /** 上移 / 下移（触屏兜底；undefined 时按钮禁用——首尾条目） */
  onMoveUp?: () => void
  onMoveDown?: () => void
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
      className="group relative flex cursor-pointer items-center overflow-hidden rounded-md p-2"
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
      {/* 拖拽把手（编辑模式；仅鼠标设备显示——触屏用右侧箭头） */}
      {editing && (
        <span
          aria-hidden="true"
          className="relative mr-1 hidden h-5 w-4 shrink-0 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] [@media(pointer:fine)]:flex"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
      )}
      <span
        className={cn(
          'relative min-w-0 flex-1 truncate text-[17px] font-bold',
          selected
            ? 'text-[var(--md-sys-color-primary)]'
            : 'text-[var(--md-sys-color-on-surface)]'
        )}
      >
        {name}
      </span>
      {/* 分类标签规则设置（hover 显形） */}
      {!editing && onOpenRules && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenRules()
          }}
          className="relative mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
          title={t('分类标签规则设置')}
          aria-label={`设置分类 ${name} 的标签规则`}
        >
          <Settings2
            className="h-3 w-3"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          />
        </button>
      )}
      {/* 分区屏蔽词设置（右上角 Ban 图标；hover 显形） */}
      {!editing && onOpenBlockWords && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpenBlockWords()
          }}
          className="relative mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
          title={t('分区屏蔽词设置')}
          aria-label={`设置分区 ${name} 的屏蔽词`}
        >
          <Ban
            className="h-3 w-3"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          />
        </button>
      )}
      {!editing && removable && onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_10%,transparent)]"
          title={t('删除该种类')}
          aria-label={`删除种类 ${name}`}
        >
          <X
            className="h-3 w-3"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          />
        </button>
      )}
      {/* 上移 / 下移（编辑模式触屏兜底：HTML5 拖拽不支持 touch） */}
      {editing && (
        <span className="relative hidden shrink-0 items-center gap-0.5 [@media(pointer:coarse)]:flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onMoveUp?.()
            }}
            disabled={!onMoveUp}
            className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface-variant)] disabled:opacity-25"
            title={t('上移')}
            aria-label={`上移种类 ${name}`}
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onMoveDown?.()
            }}
            disabled={!onMoveDown}
            className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface-variant)] disabled:opacity-25"
            title={t('下移')}
            aria-label={`下移种类 ${name}`}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  )
}
