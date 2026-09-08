/**
 * 添加到队列的共享逻辑（各内容页复用，逻辑迁移自 MusicSearchPanel）。
 *
 * - 权限：canManage（房主/房管）才能 emit `music:queue-upsert`
 * - 载荷：`{ roomId, item }`（后端 MusicSyncHandler 契约，变更后经
 *   `music:queue-changed` 广播完整队列）
 * - 行内「已添加」态：以曲目 key（ncm:<songId> / siren:<cid>）记录，2s 自动恢复
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import type { NcmSong } from '../types'

/** `music:queue-upsert` 的 item 载荷（与后端 MusicSyncHandler 契约对应） */
export interface QueueUpsertItem {
  /** 网易云歌曲 ID（塞壬条目固定 0） */
  songId: number
  /** 曲目来源（ncm=网易云 / siren=塞壬唱片） */
  source?: 'ncm' | 'siren'
  /** 塞壬歌曲 cid（siren 时必填） */
  sourceId?: string | null
  name: string
  artist: string
  album: string
  cover: string
  durationMs: number
  vip: boolean
}

/** 网易云歌曲 → queue-upsert 载荷 */
export function songToUpsertItem(song: NcmSong): QueueUpsertItem {
  return {
    songId: song.songId,
    source: 'ncm',
    sourceId: null,
    name: song.name,
    artist: song.artist,
    album: song.album,
    cover: song.cover,
    durationMs: song.durationMs,
    vip: song.vip,
  }
}

/** 已添加态的 key（与队列条目 key 同构） */
export function upsertItemKey(item: QueueUpsertItem): string {
  return item.source === 'siren'
    ? `siren:${item.sourceId ?? ''}`
    : `ncm:${item.songId}`
}

/** 「已添加」行内态的展示时长（毫秒） */
const ADDED_STATE_MS = 2000

export interface UseQueueAddResult {
  /** 已添加态集合（key: ncm:<songId> / siren:<cid>） */
  addedKeys: Set<string>
  /** 添加到队列（无权限/未连接房间时提示并忽略） */
  add: (item: QueueUpsertItem) => void
}

export function useQueueAdd(
  socket: Socket | null,
  roomId: string | undefined,
  canManage: boolean
): UseQueueAddResult {
  /** 已添加行内态（key 集合，2s 自动恢复） */
  const [addedKeys, setAddedKeys] = useState<Set<string>>(() => new Set())
  /** 已添加状态自动恢复的定时器（卸载时清理） */
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // 卸载时清理「已添加」恢复定时器
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const add = useCallback(
    (item: QueueUpsertItem) => {
      if (!canManage) {
        message.info('只有房主或房管可以添加歌曲')
        return
      }
      if (!socket || !roomId) {
        message.error('未连接房间')
        return
      }
      socket.emit(
        'music:queue-upsert',
        { roomId, item },
        (response: { success?: boolean; message?: string }) => {
          if (response && response.success === false) {
            message.error(response.message || '添加歌曲失败')
          }
        }
      )
      // 行内「已添加」状态，2s 后恢复
      const key = upsertItemKey(item)
      setAddedKeys((prev) => new Set(prev).add(key))
      const timer = setTimeout(() => {
        setAddedKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
        timersRef.current.delete(timer)
      }, ADDED_STATE_MS)
      timersRef.current.add(timer)
    },
    [canManage, socket, roomId]
  )

  return { addedKeys, add }
}
