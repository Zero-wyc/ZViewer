/**
 * 云盘页（Hydrogen CloudDisk 范式简化版）。
 *
 * - 未登录 → 登录提示卡
 * - GET /api/music/ncm/user/cloud 的 simpleSong（id/name/ar/al/dt）
 *   映射为 NcmSong（source ncm）→ SongRow 列表（canManage 添加；
 *   云盘歌曲 songId 可直接走 /api/music/stream 代理）
 */
import { useEffect, useState } from 'react'
import { Check, Cloud, Loader2, Plus } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import type { NcmSong } from '../types'
import { SongRow } from '../components/SongRow'
import { MusicLoginGate, PageBlockHeader } from './MusicLoginGate'

export interface MusicCloudPageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

/** /user/cloud 条目（simpleSong 内嵌） */
interface CloudSongItem {
  simpleSong?: {
    id: number
    name: string
    ar?: Array<{ name?: string }>
    al?: { name?: string; picUrl?: string }
    dt?: number
    fee?: number
  }
}

/** 毫秒时长格式化为 m:ss */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function MusicCloudPage({
  socket,
  roomId,
  canManage,
}: MusicCloudPageProps) {
  const loginStatus = useMusicStore((s) => s.loginStatus)

  const [songs, setSongs] = useState<NcmSong[]>([])
  const [loading, setLoading] = useState(false)

  const { addedKeys, add } = useQueueAdd(socket, roomId, canManage)

  // 登录后拉取云盘歌曲
  useEffect(() => {
    if (!loginStatus.loggedIn) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求，loading 置位与请求同步发起
    setLoading(true)
    void (async () => {
      try {
        const { data } = await apiGet<{ data?: CloudSongItem[] }>(
          '/api/music/ncm/user/cloud?limit=100'
        )
        if (cancelled) return
        const items = Array.isArray(data?.data) ? data.data : []
        setSongs(
          items
            .map((item) => item.simpleSong)
            .filter((s): s is NonNullable<CloudSongItem['simpleSong']> => !!s)
            .map((s) => ({
              songId: s.id,
              name: s.name,
              artist: (s.ar ?? [])
                .map((a) => a.name)
                .filter(Boolean)
                .join(' / '),
              album: s.al?.name ?? '',
              cover: s.al?.picUrl ?? '',
              durationMs: s.dt ?? 0,
              vip: s.fee === 1 || s.fee === 4,
            }))
            .filter((s) => s.songId > 0)
        )
      } catch (err) {
        console.error('[MusicCloudPage] 云盘获取失败:', err)
        if (!cancelled) message.error('云盘获取失败，请稍后重试')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loginStatus.loggedIn])

  if (!loginStatus.loggedIn) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        <PageBlockHeader titleEN="CLOUD DISK" titleCN="云盘" />
        <MusicLoginGate hint="登录后查看网易云云盘歌曲" />
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
      <PageBlockHeader titleEN="CLOUD DISK" titleCN="云盘" />

      <div className="mt-4 flex min-h-[240px] flex-1 flex-col">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在获取云盘歌曲…
          </div>
        )}
        {!loading && songs.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
            <Cloud
              className="h-6 w-6 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
            <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
              云盘暂无歌曲
            </span>
          </div>
        )}
        {songs.map((song, idx) => {
          const added = addedKeys.has(`ncm:${song.songId}`)
          return (
            <SongRow
              key={song.songId}
              index={idx + 1}
              name={song.name}
              artist={song.artist}
              duration={formatDurationMs(song.durationMs)}
              vip={song.vip}
              disabled={song.vip && !loginStatus.loggedIn}
              hoverAction={
                added ? (
                  <Check className="h-[18px] w-[18px] text-[var(--md-sys-color-primary)]" />
                ) : (
                  <Plus className="h-[18px] w-[18px]" />
                )
              }
              hoverActionLabel={added ? '已添加' : '添加到队列'}
              onHoverAction={() => add(songToUpsertItem(song))}
            />
          )
        })}
      </div>
    </div>
  )
}
