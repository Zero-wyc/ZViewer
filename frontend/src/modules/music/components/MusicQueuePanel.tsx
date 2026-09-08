/**
 * 播放队列面板（侧栏，Hydrogen 歌单式排版）。
 *
 * - 卡片头保留项目骨架（ListMusic 图标容器 + MUSIC QUEUE · N 首）
 * - Hydrogen 歌单式信息条：一行「共 N 首 · 总时长 mm:ss」
 * - SongRow 队列模式列表：默认序号 / hover 显示 Play 切歌按钮（仅房主）/
 *   当前播放行 EQ 动画；canManage 时行尾 hover 淡入上移/下移/删除操作组
 * - 房主切歌经 MusicPlayerContext 消费 playSong（与主播放器共享引擎），emit：
 *   - `music:queue-remove`：`{ roomId, id }`（id 为队列条目标识，MusicQueueItem.id）
 *   - `music:queue-reorder`：`{ roomId, ids }`（交换后的完整有序 id 列表）
 *   （与后端 MusicSyncHandler 契约一致，变更后经 `music:queue-changed` 广播完整队列）
 */
import { ListMusic, Trash2, ArrowUp, ArrowDown, Play } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { SongRow } from './SongRow'

export interface MusicQueuePanelProps {
  socket: Socket | null
  roomId?: string
  /** 是否为房主（房主可点击切歌） */
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
  const isPlaying = useMusicStore((s) => s.isPlaying)
  const loginStatus = useMusicStore((s) => s.loginStatus)
  const { playSong } = useMusicPlayer()

  /** 房主点击切歌 */
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

  /** Hydrogen 歌单式信息条：共 N 首 · 总时长 */
  const totalDurationMs = queue.reduce((sum, item) => sum + item.durationMs, 0)

  return (
    <div className="glass-card zen-card flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* 卡片头部：图标 + 标题 + 数量（项目骨架保留） */}
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
          <span className="text-sm font-semibold leading-tight text-[var(--md-sys-color-on-surface)]">
            播放队列
          </span>
          <span className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
            MUSIC QUEUE · {queue.length} 首
          </span>
        </div>
      </div>

      {/* 队列内容 */}
      <div className="zen-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
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
        {queue.length > 0 && (
          <>
            {/* Hydrogen 歌单式信息条 */}
            <div className="flex items-center px-2 pb-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              共 {queue.length} 首 · 总时长 {formatDurationMs(totalDurationMs)}
            </div>
            {queue.map((item, idx) => {
              const isActive = item.songId === currentSongId
              return (
                <SongRow
                  key={item.id}
                  index={idx + 1}
                  name={item.name}
                  artist={item.artist}
                  duration={formatDurationMs(item.durationMs)}
                  vip={item.vip}
                  active={isActive}
                  playing={isPlaying}
                  disabled={item.vip && !loginStatus.loggedIn && !isActive}
                  hoverAction={
                    <Play className="h-[18px] w-[18px] fill-current" />
                  }
                  hoverActionLabel={
                    isActive ? '正在播放' : isHost ? '点击播放' : undefined
                  }
                  onHoverAction={
                    isHost ? () => handlePlaySong(item.songId) : undefined
                  }
                  rowTitle={
                    isHost ? (isActive ? '正在播放' : '点击播放') : undefined
                  }
                  actions={
                    canManage && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleReorder(item.id, 'up')}
                          disabled={idx === 0}
                          className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)] disabled:opacity-30 disabled:hover:bg-transparent"
                          style={{
                            color: 'var(--md-sys-color-on-surface-variant)',
                          }}
                          title="上移"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleReorder(item.id, 'down')}
                          disabled={idx === queue.length - 1}
                          className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)] disabled:opacity-30 disabled:hover:bg-transparent"
                          style={{
                            color: 'var(--md-sys-color-on-surface-variant)',
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
                      </>
                    )
                  }
                />
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
