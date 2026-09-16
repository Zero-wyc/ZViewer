/**
 * 添加到队列的共享逻辑（各内容页复用，逻辑迁移自 MusicSearchPanel）。
 *
 * - 权限：canManage（房主/房管）直接 emit `music:queue-upsert`；观众（无
 *   canManage）走 `music:control-request` addQueue 申请——由房主端按
 *   「自动通过」开关决定代理入队或拒绝（回执提示，见 useListenTogether）
 * - 载荷：`{ roomId, item, afterCurrent }`（后端 MusicSyncHandler 契约，
 *   变更后经 `music:queue-changed` 广播完整队列）
 * - 行内「已添加」态：以曲目 key（ncm:<songId>）记录，2s 自动恢复
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { musicItemKey, useMusicStore } from '../store'
import type { NcmSong } from '../types'

/** `music:queue-upsert` 的 item 载荷（与后端 MusicSyncHandler 契约对应） */
export interface QueueUpsertItem {
  /** 网易云歌曲 ID（B站 条目为 0） */
  songId: number
  name: string
  artist: string
  album: string
  cover: string
  durationMs: number
  vip: boolean
  /** B站 本地插播条目：bvid 存在时走 B站 音源 */
  biliBvid?: string
  biliCid?: number
}

/** 网易云歌曲 → queue-upsert 载荷 */
export function songToUpsertItem(song: NcmSong): QueueUpsertItem {
  return {
    songId: song.songId,
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
  if (item.biliBvid) return `bili:${item.biliBvid}:${item.biliCid ?? 0}`
  return `ncm:${item.songId}`
}

/** 「已添加」行内态的展示时长（毫秒） */
const ADDED_STATE_MS = 2000

export interface UseQueueAddResult {
  /** 已添加态集合（key: ncm:<songId>） */
  addedKeys: Set<string>
  /** 添加到队列（无权限/未连接房间时提示并忽略）；
      afterCurrent：添加到当前播放歌曲的下一首（默认队列尾部）；
      notify：成功后弹顶部「已添加」提示，且歌曲已在队列中时先弹
      非模态确认提示（确认后才追加；双击行入队等场景用） */
  add: (
    item: QueueUpsertItem,
    opts?: { afterCurrent?: boolean; notify?: boolean }
  ) => void
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

  /** 实际入队（emit + 行内「已添加」态 + 可选顶部提示） */
  const doAdd = useCallback(
    (item: QueueUpsertItem, afterCurrent: boolean, notify: boolean) => {
      if (!socket || !roomId) return
      socket.emit(
        'music:queue-upsert',
        { roomId, item, afterCurrent },
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
      if (notify) {
        message.success(`已添加《${item.name}》到播放队列`)
      }
    },
    [socket, roomId]
  )

  const add = useCallback(
    (
      item: QueueUpsertItem,
      opts?: { afterCurrent?: boolean; notify?: boolean }
    ) => {
      if (!socket || !roomId) {
        message.error('未连接房间')
        return
      }
      const afterCurrent = opts?.afterCurrent ?? false
      const notify = opts?.notify ?? false
      // 观众（无 canManage）：走 control-request 申请，由房主按「自动通过」
      // 开关代理入队或拒绝（回执提示见 useListenTogether 的 control-response）
      if (!canManage) {
        socket.emit('music:control-request', {
          roomId,
          action: 'addQueue',
          item,
          afterCurrent,
        })
        message.info('已申请添加到播放列表，等待房主确认')
        return
      }
      // notify 模式：已在队列中时先经非模态确认（重复 upsert 会再追加一条）
      if (
        notify &&
        useMusicStore
          .getState()
          .queue.some((q) => musicItemKey(q) === upsertItemKey(item))
      ) {
        message.confirm(`《${item.name}》已在播放队列中，仍要添加吗？`, [
          { label: '添加', onClick: () => doAdd(item, afterCurrent, notify) },
          { label: '取消', onClick: () => {} },
        ])
        return
      }
      doAdd(item, afterCurrent, notify)
    },
    [canManage, socket, roomId, doAdd]
  )

  return { addedKeys, add }
}
