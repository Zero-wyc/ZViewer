/**
 * 一起听「队列大列表」——面板内队列行点开的二级页面。
 *
 * 手机横屏时控制面板只有 ~390px 高，面板里的小队列只能露出一两行，
 * 因此在队列入口点开后给一个独立的大列表（不再是面板里那条 max-h-40 的窄条）：
 * - 横屏 / 宽屏（layout='side'）：浮窗贴在控制面板左侧，两个浮层并排，
 *   全屏与非全屏都适用；具体定位由 MusicControlPanel 的 queueDockClass 决定，
 *   这里只负责卡片本身。
 * - 竖屏手机（layout='dialog'）：控制面板先收起，只留这个居中大弹窗，
 *   列表可用高度从 ~200px 提到 ~440px。
 *
 * 队列数据与操作都来自控制面板（同一个 useMusicPlayer / music store），
 * 这里只做展示与回调，不重复持有业务状态。全屏浮层复用时由调用方把
 * container 指向舞台内的 portal 宿主（原生全屏只渲染 fullscreen 元素子树）。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListMusic, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { t } from '@/i18n'
import { cn } from '@/lib/utils'
import { musicItemKey } from '../store'
import type { MusicQueueItem } from '../types'

export type MusicQueueWindowLayout = 'side' | 'dialog'

export interface MusicQueueWindowProps {
  queue: MusicQueueItem[]
  currentKey: string | null
  isPlaying: boolean
  /** 当前用户能否点歌（决定「点歌」按钮与清空入口） */
  canRequest: boolean
  /** 当前用户能否删除队列条目（点歌权限或队列管理权限） */
  canRemove: boolean
  layout: MusicQueueWindowLayout
  onPlay: (item: MusicQueueItem) => void
  onRemove: (itemId: number) => void
  onClear: () => void
  onOpenSearch: () => void
  onClose: () => void
  /** side 布局的高度上限（跟随控制面板的语音浮球占位档位） */
  maxHeightClass?: string
  /** dialog 布局的 portal 宿主（全屏时必须挂到舞台内） */
  container?: HTMLElement | null
}

/** 秒数 → m:ss（与控制面板同一格式） */
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const total = Math.floor(sec)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function MusicQueueWindow({
  queue,
  currentKey,
  isPlaying,
  canRequest,
  canRemove,
  layout,
  onPlay,
  onRemove,
  onClear,
  onOpenSearch,
  onClose,
  maxHeightClass = 'max-h-[calc(100dvh-2.5rem)]',
  container,
}: MusicQueueWindowProps) {
  // 清空二次确认：4 秒内不确认自动复位（与控制面板同一交互，避免误触）
  const [confirmClear, setConfirmClear] = useState(false)
  useEffect(() => {
    if (!confirmClear) return undefined
    const timer = window.setTimeout(() => setConfirmClear(false), 4000)
    return () => window.clearTimeout(timer)
  }, [confirmClear])

  const header = (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <ListMusic className="h-4 w-4 shrink-0 opacity-70" />
        <span className="truncate text-xs font-medium">{t('播放队列')}</span>
        <span className="shrink-0 text-[11px] tabular-nums opacity-60">
          ({queue.length})
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canRequest && queue.length > 0 && (
          <Button
            size="sm"
            variant={confirmClear ? 'danger' : 'ghost'}
            className="h-6 px-2 text-[11px]"
            onClick={() => {
              if (confirmClear) {
                setConfirmClear(false)
                onClear()
                return
              }
              setConfirmClear(true)
            }}
          >
            <Trash2 className="mr-0.5 h-3 w-3" />
            {confirmClear ? t('确认清空？') : t('清空队列')}
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          className="h-6 px-2 text-[11px]"
          disabled={!canRequest}
          onClick={onOpenSearch}
        >
          <Plus className="mr-0.5 h-3 w-3" />
          {t('点歌')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={onClose}
          aria-label={t('关闭')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )

  const body = (
    <>
      {header}
      {!canRequest && (
        <div className="shrink-0 text-[11px] opacity-60">
          {t('房主未允许你点歌，可向房主申请')}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain rounded-lg">
        {queue.length === 0 ? (
          <div className="py-6 text-center text-[11px] opacity-50">
            {t('队列为空')}
          </div>
        ) : (
          queue.map((item, index) => {
            const active = musicItemKey(item) === currentKey
            return (
              <div
                key={item.id}
                className={cn(
                  'group flex items-center gap-1.5 rounded-md px-1.5 py-1',
                  active ? 'bg-black/10' : 'hover:bg-black/5'
                )}
              >
                <span className="w-4 shrink-0 text-center text-[10px] tabular-nums opacity-40">
                  {active && isPlaying ? '♪' : index + 1}
                </span>
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onPlay(item)}
                >
                  <div
                    className={cn(
                      'truncate text-xs',
                      active && 'font-medium text-[var(--md-sys-color-primary)]'
                    )}
                  >
                    {item.name}
                  </div>
                  <div className="truncate text-[10px] opacity-50">
                    {item.artist}
                    {item.durationMs > 0
                      ? ` · ${formatDuration(item.durationMs / 1000)}`
                      : ''}
                  </div>
                </button>
                {canRemove && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 shrink-0 p-0 opacity-60 hover:opacity-100"
                    onClick={() => onRemove(item.id)}
                    aria-label={t('从队列移除')}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            )
          })
        )}
      </div>
    </>
  )

  // 竖屏手机：居中大弹窗（控制面板此时已被调用方收起）
  if (layout === 'dialog') {
    // data-music-ui：一起听面板的「点击外部关闭」要认出这是内部二级界面
    return createPortal(
      <div
        data-music-ui="queue"
        className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
        onClick={onClose}
      >
        <div
          className={cn(
            'glass-strong flex w-full max-w-[520px] flex-col gap-2 overflow-hidden rounded-2xl p-3',
            'shadow-2xl zen-modal-content-enter'
          )}
          style={{ maxHeight: 'min(560px, calc(100dvh - 120px))' }}
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </div>,
      container ?? document.body
    )
  }

  // 横屏 / 宽屏：并排浮窗（定位在调用方的 queueDockClass 容器里）
  return (
    <div
      data-music-ui="queue"
      className={cn(
        'glass-card zen-modal-content-enter flex flex-col gap-2 overflow-hidden p-3',
        // 贴着控制面板左侧：右边距 1.5rem + 面板宽 18rem + 间距 0.75rem，
        // 再给左侧留 1rem，窄视口下自动收窄而不是溢出屏幕。
        'w-[min(420px,calc(100vw-340px))]',
        maxHeightClass
      )}
    >
      {body}
    </div>
  )
}
