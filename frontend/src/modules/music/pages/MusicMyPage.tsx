/**
 * 我的音乐页（Hydrogen MyMusic 1:1 复刻）。
 *
 * 布局（Hydrogen .my-music 骨架）：左侧栏 262px + 右侧内容区（间距 50px）。
 *
 * 左侧栏（Hydrogen LibraryType/LibraryList 复刻）：
 * - 双层 Tab（高 50px）：一级 4 项「歌单 / 收藏 / 下载管理 / 本地管理」，
 *   16px 加粗字，激活变黑 + 文字下方 3px 黑色条（width 展开动画），
 *   底部 0.5px 细分隔线；二级子 Tab 12px 随一级切换
 * - 列表条目：50px 方图（0.5px 边框）+ 15px 名称 + 11px 副信息，
 *   padding 8px；hover/选中为「背景层从左滑入」动画
 *   （translateX(-100%)→0，1s cubic-bezier(0.22,0.61,0.36,1)，hover 延迟 0.2s）
 * - 数据：歌单 = /user/playlist（按 /user/subcount 的创建/收藏数量切两段，
 *   「我喜欢的音乐」= specialType===5，其 trackCount 用 /likelist 长度覆盖）；
 *   收藏 = /album/sublist、/artist/sublist、/mv/sublist、/dj/sublist
 * - 下载管理 / 本地管理：Hydrogen 依赖 Electron IPC（下载队列 / 目录扫描），
 *   ZViewer 为 Web 环境，复刻 Tab 框架并显示空态提示
 *
 * 右侧内容区：详情视图（歌单 / 专辑 / 歌手 → 返回栏 + 封面标签 + SongRow
 * 列表，可加入队列）或 Hydrogen 空态（NONE + 对角线 + 四角方块装饰）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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

/** 一级 Tab（Hydrogen type-one） */
const TYPE_ONE = ['歌单', '收藏', '下载管理', '本地管理'] as const

/** 二级子 Tab（Hydrogen type-two，随一级切换） */
const TYPE_TWO: Record<number, string[]> = {
  0: ['我创建的', '我收藏的'],
  1: ['专辑', '歌手', 'MV', '电台'],
  2: ['正在下载', '下载完成'],
  3: ['全部', '专辑', '歌手'],
}

/** 网易云 CDN 图片：http 升级 https + 尺寸参数 */
function cdnImg(url: string | undefined, size = 128): string {
  if (!url) return ''
  const https = url.replace('http://', 'https://')
  return `${https}?param=${size}y${size}`
}

/** /user/playlist 条目 */
interface UserPlaylistItem {
  id: number
  name: string
  coverImgUrl?: string
  trackCount?: number
  specialType?: number
  creator?: { nickname?: string }
}

/** 收藏专辑条目（/album/sublist） */
interface SubAlbumItem {
  id: number
  name: string
  picUrl?: string
  artists?: Array<{ name?: string }>
}

/** 收藏歌手条目（/artist/sublist） */
interface SubArtistItem {
  id: number
  name: string
  img1v1Url?: string
  picUrl?: string
  size?: number
  alias?: string[]
}

/** 收藏 MV 条目（/mv/sublist） */
interface SubMvItem {
  id: number
  name: string
  coverUrl?: string
  picUrl?: string
  durationMs?: number
  artists?: Array<{ name?: string }>
  creator?: Array<{ userName?: string }>
}

/** 收藏电台条目（/dj/sublist） */
interface SubRadioItem {
  id: number
  name: string
  picUrl?: string
  programCount?: number
  dj?: { nickname?: string }
}

/** /playlist/track/all、/album、/artists 的歌曲条目（cloudsearch 同构） */
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

/** 右侧详情状态（歌单 / 专辑 / 歌手） */
interface DetailState {
  kind: 'playlist' | 'album' | 'artist'
  id: number
  name: string
  cover?: string
  /** 副信息（如「N 首」或歌手别名） */
  info?: string
}

export function MusicMyPage({ socket, roomId, canManage }: MusicMyPageProps) {
  const loginStatus = useMusicStore((s) => s.loginStatus)

  // ===== 左侧栏状态机（Hydrogen listType1/listType2） =====
  const [listType1, setListType1] = useState(0)
  const [listType2, setListType2] = useState(0)

  // ===== 歌单数据（登录后拉取；按创建/收藏数量切两段） =====
  const [createdPlaylists, setCreatedPlaylists] = useState<UserPlaylistItem[]>(
    []
  )
  const [subscribedPlaylists, setSubscribedPlaylists] = useState<
    UserPlaylistItem[]
  >([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)

  // ===== 收藏数据（切到收藏 Tab 时按需拉取并缓存） =====
  const [subAlbums, setSubAlbums] = useState<SubAlbumItem[]>([])
  const [subArtists, setSubArtists] = useState<SubArtistItem[]>([])
  const [subMvs, setSubMvs] = useState<SubMvItem[]>([])
  const [subRadios, setSubRadios] = useState<SubRadioItem[]>([])
  const [subLoading, setSubLoading] = useState(false)
  const subLoadedRef = useRef(false)

  // ===== 右侧详情 =====
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [detailSongs, setDetailSongs] = useState<NcmSong[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  // ===== 歌单详情分页缓加载（首次 50 首，滚动到底部继续加载） =====
  /** 是否还有更多分页（歌单详情用） */
  const [detailHasMore, setDetailHasMore] = useState(false)
  /** 追加分页加载中 */
  const [detailLoadingMore, setDetailLoadingMore] = useState(false)
  /** 追加加载防重入（IntersectionObserver 可能多次触发） */
  const loadingMoreRef = useRef(false)
  /** 滚动到底部的哨兵元素（进入视口即触发下一页） */
  const sentinelRef = useRef<HTMLDivElement>(null)

  const { addedKeys, add } = useQueueAdd(socket, roomId, canManage)

  // 登录后：/user/account 拿 uid → /user/playlist + /user/subcount + /likelist
  useEffect(() => {
    if (!loginStatus.loggedIn) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求，loading 置位与请求同步发起
    setPlaylistsLoading(true)
    void (async () => {
      try {
        const acc = await apiGet<{
          profile?: { userId?: number; nickname?: string }
        }>('/api/music/ncm/user/account')
        const uid = acc.data?.profile?.userId
        if (!uid) throw new Error('获取网易云账号失败')
        // 并行：歌单列表 / 创建与收藏数量 / 红心列表（同步「我喜欢的音乐」数量）
        const [pl, sub, like] = await Promise.all([
          apiGet<{ playlist?: UserPlaylistItem[] }>(
            `/api/music/ncm/user/playlist?uid=${uid}`
          ),
          apiGet<{
            createdPlaylistCount?: number
            subPlaylistCount?: number
          }>('/api/music/ncm/user/subcount'),
          apiGet<{ ids?: number[] }>(
            `/api/music/ncm/likelist?uid=${uid}`
          ).catch(() => ({ data: undefined })),
        ])
        if (cancelled) return
        const all = Array.isArray(pl.data?.playlist) ? pl.data.playlist : []
        // 按顺序切「我创建的 / 我收藏的」两段（Hydrogen libraryStore 同策略）
        const createdCount = sub.data?.createdPlaylistCount ?? all.length
        const created = all.slice(0, createdCount)
        const subscribed = all.slice(createdCount)
        // 「我喜欢的音乐」（specialType===5 或同名）：trackCount 用红心列表长度覆盖
        const likeCount = Array.isArray(like.data?.ids)
          ? like.data.ids.length
          : null
        const markFavorite = (list: UserPlaylistItem[]) =>
          list.map((item) =>
            likeCount != null &&
            (item.specialType === 5 || item.name === '我喜欢的音乐')
              ? { ...item, trackCount: likeCount }
              : item
          )
        setCreatedPlaylists(markFavorite(created))
        setSubscribedPlaylists(markFavorite(subscribed))
      } catch (err) {
        console.error('[MusicMyPage] 我的音乐获取失败:', err)
        if (!cancelled) {
          message.error('我的音乐获取失败，请稍后重试')
        }
      } finally {
        if (!cancelled) setPlaylistsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loginStatus.loggedIn])

  /** 切一级 Tab：重置二级并按需加载收藏数据（Hydrogen changeTracker） */
  const handleType1 = useCallback((type: number) => {
    setListType1(type)
    setListType2(0)
    if (type === 1 && !subLoadedRef.current) {
      subLoadedRef.current = true
      setSubLoading(true)
      void (async () => {
        try {
          const [albums, artists, mvs, radios] = await Promise.all([
            apiGet<{ data?: { data?: SubAlbumItem[] } }>(
              '/api/music/ncm/album/sublist?limit=100'
            ).catch(() => ({ data: undefined })),
            apiGet<{ data?: SubArtistItem[] }>(
              '/api/music/ncm/artist/sublist'
            ).catch(() => ({ data: undefined })),
            apiGet<{ data?: SubMvItem[] }>('/api/music/ncm/mv/sublist').catch(
              () => ({ data: undefined })
            ),
            apiGet<{ djRadios?: SubRadioItem[] }>(
              '/api/music/ncm/dj/sublist?limit=50'
            ).catch(() => ({ data: undefined })),
          ])
          setSubAlbums(
            Array.isArray(albums.data?.data?.data) ? albums.data.data.data : []
          )
          setSubArtists(
            Array.isArray(artists.data?.data) ? artists.data.data : []
          )
          setSubMvs(Array.isArray(mvs.data?.data) ? mvs.data.data : [])
          setSubRadios(
            Array.isArray(radios.data?.djRadios) ? radios.data.djRadios : []
          )
        } catch (err) {
          console.error('[MusicMyPage] 收藏列表获取失败:', err)
        } finally {
          setSubLoading(false)
        }
      })()
    }
  }, [])

  /** 打开详情（歌单 / 专辑 / 歌手）：按 kind 拉对应接口的歌曲列表。
   *  歌单首次只取 50 首（offset=0），剩余由滚动到底部触发追加加载 */
  const loadDetail = useCallback((d: DetailState) => {
    setDetail(d)
    setDetailSongs([])
    setDetailLoading(true)
    setDetailHasMore(false)
    setDetailLoadingMore(false)
    loadingMoreRef.current = false
    void (async () => {
      try {
        if (d.kind === 'playlist') {
          const { data } = await apiGet<{
            songs?: PlaylistTrackItem[]
            total?: number
          }>(`/api/music/ncm/playlist/track/all?id=${d.id}&limit=50&offset=0`)
          if (!Array.isArray(data?.songs)) throw new Error('歌单详情获取失败')
          const songs = data.songs.map(mapTrack).filter((s) => s.songId > 0)
          setDetailSongs(songs)
          // total 是原始曲目总数（未过滤前 songs 长度与之一致），与已加载数
          // 比较决定是否还有下一页
          const total = Number.isFinite(data?.total) ? (data?.total ?? 0) : 0
          setDetailHasMore(total > songs.length && songs.length > 0)
        } else if (d.kind === 'album') {
          const { data } = await apiGet<{
            album?: { name?: string; picUrl?: string }
            songs?: PlaylistTrackItem[]
          }>(`/api/music/ncm/album?id=${d.id}`)
          if (!Array.isArray(data?.songs)) throw new Error('专辑详情获取失败')
          setDetailSongs(data.songs.map(mapTrack).filter((s) => s.songId > 0))
        } else {
          const { data } = await apiGet<{
            artist?: { name?: string; img1v1Url?: string; alias?: string[] }
            hotSongs?: PlaylistTrackItem[]
          }>(`/api/music/ncm/artists?id=${d.id}`)
          if (!Array.isArray(data?.hotSongs))
            throw new Error('歌手热门单曲获取失败')
          setDetailSongs(
            data.hotSongs.map(mapTrack).filter((s) => s.songId > 0)
          )
        }
      } catch (err) {
        console.error('[MusicMyPage] 详情获取失败:', err)
        message.error('详情获取失败，请稍后重试')
      } finally {
        setDetailLoading(false)
      }
    })()
  }, [])

  /** 关闭详情回到空态 */
  const closeDetail = useCallback(() => {
    setDetail(null)
    setDetailSongs([])
    setDetailHasMore(false)
    setDetailLoadingMore(false)
    loadingMoreRef.current = false
  }, [])

  /** 滚动到底部：追加加载歌单下一页（每页 50 首） */
  const loadMoreDetail = useCallback(async () => {
    const d = detail
    if (!d || d.kind !== 'playlist' || !detailHasMore || loadingMoreRef.current)
      return
    loadingMoreRef.current = true
    setDetailLoadingMore(true)
    try {
      const offset = detailSongs.length
      const { data } = await apiGet<{
        songs?: PlaylistTrackItem[]
        total?: number
      }>(
        `/api/music/ncm/playlist/track/all?id=${d.id}&limit=50&offset=${offset}`
      )
      if (!Array.isArray(data?.songs)) throw new Error('歌单详情追加加载失败')
      const next = data.songs.map(mapTrack).filter((s) => s.songId > 0)
      setDetailSongs((prev) => [...prev, ...next])
      const total = Number.isFinite(data?.total) ? (data?.total ?? 0) : 0
      // 已加载（原始顺序）达到 total 或本页为空时停止
      setDetailHasMore(offset + next.length < total && next.length > 0)
    } catch (err) {
      console.error('[MusicMyPage] 歌单追加加载失败:', err)
      message.error('加载更多歌曲失败，请稍后重试')
    } finally {
      loadingMoreRef.current = false
      setDetailLoadingMore(false)
    }
  }, [detail, detailHasMore, detailSongs.length])

  // 哨兵进入视口（接近列表底部）→ 追加下一页
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !detailHasMore) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreDetail()
      },
      { rootMargin: '400px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [detailHasMore, loadMoreDetail])

  if (!loginStatus.loggedIn) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        <PageBlockHeader titleEN="MY MUSIC" titleCN="我的音乐" />
        <MusicLoginGate hint="登录后查看我的歌单" />
      </div>
    )
  }

  // ===== 详情视图（右侧内容区） =====
  const detailView = detail ? (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 返回按钮 + 类型标签 + 封面 + 名称 + 副信息 */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
          onClick={closeDetail}
          title="返回"
          aria-label="返回"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span
          className="shrink-0 py-px pl-1 pr-8 text-[10px] font-bold uppercase tracking-widest"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            color: 'var(--md-sys-color-surface)',
          }}
        >
          {detail.kind === 'playlist'
            ? 'PLAYLIST'
            : detail.kind === 'album'
              ? 'ALBUM'
              : 'ARTIST'}
        </span>
        {detail.cover && (
          <img
            src={detail.cover}
            alt={detail.name}
            className="h-12 w-12 shrink-0 object-cover"
            style={{
              border:
                '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
            }}
            draggable={false}
          />
        )}
        <span className="truncate text-xl font-bold text-[var(--md-sys-color-on-surface)]">
          {detail.name}
        </span>
        <span className="shrink-0 text-xs text-[var(--md-sys-color-on-surface-variant)]">
          {detail.info ?? `${detailSongs.length} 首`}
        </span>
      </div>

      <div className="mt-4 flex min-h-[240px] flex-1 flex-col">
        {detailLoading && (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在获取歌曲…
          </div>
        )}
        {!detailLoading && detailSongs.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
            暂无歌曲
          </div>
        )}
        {detailSongs.map((song, idx) => {
          const added = addedKeys.has(`ncm:${song.songId}`)
          return (
            <SongRow
              key={song.songId}
              index={idx + 1}
              cover={song.cover}
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
        {/* 分页缓加载哨兵：滚动到底部（接近 400px 内）自动追加下一页 */}
        {detailHasMore && (
          <div
            ref={sentinelRef}
            className="flex h-12 items-center justify-center gap-2 text-xs text-[var(--md-sys-color-on-surface-variant)]"
          >
            {detailLoadingMore ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在加载更多歌曲…
              </>
            ) : (
              <span>继续下滑加载更多</span>
            )}
          </div>
        )}
      </div>
    </div>
  ) : (
    /* ===== 默认空态（Hydrogen NONE：对角线 + 闪烁文字 + 四角方块） ===== */
    <MyMusicEmpty />
  )

  // ===== 页面骨架：左侧栏 262px + 右侧内容区（间距 50px） =====
  return (
    <div className="flex min-h-full px-6 pb-32 pt-6 md:px-8">
      {/* ===== 左侧栏（Hydrogen .music-library：宽 262px） ===== */}
      <div className="flex w-[262px] max-w-[450px] shrink-0 flex-col self-start md:sticky md:top-16 md:max-h-[calc(100vh-96px)]">
        {/* 双层 Tab（Hydrogen LibraryType：一级 16px 加粗 + 3px 黑色激活条 +
            0.5px 细分隔线；二级 12px 随一级切换） */}
        <div className="shrink-0 pt-2.5">
          <div className="flex items-end gap-5 px-1 pb-1 text-base font-bold leading-none">
            {TYPE_ONE.map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => handleType1(i)}
                className={cn(
                  'relative whitespace-nowrap pb-1.5 transition-colors duration-200',
                  listType1 === i
                    ? 'text-[var(--md-sys-color-on-surface)]'
                    : 'text-[var(--md-sys-color-on-surface-variant)]'
                )}
              >
                {label}
                {/* 激活黑色条（3px，width 展开动画，贴分隔线上方） */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute inset-x-0 bottom-0 h-[3px] transition-all duration-300',
                    listType1 === i ? 'w-full opacity-100' : 'w-0 opacity-0'
                  )}
                  style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
                />
              </button>
            ))}
          </div>
          {/* 0.5px 细分隔线（Hydrogen tracker-line） */}
          <div
            className="h-px w-full"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 35%, transparent)',
            }}
          />
          {/* 二级子 Tab */}
          <div className="mt-1 flex items-center gap-2.5 px-1 text-xs font-bold">
            {(TYPE_TWO[listType1] ?? []).map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => setListType2(i)}
                className={cn(
                  'whitespace-nowrap transition-colors duration-200',
                  listType2 === i
                    ? 'text-[var(--md-sys-color-on-surface)]'
                    : 'text-[var(--md-sys-color-on-surface-variant)]'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 列表区（height: calc(100% - 50px)，滚动） */}
        <div className="zen-scroll mt-1 min-h-0 flex-1 overflow-y-auto pt-1">
          {/* ===== 歌单（我创建的 / 我收藏的） ===== */}
          {listType1 === 0 &&
            (playlistsLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在获取…
              </div>
            ) : (listType2 === 0 ? createdPlaylists : subscribedPlaylists)
                .length === 0 ? (
              <LibraryEmptyHint
                text={listType2 === 0 ? '暂无创建的歌单' : '暂无收藏的歌单'}
              />
            ) : (
              (listType2 === 0 ? createdPlaylists : subscribedPlaylists).map(
                (pl) => (
                  <LibraryItem
                    key={pl.id}
                    selected={
                      detail?.kind === 'playlist' && detail.id === pl.id
                    }
                    img={cdnImg(pl.coverImgUrl)}
                    name={pl.name}
                    info={`${pl.trackCount ?? 0} 首`}
                    onClick={() =>
                      loadDetail({
                        kind: 'playlist',
                        id: pl.id,
                        name: pl.name,
                        cover: cdnImg(pl.coverImgUrl, 300),
                        info: `${pl.trackCount ?? 0} 首`,
                      })
                    }
                  />
                )
              )
            ))}

          {/* ===== 收藏（专辑 / 歌手 / MV / 电台） ===== */}
          {listType1 === 1 &&
            (subLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在获取…
              </div>
            ) : listType2 === 0 ? (
              subAlbums.length === 0 ? (
                <LibraryEmptyHint text="暂无收藏的专辑" />
              ) : (
                subAlbums.map((a) => (
                  <LibraryItem
                    key={a.id}
                    selected={detail?.kind === 'album' && detail.id === a.id}
                    img={cdnImg(a.picUrl)}
                    name={a.name}
                    info={(a.artists ?? [])
                      .map((x) => x.name)
                      .filter(Boolean)
                      .join(' / ')}
                    onClick={() =>
                      loadDetail({
                        kind: 'album',
                        id: a.id,
                        name: a.name,
                        cover: cdnImg(a.picUrl, 300),
                      })
                    }
                  />
                ))
              )
            ) : listType2 === 1 ? (
              subArtists.length === 0 ? (
                <LibraryEmptyHint text="暂无收藏的歌手" />
              ) : (
                subArtists.map((a) => (
                  <LibraryItem
                    key={a.id}
                    selected={detail?.kind === 'artist' && detail.id === a.id}
                    img={cdnImg(a.img1v1Url ?? a.picUrl)}
                    name={a.name}
                    info={
                      a.alias?.filter(Boolean).join(' / ') ||
                      `${a.size ?? 0} 首`
                    }
                    onClick={() =>
                      loadDetail({
                        kind: 'artist',
                        id: a.id,
                        name: a.name,
                        cover: cdnImg(a.img1v1Url ?? a.picUrl, 300),
                      })
                    }
                  />
                ))
              )
            ) : listType2 === 2 ? (
              subMvs.length === 0 ? (
                <LibraryEmptyHint text="暂无收藏的 MV" />
              ) : (
                subMvs.map((m) => (
                  <LibraryItem
                    key={m.id}
                    selected={false}
                    img={cdnImg(m.coverUrl ?? m.picUrl)}
                    name={m.name}
                    info={
                      (
                        (m.artists ?? m.creator ?? []) as Array<{
                          name?: string
                          userName?: string
                        }>
                      )
                        .map((x) => x.name ?? x.userName)
                        .filter(Boolean)
                        .join(' / ') || 'MV'
                    }
                    onClick={() => {
                      // Web 环境暂不支持 MV 播放
                      message.info('ZViewer 暂不支持播放 MV')
                    }}
                  />
                ))
              )
            ) : subRadios.length === 0 ? (
              <LibraryEmptyHint text="暂无收藏的电台" />
            ) : (
              subRadios.map((r) => (
                <LibraryItem
                  key={r.id}
                  selected={false}
                  img={cdnImg(r.picUrl)}
                  name={r.name}
                  info={
                    [
                      r.dj?.nickname,
                      r.programCount != null ? `${r.programCount} 期` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ') || '电台'
                  }
                  onClick={() => {
                    // 电台详情暂未接入
                    message.info('电台详情暂未接入')
                  }}
                />
              ))
            ))}

          {/* ===== 下载管理（Web 环境不支持 Electron 下载队列） ===== */}
          {listType1 === 2 && <MyMusicUnsupported type2={listType2} />}

          {/* ===== 本地管理（Web 环境不支持本地目录扫描） ===== */}
          {listType1 === 3 && <MyMusicUnsupported type2={listType2} />}
        </div>
      </div>

      {/* ===== 右侧内容区（Hydrogen .library-view：margin-left 50px） ===== */}
      <div className="ml-[50px] flex min-h-0 min-w-0 flex-1 flex-col">
        {detailView}
      </div>
    </div>
  )
}

/** 左侧栏空提示（歌单/收藏无数据时） */
function LibraryEmptyHint({ text }: { text: string }) {
  return (
    <div className="px-2 py-6 text-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
      {text}
    </div>
  )
}

/** 左侧栏列表条目（Hydrogen LibraryList .list-item 复刻）：
 * 50px 方图 + 名称 + 副信息；hover/选中为「背景从左滑入」动画 */
function LibraryItem({
  img,
  name,
  info,
  selected,
  onClick,
}: {
  img: string
  name: string
  info?: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className="group relative flex cursor-pointer items-center overflow-hidden p-2"
      aria-selected={selected}
    >
      {/* 滑入背景层（hover 延迟 0.2s，1s cubic-bezier(0.22,0.61,0.36,1)；选中常驻） */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-0 -translate-x-full bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)] transition-transform duration-1000 ease-[cubic-bezier(0.22,0.61,0.36,1)] group-hover:translate-x-0 group-hover:delay-200',
          selected && 'translate-x-0'
        )}
      />
      {img ? (
        <img
          src={img}
          alt=""
          className="relative mr-2.5 h-[50px] w-[50px] shrink-0 object-cover"
          style={{
            border:
              '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
          }}
          draggable={false}
          loading="lazy"
        />
      ) : (
        <div
          className="relative mr-2.5 flex h-[50px] w-[50px] shrink-0 items-center justify-center"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
            border:
              '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
          }}
        >
          <ListMusic
            className="h-5 w-5 opacity-40"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          />
        </div>
      )}
      <div className="relative min-w-0 flex-1">
        <p className="truncate text-[15px] font-bold leading-snug text-[var(--md-sys-color-on-surface)]">
          {name}
        </p>
        {info && (
          <p className="truncate text-[11px] font-bold leading-snug text-[var(--md-sys-color-on-surface-variant)]">
            {info}
          </p>
        )}
      </div>
    </div>
  )
}

/** 右侧默认空态（Hydrogen MyMusic .library-container 空态：
 * 四角方形边框 + 对角线展开 + "NONE" 闪烁文字） */
function MyMusicEmpty() {
  return (
    <div className="flex min-h-[320px] flex-1 flex-col items-center justify-center gap-4">
      <div
        className="relative flex h-44 w-80 items-center justify-center"
        style={{
          border:
            '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent)',
        }}
      >
        {/* 四角小方块（Hydrogen .no-corner：9px 实心） */}
        <span
          className="absolute -left-[4.5px] -top-[4.5px] h-[9px] w-[9px]"
          style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        <span
          className="absolute -right-[4.5px] -top-[4.5px] h-[9px] w-[9px]"
          style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        <span
          className="absolute -bottom-[4.5px] -right-[4.5px] h-[9px] w-[9px]"
          style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        <span
          className="absolute -bottom-[4.5px] -left-[4.5px] h-[9px] w-[9px]"
          style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        {/* 对角线展开（复用 Lyric-Area keyframes） */}
        <div
          className="lyric-nodata-grow absolute inset-8"
          style={{
            background:
              'linear-gradient(to top right, transparent calc(50% - 0.6px), var(--md-sys-color-on-surface), transparent calc(50% + 0.6px))',
          }}
          aria-hidden="true"
        />
        <span
          className="lyric-nodata-tip relative text-base font-bold tracking-widest text-[var(--md-sys-color-on-surface)]"
          style={{ color: 'var(--md-sys-color-on-surface)' }}
        >
          NONE
        </span>
      </div>
      <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
        从左侧选择歌单 / 专辑 / 歌手查看详情
      </p>
    </div>
  )
}

/** 下载管理 / 本地管理空态（Hydrogen 依赖 Electron IPC，Web 环境提示） */
function MyMusicUnsupported({ type2 }: { type2: number }) {
  const isDownload = type2 === 0
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <ListMusic
        className="h-6 w-6 opacity-40"
        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
      />
      <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
        {isDownload
          ? '下载管理依赖桌面端下载队列，ZViewer Web 环境暂不支持'
          : '本地音乐管理依赖桌面端目录扫描，ZViewer Web 环境暂不支持'}
      </p>
    </div>
  )
}
