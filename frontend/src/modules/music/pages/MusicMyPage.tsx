/**
 * 我的音乐页（Hydrogen MyMusic + LibraryDetail 1:1 复刻）。
 *
 * 布局架构（Hydrogen 同款「页面不滚、分区内部滚动」——左栏抖动根修）：
 * 页面根 h-full 填满 main 可用高度（main 自带 pb-[118px] 底部让位），
 * 左栏与右区各自 flex-1 min-h-0 内部滚动。旧版「整页滚动 + 左栏 sticky
 * 追随」会因 sticky 阈值（top-16）与初始位置（pt-6=24px）不匹配，滚动
 * 经过阈值瞬间左栏从流内位置跳到吸附位置产生抖动；内滚架构下页面永不
 * 滚动，左栏完全静态。
 *
 * 左侧栏（Hydrogen LibraryType/LibraryList 复刻）：
 * - 双层 Tab（高 50px）：一级 4 项「歌单 / 收藏 / 下载管理 / 本地管理」，
 *   16px 加粗字，激活变黑 + 文字下方 3px 黑色条（width 展开动画），
 *   底部 0.5px 细分隔线；二级子 Tab 12px 随一级切换
 * - 列表条目：50px 方图（0.5px 边框）+ 15px 名称 + 11px 副信息，
 *   padding 8px；hover/选中为「背景层从左滑入」动画
 *   （translateX(-100%)→0，1s cubic-bezier(0.22,0.61,0.36,1)，hover 延迟
 *   0.2s；背景层 will-change 合成层化，避免大面积重绘卡顿）
 * - 数据：歌单 = /user/playlist（按 /user/subcount 的创建/收藏数量切两段）；
 *   收藏 = /album/sublist、/artist/sublist、/mv/sublist、/dj/sublist；
 *   下载管理 / 本地管理为 Web 环境空态提示
 *
 * 右侧内容区（Hydrogen LibraryDetail 1:1）：
 * - 前进/后退双箭头（32px，实心 chevron，无历史 opacity-45）
 * - 歌单头：150px 大封面（0.5px 边框 + 弥散阴影）+ 右侧信息列
 *   （名称 22px 加粗两行截断 / 创建者 12px / 「共N首 - M分钟」11px）
 * - 右上角列（130px）：创建时间描边框（10px）+ 「查看详情」黑底白字按钮
 *   （点击弹出 700×400 毛玻璃描述面板，metro 先宽后高展开动画 + 四角
 *   白点闪烁）+ SEARCH 歌曲过滤框
 * - 「播放全部」分隔行：描边三角 + 12px 文字 + 0.5px 延伸线 + PLAYALL 小字
 * - 歌曲列表：SongRow（歌名前 40px 封面缩略图，与搜索/每日推荐/云盘页
 *   一致传 cover，网易云 CDN 80x80 裁剪），歌单分页缓加载（首次 50 首，
 *   滚动到底追加）；容器 scrollbar-gutter stable 保持宽度稳定
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2, Plus, ListMusic, Search } from 'lucide-react'
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

/** 详情弹窗 metro 展开动画 + 四角白点闪烁（Hydrogen introduce-detail 同款） */
const INTRODUCE_STYLE = `
@keyframes zen-introduce-in {
  0% { width: 0; height: 0; padding: 0; }
  50% { width: 700px; height: 0; padding: 0 60px; }
  100% { width: 700px; height: 400px; padding: 30px 60px; }
}
@keyframes zen-introduce-corner {
  0% { opacity: 0; }
  10% { opacity: 1; }
  20% { opacity: 0; }
  30% { opacity: 1; }
  40% { opacity: 0; }
  50% { opacity: 1; }
  60% { opacity: 0; }
  70% { opacity: 1; }
  80% { opacity: 0; }
  90% { opacity: 0; }
  100% { opacity: 1; }
}
@keyframes zen-introduce-close {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
`

/** 网易云 CDN 图片：http 升级 https + 尺寸参数 */
function cdnImg(url: string | undefined, size = 128): string {
  if (!url) return ''
  const https = url.replace('http://', 'https://')
  return `${https}?param=${size}y${size}`
}

/** 毫秒时间戳 → YYYY-MM-DD */
function formatDate(ts: number | undefined): string {
  if (!Number.isFinite(ts) || !ts) return ''
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
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

/** 详情元信息（歌单 /album/artist 响应中的附加展示数据） */
interface DetailMeta {
  /** 右上时间标签（「创建时间 2020-08-12」/「发行时间 …」） */
  timeLabel?: string
  /** 数量行覆盖文本（歌手页「N首歌 · M张专辑 · K个MV」） */
  numText?: string
  /** 创建者 / 歌手别名行 */
  creator?: string
  /** 查看详情弹窗的描述文本 */
  description?: string
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
  const [detailMeta, setDetailMeta] = useState<DetailMeta | null>(null)
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
  /** 右侧歌曲列表滚动容器（切详情时归零） */
  const listScrollRef = useRef<HTMLDivElement>(null)

  // ===== 详情历史导航（Hydrogen view-control 前进/后退） =====
  const [history, setHistory] = useState<{
    list: DetailState[]
    index: number
  }>({ list: [], index: -1 })

  // ===== 歌曲过滤（Hydrogen SongFilterInput SEARCH 框） =====
  const [filterKeyword, setFilterKeyword] = useState('')

  // ===== 查看详情弹窗 =====
  const [introOpen, setIntroOpen] = useState(false)

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

  /** 加载详情（歌曲列表 + 元信息）；分页歌单首次只取 50 首 */
  const loadDetail = useCallback((d: DetailState) => {
    setDetail(d)
    setDetailMeta(null)
    setDetailSongs([])
    setDetailLoading(true)
    setDetailHasMore(false)
    setDetailLoadingMore(false)
    setFilterKeyword('')
    setIntroOpen(false)
    loadingMoreRef.current = false
    void (async () => {
      try {
        if (d.kind === 'playlist') {
          const [trackRes, infoRes] = await Promise.all([
            apiGet<{
              songs?: PlaylistTrackItem[]
              total?: number
            }>(
              `/api/music/ncm/playlist/track/all?id=${d.id}&limit=50&offset=0`
            ),
            apiGet<{
              playlist?: {
                createTime?: number
                creator?: { nickname?: string }
                description?: string
              }
            }>(`/api/music/ncm/playlist/detail?id=${d.id}`).catch(() => ({
              data: undefined,
            })),
          ])
          if (!Array.isArray(trackRes.data?.songs))
            throw new Error('歌单详情获取失败')
          const songs = trackRes.data.songs
            .map(mapTrack)
            .filter((s) => s.songId > 0)
          setDetailSongs(songs)
          // total 是原始曲目总数（未过滤前 songs 长度与之一致），与已加载数
          // 比较决定是否还有下一页
          const total = Number.isFinite(trackRes.data?.total)
            ? (trackRes.data?.total ?? 0)
            : 0
          setDetailHasMore(total > songs.length && songs.length > 0)
          const pl = infoRes.data?.playlist
          setDetailMeta({
            timeLabel: pl?.createTime ? formatDate(pl.createTime) : undefined,
            creator: pl?.creator?.nickname,
            description: pl?.description,
          })
        } else if (d.kind === 'album') {
          const { data } = await apiGet<{
            album?: {
              name?: string
              picUrl?: string
              publishTime?: number
              description?: string
              artists?: Array<{ name?: string }>
            }
            songs?: PlaylistTrackItem[]
          }>(`/api/music/ncm/album?id=${d.id}`)
          if (!Array.isArray(data?.songs)) throw new Error('专辑详情获取失败')
          setDetailSongs(data.songs.map(mapTrack).filter((s) => s.songId > 0))
          const alb = data?.album
          setDetailMeta({
            timeLabel: alb?.publishTime
              ? formatDate(alb.publishTime)
              : undefined,
            creator: (alb?.artists ?? [])
              .map((a) => a.name)
              .filter(Boolean)
              .join(' / '),
            description: alb?.description,
          })
        } else {
          const { data } = await apiGet<{
            artist?: {
              name?: string
              img1v1Url?: string
              alias?: string[]
              musicSize?: number
              albumSize?: number
              mvSize?: number
              briefDesc?: string
            }
            hotSongs?: PlaylistTrackItem[]
          }>(`/api/music/ncm/artists?id=${d.id}`)
          if (!Array.isArray(data?.hotSongs))
            throw new Error('歌手热门单曲获取失败')
          setDetailSongs(
            data.hotSongs.map(mapTrack).filter((s) => s.songId > 0)
          )
          const art = data?.artist
          setDetailMeta({
            creator: (art?.alias ?? []).filter(Boolean).join(' · '),
            numText:
              art != null
                ? `${art.musicSize ?? 0}首歌 · ${art.albumSize ?? 0}张专辑 · ${art.mvSize ?? 0}个MV`
                : undefined,
            description: art?.briefDesc,
          })
        }
      } catch (err) {
        console.error('[MusicMyPage] 详情获取失败:', err)
        message.error('详情获取失败，请稍后重试')
      } finally {
        setDetailLoading(false)
      }
    })()
  }, [])

  /** 用户点击左栏条目打开详情：截断前进分支并压入历史栈 */
  const openDetail = useCallback(
    (d: DetailState) => {
      setHistory((prev) => {
        const list = prev.list.slice(0, prev.index + 1)
        list.push(d)
        return { list, index: list.length - 1 }
      })
      loadDetail(d)
    },
    [loadDetail]
  )

  /** 后退（view-control 左箭头）：加载历史上一条，不压栈 */
  const goBack = useCallback(() => {
    if (history.index <= 0) return
    const index = history.index - 1
    setHistory({ ...history, index })
    loadDetail(history.list[index])
  }, [history, loadDetail])

  /** 前进（view-control 右箭头）：加载历史下一条，不压栈 */
  const goForward = useCallback(() => {
    if (history.index >= history.list.length - 1) return
    const index = history.index + 1
    setHistory({ ...history, index })
    loadDetail(history.list[index])
  }, [history, loadDetail])

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

  // 切详情时右侧歌曲列表归零（Hydrogen RESET_TOP 滚动策略）
  useEffect(() => {
    const el = listScrollRef.current
    if (el) el.scrollTop = 0
  }, [detail?.id])

  /** 全部加入队列（Hydrogen 播放全部的 ZViewer 语义） */
  const handlePlayAll = useCallback(() => {
    if (!canManage) {
      message.info('仅房主 / 房管可添加队列')
      return
    }
    if (detailSongs.length === 0) return
    detailSongs.forEach((s) => add(songToUpsertItem(s)))
    message.success(`已加入 ${detailSongs.length} 首到队列`)
  }, [canManage, detailSongs, add])

  if (!loginStatus.loggedIn) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        <PageBlockHeader titleEN="MY MUSIC" titleCN="我的音乐" />
        <MusicLoginGate hint="登录后查看我的歌单" />
      </div>
    )
  }

  // ===== 歌曲过滤（名称 / 歌手包含关键词；已加载范围内过滤） =====
  const kw = filterKeyword.trim().toLowerCase()
  const filteredSongs =
    kw === ''
      ? detailSongs
      : detailSongs.filter(
          (s) =>
            s.name.toLowerCase().includes(kw) ||
            s.artist.toLowerCase().includes(kw)
        )
  // 已加载歌曲总分钟（Hydrogen totalTime：对已加载 songs 累加取整）
  const totalMinutes = Math.round(
    detailSongs.reduce((sum, s) => sum + s.durationMs, 0) / 60000
  )
  /** 数量行（歌手页用 meta.numText，其余「共N首 - M分钟」） */
  const numText =
    detail?.kind === 'artist'
      ? (detailMeta?.numText ?? detail.info ?? '')
      : `共${detail?.info ?? `${detailSongs.length} 首`} - ${totalMinutes}分钟`

  // ===== 详情视图（右侧内容区，Hydrogen LibraryDetail 1:1） =====
  const detailView = detail ? (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ===== view-control：后退 / 前进双箭头（实心 chevron 32px） ===== */}
      <div className="ml-[-8px] flex h-8 shrink-0 items-center">
        <button
          type="button"
          onClick={goBack}
          disabled={history.index <= 0}
          className="mr-5 flex h-8 w-8 items-center justify-center p-2 text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90 disabled:opacity-45 disabled:hover:opacity-45 disabled:active:scale-100"
          title="后退"
          aria-label="后退"
        >
          <svg viewBox="0 0 1024 1024" className="h-4 w-4" aria-hidden="true">
            <path
              d="M716.608 1010.112L218.88 512.384 717.376 13.888l45.248 45.248-453.248 453.248 452.48 452.48z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={history.index >= history.list.length - 1}
          className="flex h-8 w-8 items-center justify-center p-2 text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90 disabled:opacity-45 disabled:hover:opacity-45 disabled:active:scale-100"
          title="前进"
          aria-label="前进"
        >
          <svg viewBox="0 0 1024 1024" className="h-4 w-4" aria-hidden="true">
            <path
              d="M264.896 1010.112l497.728-497.728L264.128 13.888 218.88 59.136l453.248 453.248-452.48 452.48z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>

      {/* ===== library-introduce：大封面 + 信息列 + 右上角列 ===== */}
      <div className="flex w-full shrink-0 justify-between">
        <div className="flex w-[calc(100%-130px)] min-w-0 items-start">
          {/* 大封面（150px，0.5px 边框 + 弥散阴影） */}
          <div
            className="mr-2.5 h-[150px] w-[150px] shrink-0 overflow-hidden"
            style={{
              border:
                '0.5px solid color-mix(in srgb, var(--md-sys-color-on-surface) 18%, transparent)',
              boxShadow: '0 0 6px 1px rgba(0, 0, 0, 0.03)',
            }}
          >
            {detail.cover && (
              <img
                src={detail.cover}
                alt={detail.name}
                className="h-full w-full object-cover"
                draggable={false}
              />
            )}
          </div>
          {/* 信息列（名称 22px 两行 / 创建者 12px / 数量行 11px / 操作行占位） */}
          <div className="flex min-w-0 flex-1 flex-col items-start justify-around self-stretch py-1">
            <h2
              className="line-clamp-2 w-[90%] break-all text-[22px] font-bold leading-tight text-[var(--md-sys-color-on-surface)]"
              title={detail.name}
            >
              {detail.name}
            </h2>
            <div className="w-full min-w-0">
              {detailMeta?.creator && (
                <div className="truncate text-xs text-[var(--md-sys-color-on-surface)]">
                  {detailMeta.creator}
                </div>
              )}
              <div className="truncate text-[11px] font-bold text-[var(--md-sys-color-on-surface-variant)]">
                {numText}
              </div>
              {/* 操作行占位（Hydrogen 收藏/下载行；ZViewer 仅保留 SEARCH） */}
              <div className="mt-2.5 min-h-[34px] w-full" />
            </div>
          </div>
        </div>

        {/* 右上角列（130px）：创建时间框 + 查看详情 + SEARCH 过滤框 */}
        <div className="flex w-[130px] shrink-0 flex-col items-stretch">
          {(detail.kind !== 'artist' || detailMeta?.timeLabel) && (
            <div
              className="flex h-4 items-center justify-center whitespace-nowrap border px-1 text-[10px] font-bold text-[var(--md-sys-color-on-surface)]"
              style={{
                borderColor: 'var(--md-sys-color-on-surface)',
              }}
              title={detail.kind === 'album' ? '发行时间' : '创建时间'}
            >
              {detail.kind === 'album' ? '发行时间' : '创建时间'}{' '}
              {detailMeta?.timeLabel ?? '—'}
            </div>
          )}
          <button
            type="button"
            className="mt-1.5 h-4 bg-[var(--md-sys-color-on-surface)] text-[10px] font-bold text-[var(--md-sys-color-surface)] transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_80%,transparent)]"
            onClick={() => setIntroOpen(true)}
            title="查看详情"
          >
            查看详情
          </button>
          {/* 歌曲过滤（Hydrogen SongFilterInput SEARCH，居中文本） */}
          <div
            className="mt-2 flex h-8 w-full items-center gap-1.5 rounded-full border px-2.5"
            style={{
              borderColor: 'var(--md-sys-color-outline-variant)',
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent)',
            }}
          >
            <Search
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
            <input
              value={filterKeyword}
              onChange={(e) => setFilterKeyword(e.target.value)}
              placeholder="SEARCH"
              aria-label="过滤歌曲"
              className="min-w-0 flex-1 bg-transparent text-center text-xs outline-none placeholder:text-[color:color-mix(in_srgb,var(--md-sys-color-on-surface-variant)_70%,transparent)]"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            />
          </div>
        </div>
      </div>

      {/* ===== library-option：播放全部分隔行 ===== */}
      <div className="shrink-0 px-1 pt-[15px]">
        <div className="my-2.5 flex items-center">
          <button
            type="button"
            className="flex shrink-0 items-center transition-opacity hover:opacity-60"
            onClick={handlePlayAll}
            title="播放全部（加入队列）"
          >
            {/* 描边三角播放图标（17px，Hydrogen playall 同款） */}
            <svg
              viewBox="0 0 200 200"
              className="h-[17px] w-[17px]"
              aria-hidden="true"
            >
              <path
                d="M11.79,132L164.21,132L88,0L11.79,132Z "
                transform="translate(0 12) rotate(90 88 88)"
                fill="none"
                stroke="currentColor"
                strokeWidth={8}
                style={{ color: 'var(--md-sys-color-on-surface)' }}
              />
            </svg>
            <span className="mx-[5px] whitespace-nowrap text-xs font-bold text-[var(--md-sys-color-on-surface)]">
              播放全部
            </span>
          </button>
          <div
            className="h-px min-w-4 flex-1"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 35%, transparent)',
            }}
          />
          <span className="ml-1 text-[8px] font-bold tracking-widest text-[var(--md-sys-color-on-surface-variant)]">
            PLAYALL
          </span>
        </div>
      </div>

      {/* ===== 歌曲列表（内滚，scrollbar-gutter stable 防宽度抖动） ===== */}
      <div
        ref={listScrollRef}
        className="zen-scroll min-h-0 flex-1 overflow-y-auto pt-3"
        style={{ scrollbarGutter: 'stable' }}
      >
        {detailLoading && (
          <div className="flex items-center gap-2 px-2 py-3 text-sm text-[var(--md-sys-color-on-surface-variant)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在获取歌曲…
          </div>
        )}
        {!detailLoading && filteredSongs.length === 0 && (
          <div className="flex flex-1 items-center justify-center py-10 text-sm text-[var(--md-sys-color-on-surface-variant)]">
            {kw !== '' ? '未找到相关歌曲' : '暂无歌曲'}
          </div>
        )}
        {filteredSongs.map((song, idx) => {
          const added = addedKeys.has(`ncm:${song.songId}`)
          return (
            <SongRow
              key={song.songId}
              index={idx + 1}
              name={song.name}
              artist={song.artist}
              cover={song.cover}
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
            className="flex h-12 items-center justify-center gap-2 text-sm text-[var(--md-sys-color-on-surface-variant)]"
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

      {/* ===== 查看详情弹窗（Hydrogen introduce-detail：700×400 毛玻璃，
          metro 先宽后高展开 + 四角白点闪烁 + 右上 X 延迟浮现） ===== */}
      <style>{INTRODUCE_STYLE}</style>
      {introOpen && (
        <div
          className="fixed left-1/2 top-1/2 z-[998] flex -translate-x-1/2 -translate-y-1/2 overflow-hidden"
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.66)',
            backdropFilter: 'blur(18px) saturate(120%)',
            WebkitBackdropFilter: 'blur(18px) saturate(120%)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
            width: 0,
            height: 0,
            padding: 0,
            animation:
              'zen-introduce-in 0.6s 0.3s cubic-bezier(0.3, 0.79, 0.55, 0.99) forwards',
          }}
          role="dialog"
          aria-label="详情描述"
        >
          <div className="h-full w-full overflow-y-auto">
            <p className="text-sm font-semibold leading-relaxed text-white/90 [text-indent:2em]">
              {detailMeta?.description || '暂无描述'}
            </p>
          </div>
          {/* 四角白点（9px，闪烁后常显） */}
          <span
            className="absolute -left-1 -top-1 h-[9px] w-[9px] bg-white/90 opacity-0"
            style={{ animation: 'zen-introduce-corner 0.4s forwards' }}
            aria-hidden="true"
          />
          <span
            className="absolute -right-1 -top-1 h-[9px] w-[9px] bg-white/90 opacity-0"
            style={{ animation: 'zen-introduce-corner 0.4s forwards' }}
            aria-hidden="true"
          />
          <span
            className="absolute -bottom-1 -right-1 h-[9px] w-[9px] bg-white/90 opacity-0"
            style={{ animation: 'zen-introduce-corner 0.4s forwards' }}
            aria-hidden="true"
          />
          <span
            className="absolute -bottom-1 -left-1 h-[9px] w-[9px] bg-white/90 opacity-0"
            style={{ animation: 'zen-introduce-corner 0.4s forwards' }}
            aria-hidden="true"
          />
          <button
            type="button"
            className="absolute right-[15px] top-[15px] h-6 w-6 opacity-0 transition-opacity hover:opacity-80"
            style={{ animation: 'zen-introduce-close 0.1s 0.6s forwards' }}
            onClick={() => setIntroOpen(false)}
            title="关闭"
            aria-label="关闭详情"
          >
            <svg
              viewBox="0 0 1024 1024"
              className="h-full w-full"
              aria-hidden="true"
            >
              <path
                d="M576 512l277.333333 277.333333-64 64-277.333333-277.333333L234.666667 853.333333 170.666667 789.333333l277.333333-277.333333L170.666667 234.666667 234.666667 170.666667l277.333333 277.333333L789.333333 170.666667 853.333333 234.666667 576 512z"
                fill="#ffffff"
              />
            </svg>
          </button>
        </div>
      )}
    </div>
  ) : (
    /* ===== 默认空态（Hydrogen NONE：对角线 + 闪烁文字 + 四角方块） ===== */
    <MyMusicEmpty />
  )

  // ===== 页面骨架（Hydrogen 内滚架构：页面不滚，左栏 / 右区各自内滚） =====
  return (
    <div className="flex h-full min-h-0 px-6 pt-6 md:px-8">
      {/* ===== 左侧栏（Hydrogen .music-library：宽 262px，静态布局无 sticky） ===== */}
      <div className="flex w-[262px] min-h-0 shrink-0 flex-col">
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

        {/* 列表区（Hydrogen .library-list：flex-1 内滚；scrollbar-gutter
            stable 固定滚动条占位，杜绝数据加载后滚动条出现引起的宽度抖动） */}
        <div
          className="zen-scroll mt-1 min-h-0 flex-1 overflow-y-auto pb-[15px] pt-1"
          style={{ scrollbarGutter: 'stable' }}
        >
          {/* ===== 歌单（我创建的 / 我收藏的） ===== */}
          {listType1 === 0 &&
            (playlistsLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-[var(--md-sys-color-on-surface-variant)]">
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
                      openDetail({
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
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-[var(--md-sys-color-on-surface-variant)]">
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
                      openDetail({
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
                      openDetail({
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
 * 50px 方图 + 名称 + 副信息；hover/选中为「背景从左滑入」动画
 * （背景层 will-change-transform 合成层化，避免 1s 长动画反复重绘卡顿） */
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
          'absolute inset-0 -translate-x-full bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)] will-change-transform transition-transform duration-1000 ease-[cubic-bezier(0.22,0.61,0.36,1)] group-hover:translate-x-0 group-hover:delay-200',
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
