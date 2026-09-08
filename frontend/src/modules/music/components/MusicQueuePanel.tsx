/**
 * 播放队列面板（侧栏）：展示房间播放队列并管理。
 *
 * - 当前播放行 primary 高亮（左侧 dot + 歌名 primary，对齐侧栏 active 样式约定）
 * - 房主点击行切歌（经 MusicPlayerContext 消费 playSong，与主播放器共享引擎）
 * - canManage（房主/房管）行尾上移/下移/删除按钮，emit：
 *   - `music:queue-remove`：`{ roomId, id }`（id 为队列条目标识，MusicQueueItem.id）
 *   - `music:queue-reorder`：`{ roomId, ids }`（交换后的完整有序 id 列表）
 *   （与后端 MusicSyncHandler 契约一致，变更后经 `music:queue-changed` 广播完整队列）
 */
import { ListMusic, Music, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { Text, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { cn } from '@/lib/utils'

export interface MusicQueuePanelProps {
  socket: Socket | null
  roomId?: string
  /** 是否为房主（房主可点击行切歌） */
  isHost: boolean
  /** 队列管理权限（房主/房管）可删除/排序 */
  canManage: boolean
  /** 当前播放曲目 songId（null 表示未播放） */
  currentSongId: number | null
}

/** 毫秒时长格式化为 m:ss */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function MusicQueuePanel({
  socket,
  roomId,
  isHost,
  canManage,
  currentSongId,
}: MusicQueuePanelProps) {
  const queue = useMusicStore((s) => s.queue)
  const { playSong } = useMusicPlayer()

  /** 房主点击行切歌 */
  const handlePlaySong = (songId: number) => {
    if (!isHost) return
    if (songId === currentSongId) return
    playSong(songId)
  }

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

  /** 上移/下移：与相邻条目交换后，以完整有序 id 列表提交重排 */
  const handleReorder = (itemId: number, direction: 'up' | 'down') => {
    if (!canManage) return
    if (!socket || !roomId) {
      message.error('未连接房间')
      return
    }
    const ids = queue.map((item) => item.id)
    const idx = ids.indexOf(itemId)
    if (idx < 0) return
    const target = direction === 'up' ? idx - 1 : idx + 1
    if (target < 0 || target >= ids.length) return
    ;[ids[idx], ids[target]] = [ids[target], ids[idx]]
    socket.emit(
      'music:queue-reorder',
      { roomId, ids },
      (response: { success?: boolean; message?: string }) => {
        if (response && response.success === false) {
          message.error(response.message || '调整顺序失败')
        }
      }
    )
  }

  return (
    <div className="glass-card zen-card flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* 卡片头部：图标 + 标题 + 数量 */}
      <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            backgroundColor: 'var(--md-sys-color-primary-container)',
          }}
        >
          <ListMusic
            className="h-4 w-4"
            style={{ color: 'var(--md-sys-color-on-primary-container)' }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Text className="text-sm font-semibold leading-tight">播放队列</Text>
          <Text
            type="secondary"
            className="text-[10px] uppercase tracking-wide"
          >
            MUSIC QUEUE · {queue.length} 首
          </Text>
        </div>
      </div>

      {/* 队列内容 */}
      <div className="zen-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-3">
        {queue.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full"
              style={{
                backgroundColor: 'var(--glass-bg)',
              }}
            >
              <ListMusic
                className="h-5 w-5 opacity-40"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              />
            </div>
            <Paragraph type="secondary" className="m-0 text-xs">
              队列为空，去搜索添加歌曲
            </Paragraph>
          </div>
        )}
        {queue.map((item, idx) => {
          const isActive = item.songId === currentSongId
          return (
            <div
              key={item.id}
              className={cn(
                'zen-item-enter group flex items-center gap-2.5 rounded-[var(--md-sys-shape-corner)] border p-2 transition-all',
                isHost &&
                  'cursor-pointer hover:-translate-y-0.5 hover:shadow-md',
                isActive
                  ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)] shadow-md'
                  : 'glass border-transparent hover:border-[var(--md-sys-color-outline-variant)]'
              )}
              style={{ '--item-delay': `${idx * 40}ms` } as React.CSSProperties}
              onClick={() => handlePlaySong(item.songId)}
              title={isHost ? (isActive ? '正在播放' : '点击播放') : undefined}
            >
              {/* 序号 / 当前播放指示 */}
              <div className="flex w-4 shrink-0 items-center justify-center">
                {isActive ? (
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      backgroundColor: 'var(--md-sys-color-primary)',
                      boxShadow: '0 0 6px var(--md-sys-color-primary)',
                    }}
                  />
                ) : (
                  <Text type="secondary" className="text-[10px] tabular-nums">
                    {idx + 1}
                  </Text>
                )}
              </div>

              {/* 封面缩略图 */}
              {item.cover ? (
                <img
                  src={item.cover}
                  alt={item.name}
                  className="h-6 w-6 shrink-0 rounded-[var(--md-sys-shape-corner)] object-cover"
                  loading="lazy"
                />
              ) : (
                <div
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                  }}
                >
                  <Music
                    className="h-3 w-3"
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  />
                </div>
              )}

              {/* 歌名 + 歌手 / 时长 */}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Paragraph
                  className={cn(
                    'm-0 truncate text-xs font-medium',
                    isActive &&
                      'text-[var(--md-sys-color-on-primary-container)]'
                  )}
                  style={
                    isActive
                      ? { color: 'var(--md-sys-color-on-primary-container)' }
                      : undefined
                  }
                  title={item.name}
                >
                  {item.name}
                </Paragraph>
                <div className="flex items-center gap-1.5">
                  <Text
                    type="secondary"
                    className={cn(
                      'truncate text-[10px]',
                      isActive &&
                        'text-[var(--md-sys-color-on-primary-container)] opacity-80'
                    )}
                    title={item.artist}
                  >
                    {item.artist}
                  </Text>
                  <Text
                    type="secondary"
                    className={cn(
                      'shrink-0 text-[10px] tabular-nums',
                      isActive &&
                        'text-[var(--md-sys-color-on-primary-container)] opacity-80'
                    )}
                  >
                    {formatDurationMs(item.durationMs)}
                  </Text>
                </div>
              </div>

              {/* 队列管理按钮（房主/房管；点击不触发行切歌） */}
              {canManage && (
                <div
                  className="flex shrink-0 items-center gap-0.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    onClick={() => handleReorder(item.songId, 'up')}
                    disabled={idx === 0}
                    className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)] disabled:opacity-30 disabled:hover:bg-transparent"
                    style={{
                      color: isActive
                        ? 'var(--md-sys-color-on-primary-container)'
                        : 'var(--md-sys-color-on-surface-variant)',
                    }}
                    title="上移"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReorder(item.songId, 'down')}
                    disabled={idx === queue.length - 1}
                    className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)] disabled:opacity-30 disabled:hover:bg-transparent"
                    style={{
                      color: isActive
                        ? 'var(--md-sys-color-on-primary-container)'
                        : 'var(--md-sys-color-on-surface-variant)',
                    }}
                    title="下移"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(item.id)}
                    className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                    style={{ color: 'var(--md-sys-color-error)' }}
                    title="从队列删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
