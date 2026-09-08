/**
 * 队列弹窗（Hydrogen PlayList 弹窗范式，widget 上方弹出）。
 *
 * - 定位：absolute bottom-full 右对齐（widget 右上弹出），glass-card，
 *   w-80 高 24rem，从底部进入动画（translate-y + opacity）
 * - 头部：「当前播放 (N)」+ 定位到当前 + 关闭
 * - 列表行：Hydrogen PlayList 行范式（EQ 频谱 + 「歌名 - 歌手」单行截断）；
 *   当前播放行浅高亮 + EQ 动画；canControl 点击切歌（playSong(item)）；
 *   canManage 行尾 hover 淡入删除（queue-remove）
 * - 空态文案
 */
import { useEffect, useRef } from 'react'
import { Crosshair, X, Trash2 } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { useMusicStore, musicItemKey } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { EqBars } from './SongRow'
import { cn } from '@/lib/utils'

export interface MusicQueuePopupProps {
  socket: Socket | null
  roomId?: string
  /** 是否为房主（canControl 者可点击切歌，房主为主） */
  isHost: boolean
  /** 队列管理权限（房主/房管）可删除 */
  canManage: boolean
}

export function MusicQueuePopup({
  socket,
  roomId,
  canManage,
}: MusicQueuePopupProps) {
  const queue = useMusicStore((s) => s.queue)
  const currentKey = useMusicStore((s) => s.currentKey)
  const isPlaying = useMusicStore((s) => s.isPlaying)
  const setQueuePopupOpen = useMusicStore((s) => s.setQueuePopupOpen)
  const { playSong, canControl } = useMusicPlayer()

  // 打开时滚动到当前播放行（Hydrogen getPositon 范式）
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (currentKey == null) return
    const idx = queue.findIndex((item) => musicItemKey(item) === currentKey)
    if (idx < 0) return
    listRef.current?.scrollTo({
      top: Math.max(0, idx * 37 - 80),
      behavior: 'smooth',
    })
  }, [queue, currentKey])

  /** canControl 点击行切歌 */
  const handlePlay = (item: (typeof queue)[number]) => {
    if (!canControl) {
      message.info('由房主控制播放')
      return
    }
    if (musicItemKey(item) === currentKey) return
    playSong(item)
  }

  /** canManage 删除队列条目 */
  const handleRemove = (itemId: number) => {
    if (!canManage) {
      message.info('只有房主或房管可以删除歌曲')
      return
    }
    if (!socket || !roomId) {
      message.error('未连接房间')
      return
    }
    socket.emit(
      'music:queue-remove',
      { roomId, id: itemId },
      (response: { success?: boolean; message?: string }) => {
        if (response && response.success === false) {
          message.error(response.message || '删除歌曲失败')
        }
      }
    )
  }

  return (
    <div className="glass-card zen-stagger-fade-up absolute bottom-[calc(100%+8px)] right-2 z-50 flex h-96 w-80 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)] shadow-lg">
      {/* ===== 头部：当前播放 (N) + 定位 + 关闭 ===== */}
      <div className="flex shrink-0 items-center justify-between pl-4 pr-3 pt-3">
        <div className="flex items-baseline gap-1.5">
          <span className="text-base font-semibold text-[var(--md-sys-color-on-surface)]">
            当前播放
          </span>
          <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            ({queue.length})
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] transition-opacity hover:opacity-70 active:scale-90"
            onClick={() => {
              const idx = queue.findIndex(
                (item) => musicItemKey(item) === currentKey
              )
              if (idx >= 0) {
                listRef.current?.scrollTo({
                  top: Math.max(0, idx * 37 - 80),
                  behavior: 'smooth',
                })
              }
            }}
            title="定位到当前播放"
            aria-label="定位到当前播放"
          >
            <Crosshair className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] transition-opacity hover:opacity-70 active:scale-90"
            onClick={() => setQueuePopupOpen(false)}
            title="关闭"
            aria-label="关闭队列弹窗"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {/* 分隔线（Hydrogen line：细黑线） */}
      <div
        className="mx-4 my-2 h-px shrink-0"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 60%, transparent)',
        }}
      />

      {/* ===== 列表（EQ + 歌名 - 歌者；当前行高亮；hover 删除） ===== */}
      <div
        ref={listRef}
        className="zen-scroll min-h-0 flex-1 overflow-y-auto pb-2"
      >
        {queue.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <ListMusicIcon />
            <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
              队列为空，去搜索或塞壬唱片添加歌曲
            </span>
          </div>
        ) : (
          queue.map((item) => {
            const itemKey = musicItemKey(item)
            const active = itemKey === currentKey
            return (
              <div
                key={item.id}
                className={cn(
                  'group flex h-[37px] shrink-0 cursor-pointer items-center justify-between px-3 pl-4 transition-colors duration-200',
                  'hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)]',
                  active &&
                    'bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)]'
                )}
                onClick={() => handlePlay(item)}
                title={
                  active ? '正在播放' : canControl ? '点击播放' : undefined
                }
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  {/* 当前播放行 EQ（复用 EqBars） */}
                  {active && (
                    <span className="flex w-3.5 shrink-0 items-center justify-center text-[var(--md-sys-color-primary)]">
                      <EqBars paused={!isPlaying} />
                    </span>
                  )}
                  <span
                    className={cn(
                      'min-w-0 truncate text-sm',
                      active
                        ? 'text-[var(--md-sys-color-primary)]'
                        : 'text-[var(--md-sys-color-on-surface)]'
                    )}
                  >
                    {item.name}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {' - '}
                  </span>
                  <span className="min-w-0 truncate text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {item.artist}
                  </span>
                </div>
                {/* canManage 删除（行 hover 淡入） */}
                {canManage && (
                  <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-70"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(item.id)
                    }}
                    title="从队列删除"
                    aria-label="从队列删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 空态图标（避免与 ListMusic 主按钮命名冲突的内联小图标） */
function ListMusicIcon() {
  return (
    <svg
      className="h-6 w-6 opacity-40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
      aria-hidden="true"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="15" y2="12" />
      <path d="M3 18h8" />
      <circle cx="18" cy="16" r="3" />
      <path d="M21 16V5" />
    </svg>
  )
}
