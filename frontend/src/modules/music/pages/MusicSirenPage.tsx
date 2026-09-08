/**
 * 塞壬唱片页（Hydrogen SirenPage 范式）：专辑网格 + 专辑详情内嵌视图。
 *
 * - 专辑网格：GET /api/music/siren/albums → [{cid,name,cover,intro}]
 *   （方形封面 + 名称；点击进入详情）
 * - 专辑详情：返回按钮 + 封面 + 简介 intro + 歌曲列表（SongRow）；
 *   歌曲行「添加到队列」用 source:'siren'、songId:0、sourceId:cid、vip:false、
 *   artist=artists 拼接、duration（秒→毫秒）、封面用专辑 cover
 * - detail 的 songs 字段结构宽松：可能在 data.songs 或 data 内联，按数组宽松解析
 * - 塞壬无需登录，公开接口转发；播放时后端 stream 代理解析（?source=siren&sourceId=）
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Check, Loader2, Plus, Disc3 } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useQueueAdd, type QueueUpsertItem } from '../hooks/useQueueAdd'
import type { SirenAlbum, SirenSong } from '../types'
import { SongRow } from '../components/SongRow'
import { cn } from '@/lib/utils'
import { PageBlockHeader } from './MusicLoginGate'

export interface MusicSirenPageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

/** 毫秒时长格式化为 m:ss（塞壬 duration 单位为秒，先转毫秒） */
function formatSirenDuration(sec: number | undefined): string {
  const ms = (sec ?? 0) * 1000
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * 宽松解析专辑详情响应：songs 可能在 data.songs 或 data 内联。
 * 返回 { album, songs }（都可为空）。
 */
function parseAlbumDetail(data: unknown): {
  album: SirenAlbum | null
  songs: SirenSong[]
} {
  if (Array.isArray(data)) {
    return { album: null, songs: data as SirenSong[] }
  }
  if (!data || typeof data !== 'object') return { album: null, songs: [] }
  const obj = data as Record<string, unknown>
  const album =
    obj.album && typeof obj.album === 'object'
      ? (obj.album as SirenAlbum)
      : null
  let songs: SirenSong[] = []
  if (Array.isArray(obj.songs)) {
    songs = obj.songs as SirenSong[]
  } else if (Array.isArray(obj.data)) {
    songs = obj.data as SirenSong[]
  }
  return { album, songs }
}

export function MusicSirenPage({
  socket,
  roomId,
  canManage,
}: MusicSirenPageProps) {
  /** 专辑列表 */
  const [albums, setAlbums] = useState<SirenAlbum[]>([])
  const [albumsLoading, setAlbumsLoading] = useState(true)
  /** 当前详情视图的专辑 */
  const [openAlbum, setOpenAlbum] = useState<SirenAlbum | null>(null)
  const [openSongs, setOpenSongs] = useState<SirenSong[]>([])
  const [openLoading, setOpenLoading] = useState(false)

  const { addedKeys, add } = useQueueAdd(socket, roomId, canManage)

  // 专辑列表（公开接口，无需登录；失败显示重试态）
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 页面挂载驱动的外部数据请求，loading 置位与请求同步发起
    setAlbumsLoading(true)
    void (async () => {
      try {
        const { data } = await apiGet<SirenAlbum[]>('/api/music/siren/albums')
        if (cancelled) return
        setAlbums(Array.isArray(data) ? data : [])
      } catch (err) {
        console.error('[MusicSirenPage] 专辑列表获取失败:', err)
        if (!cancelled) setAlbums([])
      } finally {
        if (!cancelled) setAlbumsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** 打开专辑详情：GET /siren/album/{cid}/detail（songs 宽松解析） */
  const handleOpenAlbum = useCallback((album: SirenAlbum) => {
    setOpenAlbum(album)
    setOpenSongs([])
    setOpenLoading(true)
    void (async () => {
      try {
        const { data } = await apiGet<unknown>(
          `/api/music/siren/album/${encodeURIComponent(album.cid)}/detail`
        )
        const { songs } = parseAlbumDetail(data)
        setOpenSongs(songs.filter((s) => !!s.cid))
      } catch (err) {
        console.error('[MusicSirenPage] 专辑详情获取失败:', err)
        message.error('专辑详情获取失败，请稍后重试')
      } finally {
        setOpenLoading(false)
      }
    })()
  }, [])

  /** 塞壬歌曲 → queue-upsert 载荷（songId=0，cid 存 sourceId，vip 恒 false） */
  const sirenSongToUpsert = useCallback(
    (song: SirenSong): QueueUpsertItem => ({
      songId: 0,
      source: 'siren',
      sourceId: song.cid,
      name: song.name,
      artist: (song.artists ?? [])
        .map((a) => a.name)
        .filter(Boolean)
        .join(' / '),
      album: openAlbum?.name ?? '',
      cover: openAlbum?.cover ?? '',
      durationMs: Math.round((song.duration ?? 0) * 1000),
      vip: false,
    }),
    [openAlbum]
  )

  // ===== 专辑详情视图 =====
  if (openAlbum) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        {/* 返回按钮 + 专辑标题 */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
            onClick={() => setOpenAlbum(null)}
            title="返回专辑列表"
            aria-label="返回专辑列表"
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
            MONSTER SIREN
          </span>
          <span className="truncate text-xl font-bold text-[var(--md-sys-color-on-surface)]">
            {openAlbum.name}
          </span>
        </div>

        {/* 专辑头：封面 + 简介 */}
        <div className="mt-6 flex flex-wrap items-start gap-6">
          <img
            src={openAlbum.cover}
            alt={openAlbum.name}
            className="h-40 w-40 shrink-0 object-cover"
            style={{
              border:
                '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
            }}
            draggable={false}
          />
          <div className="min-w-0 flex-1">
            {openAlbum.intro && (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--md-sys-color-on-surface-variant)]">
                {openAlbum.intro}
              </p>
            )}
            <p className="mt-2 text-xs text-[var(--md-sys-color-on-surface-variant)] opacity-80">
              共 {openSongs.length} 首
            </p>
          </div>
        </div>

        {/* 歌曲列表 */}
        <div className="mt-6 flex min-h-[240px] flex-1 flex-col">
          {openLoading && (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在获取专辑歌曲…
            </div>
          )}
          {!openLoading && openSongs.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
              专辑暂无歌曲
            </div>
          )}
          {openSongs.map((song, idx) => {
            const key = `siren:${song.cid}`
            const added = addedKeys.has(key)
            return (
              <SongRow
                key={song.cid}
                index={idx + 1}
                name={song.name}
                artist={(song.artists ?? [])
                  .map((a) => a.name)
                  .filter(Boolean)
                  .join(' / ')}
                duration={formatSirenDuration(song.duration)}
                hoverAction={
                  added ? (
                    <Check className="h-[18px] w-[18px] text-[var(--md-sys-color-primary)]" />
                  ) : (
                    <Plus className="h-[18px] w-[18px]" />
                  )
                }
                hoverActionLabel={added ? '已添加' : '添加到队列'}
                onHoverAction={() => add(sirenSongToUpsert(song))}
              />
            )
          })}
        </div>
      </div>
    )
  }

  // ===== 专辑网格视图 =====
  return (
    <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
      <PageBlockHeader titleEN="MONSTER SIREN" titleCN="塞壬唱片" />
      <span className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
        Monster Siren 官方音源专区
      </span>

      <div className="mt-4 min-h-[200px] flex-1">
        {albumsLoading && (
          <div className="flex items-center gap-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在获取专辑列表…
          </div>
        )}
        {!albumsLoading && albums.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
            <Disc3
              className="h-7 w-7 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
            <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
              暂无专辑，请稍后重试
            </span>
          </div>
        )}
        <div className="grid grid-cols-3 gap-x-10 gap-y-8 md:grid-cols-4 xl:grid-cols-5">
          {albums.map((album) => (
            <button
              key={album.cid}
              type="button"
              className="min-w-0 text-left"
              onClick={() => handleOpenAlbum(album)}
              title={`打开专辑「${album.name}」`}
            >
              <div
                className={cn(
                  'overflow-hidden transition-shadow duration-200',
                  'hover:shadow-[0_0_10px_1px_color-mix(in_srgb,black_10%,transparent)]'
                )}
              >
                {album.cover ? (
                  <img
                    src={album.cover}
                    alt={album.name}
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
                    <Disc3
                      className="h-6 w-6 opacity-40"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    />
                  </div>
                )}
              </div>
              <div className="mt-1.5 line-clamp-2 break-all text-sm font-bold leading-snug text-[var(--md-sys-color-on-surface)]">
                {album.name}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
