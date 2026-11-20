/**
 * 点歌弹窗（一起听面板内入口）。
 *
 * 一起听已独立于房间模式：屏幕共享/一起看房间也能点歌，所以原来挂在
 * MusicAppShell（音乐全量页）里的搜索页不可达，这里提供轻量点歌弹窗：
 * - 搜索走网易云 cloudsearch（失败回退老 /search，双结构兼容）
 * - 「我的歌单」可直接浏览当前网易云账号的歌单（自建 + 收藏），
 *   支持整张歌单一次性入队（music:queue-add-many，服务端单次事务广播）
 * - 入队复用 useQueueAdd：房主/房管直接 upsert，普通成员走控制申请
 *   （房主端审批，见 useListenTogether 的 control-request 流程）
 * - 权限本身由后端 queue-upsert / queue-add-many 的 CanRequestMusic 二次校验
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Socket } from 'socket.io-client'
import {
  ChevronLeft,
  ChevronRight,
  ListMusic,
  Search,
  Sparkles,
  Trophy,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Text } from '@/components/ui/Typography'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { message } from '@/components/ui/message'
import { t } from '@/i18n'
import { cn } from '@/lib/utils'
import { apiGet } from '../musicApi'
import {
  useQueueAdd,
  songToUpsertItem,
  upsertItemKey,
  type QueueUpsertItem,
} from '../hooks/useQueueAdd'
import {
  fallbackNcmAvatar,
  musicCoverUrl,
  portableMusicCoverUrl,
} from '../utils/neteaseImage'
import type { NcmSong } from '../types'

/** 搜索结果条目（cloudsearch 新结构 + 老版 /search 旧结构兼容） */
interface CloudsearchSong {
  id: number
  name: string
  ar?: Array<{ name?: string }>
  al?: { name?: string; picUrl?: string }
  dt?: number
  artists?: Array<{ name?: string }>
  album?: { name?: string; picUrl?: string }
  duration?: number
  fee?: number
}

interface NcmCloudsearchResponse {
  code?: number
  result?: {
    songs?: CloudsearchSong[]
  }
}

/** 账号歌单条目（/user/playlist.playlist[] 子集） */
interface UserPlaylistItem {
  id: number
  name: string
  coverImgUrl?: string
  trackCount?: number
  subscribed?: boolean
}

interface UserPlaylistResponse {
  playlist?: UserPlaylistItem[]
}

interface AccountResponse {
  account?: { id?: number }
  profile?: { userId?: number }
}

interface PlaylistTracksResponse {
  songs?: CloudsearchSong[]
}

/** 点歌「用户」页：后端已归一化的网易云用户。 */
interface MusicUserItem {
  userId: number
  nickname: string
  avatarUrl?: string
  signature?: string
  follows?: number
  followeds?: number
  playlistCount?: number
}

interface MusicUserListResponse {
  success?: boolean
  users?: MusicUserItem[]
  total?: number
  more?: boolean
  message?: string
}

/** 点歌「用户」页：后端已归一化的用户歌单。 */
interface MusicPlaylistItem {
  id: number
  name: string
  cover?: string
  trackCount?: number
  creatorName?: string
  description?: string
}

interface MusicPlaylistListResponse {
  success?: boolean
  playlists?: MusicPlaylistItem[]
  more?: boolean
  message?: string
}

interface MusicPlaylistSongsResponse {
  success?: boolean
  songs?: NcmSong[]
  message?: string
}

/** 排行榜卡片（GET /toplist → list[]，字段与网易云客户端一致） */
interface NcmToplistCard {
  id: number
  name: string
  coverImgUrl?: string
  updateFrequency?: string
}

interface ToplistResponse {
  list?: NcmToplistCard[]
}

/** 每日推荐（GET /recommend/songs → data.dailySongs，需登录） */
interface RecommendSongsResponse {
  code?: number
  data?: { dailySongs?: CloudsearchSong[] }
  dailySongs?: CloudsearchSong[]
}

/** 搜索结果条数上限 */
const SEARCH_LIMIT = 20
/** 单个歌单一次最多拉取/入队的歌曲数（与后端 queue-add-many 上限一致） */
const PLAYLIST_ADD_LIMIT = 200

/** 搜索结果条目 → 队列条目结构 */
function mapSong(song: CloudsearchSong): NcmSong {
  return {
    songId: song.id,
    name: song.name,
    artist: (song.ar ?? song.artists ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(' / '),
    album: song.al?.name ?? song.album?.name ?? '',
    cover: portableMusicCoverUrl(song.al?.picUrl ?? song.album?.picUrl ?? ''),
    durationMs: song.dt ?? song.duration ?? 0,
    vip: song.fee === 1 || song.fee === 4,
  }
}

/** 毫秒 → m:ss */
function formatDuration(ms: number): string {
  if (!ms || ms < 0) return ''
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

type TabKey = 'search' | 'playlist' | 'toplist' | 'daily' | 'user'
type MusicUserScope = 'follows' | 'followers'

export interface MusicQueueSearchModalProps {
  socket: Socket | null
  roomId: string | undefined
  /** 关闭弹窗 */
  onClose: () => void
  /**
   * portal 目标容器。默认 document.body；播放器全屏时由调用方传入
   * 舞台内的宿主节点，否则弹窗渲染在全屏元素子树之外 → 看不到。
   */
  container?: HTMLElement | null
}

export function MusicQueueSearchModal({
  socket,
  roomId,
  onClose,
  container,
}: MusicQueueSearchModalProps) {
  const [tab, setTab] = useState<TabKey>('search')

  // ── 搜索 ─────────────────────────────────────────────
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<NcmSong[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  /** 搜索竞态序号（过期响应丢弃） */
  const searchSeqRef = useRef(0)
  const { addedKeys, add } = useQueueAdd(socket, roomId, true)

  // ── 账号歌单 ──────────────────────────────────────────
  const [playlists, setPlaylists] = useState<UserPlaylistItem[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState<string | null>(null)
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false)
  const [selectedPlaylist, setSelectedPlaylist] =
    useState<UserPlaylistItem | null>(null)
  const [tracks, setTracks] = useState<NcmSong[]>([])
  const [tracksLoading, setTracksLoading] = useState(false)
  /** 批量入队进行中 */
  const [adding, setAdding] = useState(false)
  /** 批量入队成功的歌曲 key（展示「已添加」态） */
  const [batchAdded, setBatchAdded] = useState<Set<string>>(() => new Set())

  // ── 排行榜 ────────────────────────────────────────────
  const [toplists, setToplists] = useState<NcmToplistCard[]>([])
  const [toplistsLoading, setToplistsLoading] = useState(false)
  const [toplistsLoaded, setToplistsLoaded] = useState(false)
  const [toplistsError, setToplistsError] = useState<string | null>(null)
  const [selectedToplist, setSelectedToplist] = useState<NcmToplistCard | null>(
    null
  )
  const [toplistTracks, setToplistTracks] = useState<NcmSong[]>([])
  const [toplistLoading, setToplistLoading] = useState(false)

  // ── 每日推荐 ──────────────────────────────────────────
  const [dailySongs, setDailySongs] = useState<NcmSong[]>([])
  const [dailyLoading, setDailyLoading] = useState(false)
  const [dailyLoaded, setDailyLoaded] = useState(false)
  const [dailyError, setDailyError] = useState<string | null>(null)

  // ── 用户（关注/粉丝、搜索用户、TA 的歌单） ──────────────
  const [userScope, setUserScope] = useState<MusicUserScope>('follows')
  const [userInput, setUserInput] = useState('')
  const [userQuery, setUserQuery] = useState('')
  const [users, setUsers] = useState<MusicUserItem[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState<string | null>(null)
  const [usersLoadedScope, setUsersLoadedScope] = useState<MusicUserScope | null>(
    null
  )
  const [userTotal, setUserTotal] = useState(0)
  const usersSeqRef = useRef(0)
  const [selectedUser, setSelectedUser] = useState<MusicUserItem | null>(null)
  const [userPlaylists, setUserPlaylists] = useState<MusicPlaylistItem[]>([])
  const [userPlaylistsLoading, setUserPlaylistsLoading] = useState(false)
  const [userPlaylistsError, setUserPlaylistsError] = useState<string | null>(
    null
  )
  /** 歌单列表是否还有下一页（用于把数量显示成「N+」而不是误报成 N）。 */
  const [userPlaylistsMore, setUserPlaylistsMore] = useState(false)
  const [selectedUserPlaylist, setSelectedUserPlaylist] =
    useState<MusicPlaylistItem | null>(null)
  const [userPlaylistSongs, setUserPlaylistSongs] = useState<NcmSong[]>([])
  const [userPlaylistLoading, setUserPlaylistLoading] = useState(false)
  const userDetailSeqRef = useRef(0)
  const userPlaylistSeqRef = useRef(0)

  const markAdded = useCallback((items: QueueUpsertItem[]) => {
    if (items.length === 0) return
    setBatchAdded((prev) => {
      const next = new Set(prev)
      for (const item of items) next.add(upsertItemKey(item))
      return next
    })
  }, [])

  const runSearch = useCallback(async (kw: string) => {
    const trimmed = kw.trim()
    searchSeqRef.current++
    const seq = searchSeqRef.current
    if (!trimmed) {
      setResults([])
      setSearched(false)
      return
    }
    setSearching(true)
    try {
      const { data, ok } = await apiGet<NcmCloudsearchResponse>(
        `/api/music/ncm/cloudsearch?keywords=${encodeURIComponent(trimmed)}&limit=${SEARCH_LIMIT}`
      )
      let songs = ok ? data?.result?.songs : undefined
      if (!Array.isArray(songs)) {
        const fb = await apiGet<NcmCloudsearchResponse>(
          `/api/music/ncm/search?keywords=${encodeURIComponent(trimmed)}&limit=${SEARCH_LIMIT}`
        )
        songs = fb.data?.result?.songs
      }
      if (seq !== searchSeqRef.current) return
      setResults(Array.isArray(songs) ? songs.map(mapSong) : [])
      setSearched(true)
    } catch (err) {
      console.error('[MusicQueueSearchModal] 搜索失败:', err)
      if (seq !== searchSeqRef.current) return
      message.error(t('搜索失败，请稍后重试'))
      setResults([])
      setSearched(true)
    } finally {
      if (seq === searchSeqRef.current) setSearching(false)
    }
  }, [])

  /** 拉取当前账号歌单（自建 + 收藏，顺序与网易云客户端一致） */
  const loadPlaylists = useCallback(async () => {
    setPlaylistsLoading(true)
    setPlaylistsError(null)
    try {
      const acc = await apiGet<AccountResponse>(
        `/api/music/ncm/user/account?timestamp=${Date.now()}`
      )
      const uid = acc.data?.account?.id ?? acc.data?.profile?.userId
      if (!uid) {
        setPlaylistsError(t('请先登录网易云账号（面板底部账号区可扫码登录）'))
        setPlaylists([])
        return
      }
      const res = await apiGet<UserPlaylistResponse>(
        `/api/music/ncm/user/playlist?uid=${uid}&limit=500&offset=0&timestamp=${Date.now()}`
      )
      const list = Array.isArray(res.data?.playlist) ? res.data.playlist : []
      setPlaylists(
        list.filter((item) => item && Number.isFinite(item.id) && item.id > 0)
      )
      setPlaylistsLoaded(true)
    } catch (err) {
      console.error('[MusicQueueSearchModal] 获取账号歌单失败:', err)
      setPlaylistsError(t('获取账号歌单失败，请确认已登录网易云账号'))
      setPlaylists([])
    } finally {
      setPlaylistsLoading(false)
    }
  }, [])

  // 首次切到「我的歌单」tab 时懒加载
  useEffect(() => {
    if (tab !== 'playlist' || playlistsLoaded || playlistsLoading) return
    void loadPlaylists()
  }, [tab, playlistsLoaded, playlistsLoading, loadPlaylists])

  /** 打开歌单：拉取前 200 首 */
  const openPlaylist = useCallback(async (playlist: UserPlaylistItem) => {
    setSelectedPlaylist(playlist)
    setTracks([])
    setTracksLoading(true)
    try {
      const res = await apiGet<PlaylistTracksResponse>(
        `/api/music/ncm/playlist/track/all?id=${playlist.id}&limit=${PLAYLIST_ADD_LIMIT}&offset=0`
      )
      const songs = Array.isArray(res.data?.songs) ? res.data.songs : []
      setTracks(songs.map(mapSong).filter((song) => song.songId > 0))
    } catch (err) {
      console.error('[MusicQueueSearchModal] 获取歌单歌曲失败:', err)
      message.error(t('获取歌单歌曲失败'))
      setTracks([])
    } finally {
      setTracksLoading(false)
    }
  }, [])

  /** 榜单列表（/toplist 返回全部官方榜 + 精选榜，无需登录） */
  const loadToplists = useCallback(async () => {
    setToplistsLoading(true)
    setToplistsError(null)
    try {
      const res = await apiGet<ToplistResponse>('/api/music/ncm/toplist')
      const list = Array.isArray(res.data?.list) ? res.data.list : []
      setToplists(
        list.filter(
          (item) => item && Number.isFinite(item.id) && item.id > 0 && item.name
        )
      )
      setToplistsLoaded(true)
    } catch (err) {
      console.error('[MusicQueueSearchModal] 获取榜单失败:', err)
      setToplistsError(t('获取榜单失败'))
      setToplists([])
    } finally {
      setToplistsLoading(false)
    }
  }, [])

  /** 打开某个榜单：与打开歌单同一条接口（榜单就是网易云的特殊歌单） */
  const openToplist = useCallback(async (toplist: NcmToplistCard) => {
    setSelectedToplist(toplist)
    setToplistTracks([])
    setToplistLoading(true)
    try {
      const res = await apiGet<PlaylistTracksResponse>(
        `/api/music/ncm/playlist/track/all?id=${toplist.id}&limit=${PLAYLIST_ADD_LIMIT}&offset=0`
      )
      const songs = Array.isArray(res.data?.songs) ? res.data.songs : []
      setToplistTracks(songs.map(mapSong).filter((song) => song.songId > 0))
    } catch (err) {
      console.error('[MusicQueueSearchModal] 获取榜单歌曲失败:', err)
      message.error(t('获取歌单歌曲失败'))
      setToplistTracks([])
    } finally {
      setToplistLoading(false)
    }
  }, [])

  /** 每日推荐（服务端用房间共享的网易云凭证拉取，未登录会回 301） */
  const loadDaily = useCallback(async () => {
    setDailyLoading(true)
    setDailyError(null)
    try {
      const res = await apiGet<RecommendSongsResponse>('/api/music/ncm/recommend/songs')
      if (res.data?.code === 301) {
        setDailyError(t('请先登录网易云账号（面板底部账号区可扫码登录）'))
        setDailySongs([])
        return
      }
      const songs = res.data?.data?.dailySongs ?? res.data?.dailySongs ?? []
      setDailySongs(songs.map(mapSong).filter((song) => song.songId > 0))
      setDailyLoaded(true)
    } catch (err) {
      console.error('[MusicQueueSearchModal] 获取每日推荐失败:', err)
      setDailyError(t('获取每日推荐失败'))
      setDailySongs([])
    } finally {
      setDailyLoading(false)
    }
  }, [])

  /**
   * 批量入队：优先走 music:queue-add-many（一次请求一次广播）；
   * 旧版服务端没有该事件时回退为逐首 queue-upsert，保证功能可用。
   */
  const addMany = useCallback(
    async (songs: NcmSong[], label: string) => {
      if (!socket || !roomId) {
        message.error(t('未连接房间'))
        return
      }
      const unique: NcmSong[] = []
      const seen = new Set<number>()
      for (const song of songs) {
        if (!song.songId || seen.has(song.songId)) continue
        seen.add(song.songId)
        unique.push(song)
        if (unique.length >= PLAYLIST_ADD_LIMIT) break
      }
      if (unique.length === 0) {
        message.info(t('没有可添加的歌曲'))
        return
      }
      const items = unique.map((song) => {
        const item = songToUpsertItem(song)
        return { ...item, cover: portableMusicCoverUrl(item.cover) }
      })
      setAdding(true)
      try {
        let response: { success?: boolean; added?: number; message?: string } | null =
          null
        try {
          response = await new Promise<{
            success?: boolean
            added?: number
            message?: string
          }>((resolve) => {
            socket.timeout(10000).emit(
              'music:queue-add-many',
              { roomId, items },
              (err: unknown, resp?: { success?: boolean; added?: number; message?: string }) => {
                if (err) resolve({ success: false })
                else resolve(resp ?? { success: false })
              }
            )
          })
        } catch {
          response = { success: false }
        }
        if (response && response.success === false && response.message) {
          // 服务端明确拒绝（多半是无点歌权限）：不降级重试，直接提示
          message.error(response.message)
          return
        }
        if (response && response.success) {
          markAdded(items)
          const count = response.added ?? items.length
          message.success(
            t('已添加 {{count}} 首歌曲到播放队列', { count })
          )
          return
        }
        // 事件不可用（旧服务端）：逐首添加
        for (const item of items) add(item)
        markAdded(items)
        message.success(t('已添加 {{count}} 首歌曲到播放队列', { count: items.length }))
        console.info('[MusicQueueSearchModal] queue-add-many 不可用，已回退逐首添加:', label)
      } finally {
        setAdding(false)
      }
    },
    [add, markAdded, roomId, socket]
  )

  /** 读取当前账号的关注 / 粉丝列表（后端解析，前端只渲染）。 */
  const loadUserScope = useCallback(async (scope: MusicUserScope) => {
    const seq = ++usersSeqRef.current
    setUsersLoading(true)
    setUsersError(null)
    setUserQuery('')
    try {
      const { data } = await apiGet<MusicUserListResponse>(
        `/api/music/users/${scope}?limit=30&offset=0&timestamp=${Date.now()}`
      )
      if (seq !== usersSeqRef.current) return
      const list = Array.isArray(data?.users) ? data.users : []
      setUsers(list)
      setUserTotal(data?.total ?? list.length)
      setUsersLoadedScope(scope)
    } catch (err) {
      if (seq !== usersSeqRef.current) return
      setUsers([])
      setUsersLoadedScope(null)
      setUsersError(
        err instanceof Error
          ? err.message
          : t('获取用户列表失败，请先登录网易云账号')
      )
    } finally {
      if (seq === usersSeqRef.current) setUsersLoading(false)
    }
  }, [])

  /** 按昵称搜索网易云用户；清空关键词回到关注/粉丝列表。 */
  const runUserSearch = useCallback(
    async (keyword: string) => {
      const trimmed = keyword.trim()
      if (!trimmed) {
        setUserInput('')
        await loadUserScope(userScope)
        return
      }
      const seq = ++usersSeqRef.current
      setUserQuery(trimmed)
      setUsersLoading(true)
      setUsersError(null)
      setUsers([])
      try {
        const { data } = await apiGet<MusicUserListResponse>(
          `/api/music/users/search?keywords=${encodeURIComponent(
            trimmed
          )}&limit=30&offset=0&timestamp=${Date.now()}`
        )
        if (seq !== usersSeqRef.current) return
        const list = Array.isArray(data?.users) ? data.users : []
        setUsers(list)
        setUserTotal(data?.total ?? list.length)
      } catch (err) {
        if (seq !== usersSeqRef.current) return
        setUsers([])
        setUsersError(
          err instanceof Error ? err.message : t('搜索用户失败，请稍后重试')
        )
      } finally {
        if (seq === usersSeqRef.current) setUsersLoading(false)
      }
    },
    [loadUserScope, userScope]
  )

  const switchUserScope = useCallback(
    (scope: MusicUserScope) => {
      setUserScope(scope)
      setUserInput('')
      setUsersLoadedScope(null)
      void loadUserScope(scope)
    },
    [loadUserScope]
  )

  /** 打开某个用户：拉取 TA 的公开歌单。 */
  const openUser = useCallback(async (user: MusicUserItem) => {
    const seq = ++userDetailSeqRef.current
    setSelectedUser(user)
    setSelectedUserPlaylist(null)
    setUserPlaylistSongs([])
    setUserPlaylists([])
    setUserPlaylistsError(null)
    setUserPlaylistsMore(false)
    setUserPlaylistsLoading(true)
    try {
      const { data } = await apiGet<MusicPlaylistListResponse>(
        `/api/music/users/playlists?uid=${user.userId}&limit=500&offset=0&timestamp=${Date.now()}`
      )
      if (seq !== userDetailSeqRef.current) return
      setUserPlaylists(Array.isArray(data?.playlists) ? data.playlists : [])
      setUserPlaylistsMore(data?.more === true)
    } catch (err) {
      if (seq !== userDetailSeqRef.current) return
      setUserPlaylists([])
      setUserPlaylistsError(
        err instanceof Error ? err.message : t('获取用户歌单失败')
      )
    } finally {
      if (seq === userDetailSeqRef.current) setUserPlaylistsLoading(false)
    }
  }, [])

  /** 打开用户歌单：后端解析成可直接入队的歌曲结构。 */
  const openUserPlaylist = useCallback(
    async (playlist: MusicPlaylistItem) => {
      const seq = ++userPlaylistSeqRef.current
      setSelectedUserPlaylist(playlist)
      setUserPlaylistSongs([])
      setUserPlaylistLoading(true)
      try {
        const { data } = await apiGet<MusicPlaylistSongsResponse>(
          `/api/music/users/playlist/songs?id=${playlist.id}&limit=${PLAYLIST_ADD_LIMIT}&offset=0`
        )
        if (seq !== userPlaylistSeqRef.current) return
        const songs = Array.isArray(data?.songs) ? data.songs : []
        setUserPlaylistSongs(
          songs
            .map((song) => ({
              ...song,
              cover: portableMusicCoverUrl(song.cover),
            }))
            .filter((song) => song.songId > 0)
        )
      } catch (err) {
        if (seq !== userPlaylistSeqRef.current) return
        setUserPlaylistSongs([])
        message.error(
          err instanceof Error ? err.message : t('获取歌单歌曲失败')
        )
      } finally {
        if (seq === userPlaylistSeqRef.current) setUserPlaylistLoading(false)
      }
    },
    []
  )

  // Esc 关闭（全屏/舞台模式下也能退出）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleAdd = (song: NcmSong) => {
    add(songToUpsertItem(song), { notify: true })
  }

  /** 歌曲行（搜索结果 / 歌单歌曲共用） */
  const songRow = (song: NcmSong) => {
    const key = `ncm:${song.songId}`
    const added = batchAdded.has(key) || addedKeys.has(key)
    return (
      <div
        key={song.songId}
        className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-black/5"
      >
        {song.cover ? (
          <img
            src={song.cover}
            alt=""
            className="h-10 w-10 shrink-0 rounded-lg object-cover"
            loading="lazy"
          />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-lg bg-black/10" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{song.name}</div>
          <div className="truncate text-xs opacity-60">
            {song.artist}
            {song.vip ? ` · ${t('VIP')}` : ''}
          </div>
        </div>
        <span className="shrink-0 text-xs tabular-nums opacity-50">
          {formatDuration(song.durationMs)}
        </span>
        <Button
          size="sm"
          variant={added ? 'secondary' : 'primary'}
          className="h-7 shrink-0 px-2 text-xs"
          disabled={added}
          onClick={() => handleAdd(song)}
        >
          {added ? t('已添加') : t('点歌')}
        </Button>
      </div>
    )
  }

  /** 用户行（关注 / 粉丝 / 搜索结果共用）。 */
  const userRow = (user: MusicUserItem) => (
    <button
      key={user.userId}
      type="button"
      className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-black/5"
      onClick={() => void openUser(user)}
    >
      {user.avatarUrl ? (
        <img
          src={musicCoverUrl(user.avatarUrl, 80)}
          alt=""
          className="h-10 w-10 shrink-0 rounded-full object-cover"
          loading="lazy"
          onError={fallbackNcmAvatar}
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/10">
          <Users className="h-4 w-4 opacity-50" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{user.nickname}</div>
        {/* 歌单数量以点开后实际拉取的列表为准：上游 playlistCount 含私密/
            已删除歌单，直接显示会与实际可点开的数量对不上。 */}
        <div className="truncate text-xs opacity-60">
          {`${t('关注')} ${user.follows ?? 0} · ${t('粉丝')} ${
            user.followeds ?? 0
          }`}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 opacity-40" />
    </button>
  )

  /** 用户歌单行。 */
  const userPlaylistRow = (playlist: MusicPlaylistItem) => (
    <button
      key={playlist.id}
      type="button"
      className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-black/5"
      onClick={() => void openUserPlaylist(playlist)}
    >
      {playlist.cover ? (
        <img
          src={portableMusicCoverUrl(playlist.cover)}
          alt=""
          className="h-10 w-10 shrink-0 rounded-lg object-cover"
          loading="lazy"
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-black/10">
          <ListMusic className="h-4 w-4 opacity-50" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{playlist.name}</div>
        <div className="truncate text-xs opacity-60">
          {t('共 {{count}} 首', { count: playlist.trackCount ?? 0 })}
          {playlist.creatorName ? ` · ${playlist.creatorName}` : ''}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 opacity-40" />
    </button>
  )

  // 切到对应 tab 时懒加载（失败后仍可重进该 tab 重试）
  useEffect(() => {
    if (tab === 'toplist' && !toplistsLoaded && !toplistsLoading) void loadToplists()
    if (tab === 'daily' && !dailyLoaded && !dailyLoading) void loadDaily()
    if (
      tab === 'user' &&
      !selectedUser &&
      !userQuery &&
      usersLoadedScope !== userScope &&
      !usersLoading
    ) {
      void loadUserScope(userScope)
    }
  }, [
    tab,
    toplistsLoaded,
    toplistsLoading,
    loadToplists,
    dailyLoaded,
    dailyLoading,
    loadDaily,
    selectedUser,
    userQuery,
    usersLoadedScope,
    userScope,
    usersLoading,
    loadUserScope,
  ])

  /** 详情视图：歌单详情或榜单详情（当前 tab 决定数据源） */
  const detailView =
    tab === 'playlist' && selectedPlaylist
      ? {
          title: selectedPlaylist.name,
          subtitle: t('共 {{count}} 首', {
            count: selectedPlaylist.trackCount ?? tracks.length,
          }),
          songs: tracks,
          loading: tracksLoading,
          onBack: () => {
            setSelectedPlaylist(null)
            setTracks([])
          },
        }
      : tab === 'toplist' && selectedToplist
        ? {
            title: selectedToplist.name,
            subtitle: selectedToplist.updateFrequency
              ? `${t('共 {{count}} 首', { count: toplistTracks.length })} · ${selectedToplist.updateFrequency}`
              : t('共 {{count}} 首', { count: toplistTracks.length }),
            songs: toplistTracks,
            loading: toplistLoading,
            onBack: () => {
              setSelectedToplist(null)
              setToplistTracks([])
            },
          }
        : tab === 'user' && selectedUserPlaylist
          ? {
              title: selectedUserPlaylist.name,
              subtitle: t('共 {{count}} 首', {
                count: userPlaylistSongs.length,
              }),
              songs: userPlaylistSongs,
              loading: userPlaylistLoading,
              onBack: () => {
                setSelectedUserPlaylist(null)
                setUserPlaylistSongs([])
              },
            }
          : null

  return createPortal(
    <div
      data-music-ui="modal"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          'glass-strong flex w-full max-w-[440px] flex-col overflow-hidden rounded-2xl',
          'shadow-2xl zen-modal-content-enter'
        )}
        style={{ maxHeight: 'min(560px, calc(100vh - 120px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div
          className="flex items-center justify-between gap-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
        >
          <Text className="text-sm font-semibold">{t('点歌')}</Text>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={onClose}
            aria-label={t('关闭')}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Tab 切换 */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition',
              tab === 'search'
                ? 'bg-[var(--md-sys-color-primary)] text-white'
                : 'bg-black/5 opacity-70 hover:opacity-100'
            )}
            onClick={() => setTab('search')}
          >
            <Search className="h-3.5 w-3.5" />
            {t('搜索')}
          </button>
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition',
              tab === 'playlist'
                ? 'bg-[var(--md-sys-color-primary)] text-white'
                : 'bg-black/5 opacity-70 hover:opacity-100'
            )}
            onClick={() => setTab('playlist')}
          >
            <ListMusic className="h-3.5 w-3.5" />
            {t('我的歌单')}
          </button>
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition',
              tab === 'toplist'
                ? 'bg-[var(--md-sys-color-primary)] text-white'
                : 'bg-black/5 opacity-70 hover:opacity-100'
            )}
            onClick={() => setTab('toplist')}
          >
            <Trophy className="h-3.5 w-3.5" />
            {t('榜单')}
          </button>
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition',
              tab === 'daily'
                ? 'bg-[var(--md-sys-color-primary)] text-white'
                : 'bg-black/5 opacity-70 hover:opacity-100'
            )}
            onClick={() => setTab('daily')}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('每日推荐')}
          </button>
          <button
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition',
              tab === 'user'
                ? 'bg-[var(--md-sys-color-primary)] text-white'
                : 'bg-black/5 opacity-70 hover:opacity-100'
            )}
            onClick={() => setTab('user')}
          >
            <Users className="h-3.5 w-3.5" />
            {t('用户')}
          </button>
        </div>

        {tab === 'search' ? (
          <>
            {/* 搜索框 */}
            <form
              className="flex items-center gap-2 px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault()
                void runSearch(keyword)
              }}
            >
              <div
                className="flex flex-1 items-center gap-2 rounded-full border px-3 py-1.5"
                style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
              >
                <Search className="h-4 w-4 opacity-60" />
                <input
                  autoFocus
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder={t('搜索歌曲 / 歌手')}
                  className="w-full bg-transparent text-sm outline-none"
                />
              </div>
              <Button type="submit" size="sm" disabled={searching}>
                {t('搜索')}
              </Button>
            </form>

            {/* 结果列表 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {searching && results.length === 0 ? (
                <div className="flex justify-center py-10">
                  <Spinner size={24} tip={t('正在搜索')} />
                </div>
              ) : results.length === 0 ? (
                <div className="py-10 text-center text-xs opacity-60">
                  {searched ? t('没有找到歌曲') : t('输入关键词搜索网易云歌曲')}
                </div>
              ) : (
                results.map((song) => songRow(song))
              )}
            </div>
          </>
        ) : tab === 'user' && !detailView ? (
          selectedUser ? (
            <>
              <div className="flex items-center gap-2 px-4 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 shrink-0 p-0"
                  onClick={() => {
                    setSelectedUser(null)
                    setUserPlaylists([])
                    setUserPlaylistsError(null)
                    setUserPlaylistsMore(false)
                  }}
                  aria-label={t('返回')}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                {selectedUser.avatarUrl ? (
                  <img
                    src={musicCoverUrl(selectedUser.avatarUrl, 80)}
                    alt=""
                    className="h-9 w-9 shrink-0 rounded-full object-cover"
                    onError={fallbackNcmAvatar}
                  />
                ) : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/10">
                    <Users className="h-4 w-4 opacity-50" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {selectedUser.nickname}
                  </div>
                  <div className="truncate text-xs opacity-60">
                    {selectedUser.signature ||
                      `${t('关注')} ${selectedUser.follows ?? 0} · ${
                        t('粉丝')
                      } ${selectedUser.followeds ?? 0}`}
                  </div>
                </div>
                <span className="shrink-0 text-xs opacity-50">
                  {t('歌单')} {userPlaylists.length}
                  {userPlaylistsMore ? '+' : ''}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {userPlaylistsLoading ? (
                  <div className="flex justify-center py-10">
                    <Spinner size={24} tip={t('正在加载')} />
                  </div>
                ) : userPlaylistsError ? (
                  <div className="px-3 py-10 text-center text-xs opacity-70">
                    {userPlaylistsError}
                  </div>
                ) : userPlaylists.length === 0 ? (
                  <div className="py-10 text-center text-xs opacity-60">
                    {t('TA 还没有公开歌单')}
                  </div>
                ) : (
                  userPlaylists.map((playlist) => userPlaylistRow(playlist))
                )}
              </div>
            </>
          ) : (
            <>
              <form
                className="flex items-center gap-2 px-4 py-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void runUserSearch(userInput)
                }}
              >
                <div
                  className="flex flex-1 items-center gap-2 rounded-full border px-3 py-1.5"
                  style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
                >
                  <Search className="h-4 w-4 opacity-60" />
                  <input
                    value={userInput}
                    onChange={(e) => setUserInput(e.target.value)}
                    placeholder={t('搜索网易云用户')}
                    className="w-full bg-transparent text-sm outline-none"
                  />
                </div>
                <Button type="submit" size="sm" disabled={usersLoading}>
                  {t('搜索')}
                </Button>
              </form>

              <div className="flex items-center gap-1.5 px-4 pb-2">
                <button
                  type="button"
                  className={cn(
                    'rounded-full px-3 py-1 text-xs transition',
                    !userQuery && userScope === 'follows'
                      ? 'bg-[var(--md-sys-color-primary)] text-white'
                      : 'bg-black/5 opacity-70 hover:opacity-100'
                  )}
                  onClick={() => switchUserScope('follows')}
                >
                  {t('我的关注')}
                </button>
                <button
                  type="button"
                  className={cn(
                    'rounded-full px-3 py-1 text-xs transition',
                    !userQuery && userScope === 'followers'
                      ? 'bg-[var(--md-sys-color-primary)] text-white'
                      : 'bg-black/5 opacity-70 hover:opacity-100'
                  )}
                  onClick={() => switchUserScope('followers')}
                >
                  {t('我的粉丝')}
                </button>
                <span className="ml-auto truncate text-[11px] opacity-50">
                  {userQuery
                    ? t('搜索「{{keyword}}」· {{count}} 人', {
                        keyword: userQuery,
                        count: userTotal,
                      })
                    : t('{{count}} 人', { count: userTotal })}
                </span>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {usersLoading ? (
                  <div className="flex justify-center py-10">
                    <Spinner size={24} tip={t('正在加载')} />
                  </div>
                ) : usersError ? (
                  <div className="px-3 py-10 text-center text-xs opacity-70">
                    {usersError}
                  </div>
                ) : users.length === 0 ? (
                  <div className="py-10 text-center text-xs opacity-60">
                    {userQuery
                      ? t('没有找到用户')
                      : userScope === 'follows'
                        ? t('还没有关注的人')
                        : t('还没有粉丝')}
                  </div>
                ) : (
                  users.map((user) => userRow(user))
                )}
              </div>
              <div
                className="border-t px-4 py-2 text-[11px] opacity-50"
                style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
              >
                {t('用户与歌单由当前房间共享的网易云账号读取')}
              </div>
            </>
          )
        ) : detailView ? (
          <>
            {/* 歌单 / 榜单详情头 */}
            <div className="flex items-center gap-2 px-4 py-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={detailView.onBack}
                aria-label={t('返回')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{detailView.title}</div>
                <div className="truncate text-xs opacity-60">{detailView.subtitle}</div>
              </div>
              <Button
                size="sm"
                disabled={adding || detailView.songs.length === 0}
                onClick={() => void addMany(detailView.songs, detailView.title)}
              >
                {adding ? t('添加中…') : t('全部添加')}
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {detailView.loading ? (
                <div className="flex justify-center py-10">
                  <Spinner size={24} tip={t('正在加载')} />
                </div>
              ) : detailView.songs.length === 0 ? (
                <div className="py-10 text-center text-xs opacity-60">
                  {t('该歌单没有可添加的歌曲')}
                </div>
              ) : (
                detailView.songs.map((song) => songRow(song))
              )}
            </div>
          </>
        ) : tab === 'playlist' ? (
          <>
            {/* 账号歌单列表 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {playlistsLoading ? (
                <div className="flex justify-center py-10">
                  <Spinner size={24} tip={t('正在加载')} />
                </div>
              ) : playlistsError ? (
                <div className="px-3 py-10 text-center text-xs opacity-70">
                  {playlistsError}
                </div>
              ) : playlists.length === 0 ? (
                <div className="py-10 text-center text-xs opacity-60">
                  {t('账号下还没有歌单')}
                </div>
              ) : (
                playlists.map((playlist) => (
                  <button
                    key={playlist.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-black/5"
                    onClick={() => void openPlaylist(playlist)}
                  >
                    {playlist.coverImgUrl ? (
                      <img
                        src={portableMusicCoverUrl(playlist.coverImgUrl)}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-lg object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-black/10">
                        <ListMusic className="h-4 w-4 opacity-50" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{playlist.name}</div>
                      <div className="text-xs opacity-60">
                        {t('共 {{count}} 首', { count: playlist.trackCount ?? 0 })}
                      </div>
                    </div>
                    {playlist.subscribed ? <Tag>{t('收藏')}</Tag> : null}
                  </button>
                ))
              )}
            </div>
            <div className="border-t px-4 py-2 text-[11px] opacity-50" style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}>
              {t('单个歌单一次最多添加 {{count}} 首', { count: PLAYLIST_ADD_LIMIT })}
            </div>
          </>
        ) : tab === 'toplist' ? (
          <>
            {/* 排行榜列表 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {toplistsLoading ? (
                <div className="flex justify-center py-10">
                  <Spinner size={24} tip={t('正在加载')} />
                </div>
              ) : toplistsError ? (
                <div className="px-3 py-10 text-center text-xs opacity-70">{toplistsError}</div>
              ) : toplists.length === 0 ? (
                <div className="py-10 text-center text-xs opacity-60">{t('暂无榜单')}</div>
              ) : (
                toplists.map((toplist) => (
                  <button
                    key={toplist.id}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-black/5"
                    onClick={() => void openToplist(toplist)}
                  >
                    {toplist.coverImgUrl ? (
                      <img
                        src={portableMusicCoverUrl(toplist.coverImgUrl)}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded-lg object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-black/10">
                        <Trophy className="h-4 w-4 opacity-50" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{toplist.name}</div>
                      <div className="truncate text-xs opacity-60">
                        {toplist.updateFrequency ?? t('排行榜')}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="border-t px-4 py-2 text-[11px] opacity-50" style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}>
              {t('单个歌单一次最多添加 {{count}} 首', { count: PLAYLIST_ADD_LIMIT })}
            </div>
          </>
        ) : (
          <>
            {/* 每日推荐 */}
            <div className="flex items-center gap-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Sparkles className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
                  {t('每日推荐')}
                </div>
                <div className="text-xs opacity-60">
                  {t('共 {{count}} 首', { count: dailySongs.length })}
                </div>
              </div>
              <Button
                size="sm"
                disabled={adding || dailySongs.length === 0}
                onClick={() => void addMany(dailySongs, t('每日推荐'))}
              >
                {adding ? t('添加中…') : t('全部添加')}
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {dailyLoading ? (
                <div className="flex justify-center py-10">
                  <Spinner size={24} tip={t('正在加载')} />
                </div>
              ) : dailyError ? (
                <div className="px-3 py-10 text-center text-xs opacity-70">{dailyError}</div>
              ) : dailySongs.length === 0 ? (
                <div className="py-10 text-center text-xs opacity-60">{t('暂无推荐歌曲')}</div>
              ) : (
                dailySongs.map((song) => songRow(song))
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    container ?? document.body
  )
}
