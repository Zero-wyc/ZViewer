/**
 * 每日推荐页（Hydrogen RecommendSongs 范式）。
 *
 * - 未登录 → 登录提示卡（MusicLoginGate，扫码弹窗经 store.loginModalOpen）
 * - 已登录 → GET /api/music/ncm/recommend/songs 的 dailySongs 用 SongRow 列表
 *   （与搜索页同交互：canManage hover Plus 添加，「已添加」2s 态）
 */
import { useEffect, useState } from 'react'
import { Check, Loader2, Plus } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import type { NcmSong } from '../types'
import { SongRow } from '../components/SongRow'
import { MusicLoginGate, PageBlockHeader } from './MusicLoginGate'

export interface MusicDailyPageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

/** /recommend/songs 的 dailySongs 条目（网易云结构） */
interface DailySongItem {
  id: number
  name: string
  ar?: Array<{ name?: string }>
  al?: { picUrl?: string; name?: string }
  dt?: number
  /** 0 免费 / 1 VIP / 4 购买专辑 / 8 低音质免费 */
  fee?: number
}

/** 毫秒时长格式化为 m:ss */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function MusicDailyPage({
  socket,
  roomId,
  canManage,
}: MusicDailyPageProps) {
  const loginStatus = useMusicStore((s) => s.loginStatus)

  const [songs, setSongs] = useState<NcmSong[]>([])
  const [loading, setLoading] = useState(false)

  const { addedKeys, add } = useQueueAdd(socket, roomId, canManage)

  // 登录后拉取每日推荐（30 首）
  useEffect(() => {
    if (!loginStatus.loggedIn) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求，loading 置位与请求同步发起
    setLoading(true)
    void (async () => {
      try {
        const { data } = await apiGet<{
          data?: { dailySongs?: DailySongItem[] }
        }>('/api/music/ncm/recommend/songs')
        if (cancelled) return
        const daily = data?.data?.dailySongs
        if (!Array.isArray(daily)) {
          throw new Error('每日推荐获取失败，请稍后重试')
        }
        setSongs(
          daily.map((song) => ({
            songId: song.id,
            name: song.name,
            artist: (song.ar ?? [])
              .map((a) => a.name)
              .filter(Boolean)
              .join(' / '),
            album: song.al?.name ?? '',
            cover: song.al?.picUrl ?? '',
            durationMs: song.dt ?? 0,
            vip: song.fee === 1 || song.fee === 4,
          }))
        )
      } catch (err) {
        console.error('[MusicDailyPage] 每日推荐获取失败:', err)
        if (!cancelled) {
          message.error(
            err instanceof Error ? err.message : '每日推荐获取失败，请稍后重试'
          )
        }
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
        <PageBlockHeader titleEN="DAILY RECOMMENDATION" titleCN="每日推荐" />
        <MusicLoginGate hint="登录后查看专属每日推荐歌曲" />
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
      <PageBlockHeader titleEN="DAILY RECOMMENDATION" titleCN="每日推荐" />

      <div className="mt-4 flex min-h-[240px] flex-1 flex-col">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在获取每日推荐…
          </div>
        )}
        {!loading && songs.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
            今日暂无推荐歌曲
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
