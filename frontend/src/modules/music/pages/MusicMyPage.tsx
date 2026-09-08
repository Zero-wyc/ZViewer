/**
 * 我的音乐页（Hydrogen MyMusic 范式简化版）。
 *
 * - 未登录 → 登录提示卡
 * - GET /api/music/ncm/user/account 拿 uid → /user/playlist 网格卡片
 *   （封面 + 名称 + trackCount）
 * - 点击歌单卡片 → 内嵌展开：拉 /playlist/track/all?id= 取歌曲 SongRow 列表
 *   （canManage hover Plus 添加，「已添加」2s 态）
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Check, Loader2, Plus, ListMusic } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import type { NcmSong } from '../types'
import { SongRow } from '../components/SongRow'
import { cn } from '@/lib/utils'
import { MusicLoginGate, PageBlockHeader } from './MusicLoginGate'

export interface MusicMyPageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

/** /user/playlist 条目 */
interface UserPlaylistItem {
  id: number
  name: string
  coverImgUrl?: string
  trackCount?: number
  creator?: { nickname?: string }
}

/** /playlist/track/all 条目（cloudsearch 同构） */
interface PlaylistTrackItem {
  id: number
  name: string
  ar?: Array<{ name?: string }>
  al?: { name?: string; picUrl?: string }
  dt?: number
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

/** PlaylistTrackItem → NcmSong */
function mapTrack(song: PlaylistTrackItem): NcmSong {
  return {
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
  }
}

export function MusicMyPage({ socket, roomId, canManage }: MusicMyPageProps) {
  const loginStatus = useMusicStore((s) => s.loginStatus)

  /** 我的歌单 */
  const [playlists, setPlaylists] = useState<UserPlaylistItem[]>([])
  const [loading, setLoading] = useState(false)
  /** 当前展开的歌单（id + 歌单信息） */
  const [openPlaylist, setOpenPlaylist] = useState<UserPlaylistItem | null>(
    null
  )
  const [openSongs, setOpenSongs] = useState<NcmSong[]>([])
  const [openLoading, setOpenLoading] = useState(false)

  const { addedKeys, add } = useQueueAdd(socket, roomId, canManage)

  // 登录后：/user/account 拿 uid → /user/playlist 拉歌单
  useEffect(() => {
    if (!loginStatus.loggedIn) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求，loading 置位与请求同步发起
    setLoading(true)
    void (async () => {
      try {
        const acc = await apiGet<{
          profile?: { userId?: number; nickname?: string }
        }>('/api/music/ncm/user/account')
        const uid = acc.data?.profile?.userId
        if (!uid) throw new Error('获取网易云账号失败')
        const pl = await apiGet<{ playlist?: UserPlaylistItem[] }>(
          `/api/music/ncm/user/playlist?uid=${uid}`
        )
        if (cancelled) return
        setPlaylists(Array.isArray(pl.data?.playlist) ? pl.data.playlist : [])
      } catch (err) {
        console.error('[MusicMyPage] 我的音乐获取失败:', err)
        if (!cancelled) {
          message.error('我的音乐获取失败，请稍后重试')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loginStatus.loggedIn])

  /** 展开歌单：拉 /playlist/track/all 内嵌 SongRow 列表 */
  const handleOpenPlaylist = useCallback((pl: UserPlaylistItem) => {
    setOpenPlaylist(pl)
    setOpenSongs([])
    setOpenLoading(true)
    void (async () => {
      try {
        const { data } = await apiGet<{ songs?: PlaylistTrackItem[] }>(
          `/api/music/ncm/playlist/track/all?id=${pl.id}&limit=50`
        )
        if (!Array.isArray(data?.songs)) {
          throw new Error('歌单详情获取失败')
        }
        setOpenSongs(data.songs.map(mapTrack).filter((s) => s.songId > 0))
      } catch (err) {
        console.error('[MusicMyPage] 歌单详情获取失败:', err)
        message.error('歌单详情获取失败，请稍后重试')
      } finally {
        setOpenLoading(false)
      }
    })()
  }, [])

  if (!loginStatus.loggedIn) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        <PageBlockHeader titleEN="MY MUSIC" titleCN="我的音乐" />
        <MusicLoginGate hint="登录后查看我的歌单" />
      </div>
    )
  }

  // ===== 内嵌展开视图：歌单详情 + SongRow 列表 =====
  if (openPlaylist) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        {/* 返回按钮 + 歌单信息 */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
            onClick={() => setOpenPlaylist(null)}
            title="返回歌单列表"
            aria-label="返回歌单列表"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span
            className="py-px pl-1 pr-8 text-[10px] font-bold uppercase tracking-widest"
            style={{
              backgroundColor: 'var(--md-sys-color-on-surface)',
              color: 'var(--md-sys-color-surface)',
            }}
          >
            PLAYLIST
          </span>
          <span className="truncate text-xl font-bold text-[var(--md-sys-color-on-surface)]">
            {openPlaylist.name}
          </span>
          <span className="shrink-0 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {openPlaylist.trackCount ?? 0} 首
          </span>
        </div>

        <div className="mt-4 flex min-h-[240px] flex-1 flex-col">
          {openLoading && (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在获取歌单歌曲…
            </div>
          )}
          {!openLoading && openSongs.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
              歌单暂无歌曲
            </div>
          )}
          {openSongs.map((song, idx) => {
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

  // ===== 歌单网格视图 =====
  return (
    <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
      <PageBlockHeader
        titleEN="MY MUSIC"
        titleCN={`我的音乐${loginStatus.nickname ? ` · ${loginStatus.nickname}` : ''}`}
      />

      <div className="mt-4 min-h-[200px] flex-1">
        {loading && (
          <div className="flex items-center gap-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在获取我的音乐…
          </div>
        )}
        {!loading && playlists.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <ListMusic
              className="h-6 w-6 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
            <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
              暂无歌单
            </span>
          </div>
        )}
        <div className="grid grid-cols-3 gap-x-10 gap-y-8 md:grid-cols-4 xl:grid-cols-5">
          {playlists.map((pl) => (
            <button
              key={pl.id}
              type="button"
              className="min-w-0 text-left"
              onClick={() => handleOpenPlaylist(pl)}
              title={`打开歌单「${pl.name}」`}
            >
              <div
                className={cn(
                  'overflow-hidden transition-shadow duration-200',
                  'hover:shadow-[0_0_10px_1px_color-mix(in_srgb,black_10%,transparent)]'
                )}
              >
                {pl.coverImgUrl ? (
                  <img
                    src={`${pl.coverImgUrl.replace('http://', 'https://')}?param=450y450`}
                    alt={pl.name}
                    className="block aspect-square w-full object-cover"
                    style={{
                      border:
                        '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 4%, transparent)',
                    }}
                    draggable={false}
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="flex aspect-square w-full items-center justify-center"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
                    }}
                  >
                    <ListMusic
                      className="h-6 w-6 opacity-40"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    />
                  </div>
                )}
              </div>
              <div className="mt-1.5 line-clamp-2 break-all text-sm font-bold leading-snug text-[var(--md-sys-color-on-surface)]">
                {pl.name}
              </div>
              <div className="mt-0.5 truncate text-xs text-[var(--md-sys-color-on-surface-variant)]">
                {pl.trackCount ?? 0} 首
                {pl.creator?.nickname ? ` · ${pl.creator.nickname}` : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
