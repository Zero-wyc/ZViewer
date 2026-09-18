/**
 * 「在网易云搜索」弹窗（B站 歌曲快捷收藏）。
 *
 * 入口：B站 歌词页工具栏 + 音乐分区视频封面按钮（用户在 B站 听到好歌后
 * 快速在网易云收藏）。
 *
 * - 打开时自动从 B站 视频标题提取歌曲名（启发式：剥离【】[]（）括号
 *   标签与 4K/高清/MV 等噪声词、按 -｜/ 分隔取主段），填入关键词并自动
 *   搜索网易云（/api/music/ncm/cloudsearch，老 /search 兜底，双结构兼容）
 * - 结果列表（封面/歌名/歌手/时长）+ 每行两个操作：
 *   试听 = 本地 Audio 播放 /api/music/stream（standard 音质；不进房间
 *   队列、不打扰一起听的其他人）；收藏 = 直接加入当前登录网易云账号的
 *   「我喜欢的音乐」（用户歌单中 specialType===5 或名称匹配，走
 *   /playlist/tracks op=add，不弹歌单选择面板；未登录/未找到时提示）
 * - 视觉：黑底 + 高斯模糊（歌词页设置弹窗同语言，四角白色方块点缀），
 *   屏幕居中锚定——展开动画（cloud-add-in 宽→高两段式 + 标题/水印分级
 *   淡入）以面板中心为原点向四周舒展，内容同样延后到展开结束再挂载
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Heart,
  Loader2,
  Music,
  Pause,
  Play,
  Search,
  SearchX,
} from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import { prefetchUserPlaylists } from '../userPlaylists'
import { extractSongTitle } from '../utils/songTitle'
import { cn } from '@/lib/utils'

interface NcmSearchModalProps {
  open: boolean
  /** B站 视频标题（自动提取歌曲名的来源） */
  sourceTitle: string
  onClose: () => void
}

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

interface NcmSongLite {
  songId: number
  name: string
  artist: string
  cover: string
  durationMs: number
  vip: boolean
}

/** 搜索结果条数上限 */
const SEARCH_LIMIT = 20

/** 毫秒 → mm:ss（无数据 --:--） */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 搜索条目 → 精简结构（双结构兼容，与 MusicSearchPage.mapSong 同思路） */
function mapSong(song: CloudsearchSong): NcmSongLite {
  return {
    songId: song.id,
    name: song.name,
    artist: (song.ar ?? song.artists ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(' / '),
    cover: song.al?.picUrl ?? song.album?.picUrl ?? '',
    durationMs: song.dt ?? song.duration ?? 0,
    vip: song.fee === 1 || song.fee === 4,
  }
}

export function NcmSearchModal({
  open,
  sourceTitle,
  onClose,
}: NcmSearchModalProps) {
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<NcmSongLite[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  /** 面板展开动画是否已结束（列表内容延后挂载，防中途渲染掉帧） */
  const [unfoldDone, setUnfoldDone] = useState(false)
  /** 当前试听中的歌曲（本地 Audio，不进房间队列） */
  const [auditionId, setAuditionId] = useState<number | null>(null)
  const auditionRef = useRef<HTMLAudioElement | null>(null)
  /** 正在收藏的歌曲 id（行内 busy 态，防重复点击） */
  const [favBusyId, setFavBusyId] = useState<number | null>(null)
  /** 搜索竞态序号（过期响应丢弃） */
  const searchSeqRef = useRef(0)

  const stopAudition = useCallback(() => {
    auditionRef.current?.pause()
    auditionRef.current = null
    setAuditionId(null)
  }, [])

  /** 搜索网易云（cloudsearch 主端点 + 老 /search 兜底，双结构兼容） */
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
      console.error('[NcmSearchModal] 搜索失败:', err)
      if (seq !== searchSeqRef.current) return
      message.error('搜索失败，请稍后重试')
      setResults([])
      setSearched(true)
    } finally {
      if (seq === searchSeqRef.current) setSearching(false)
    }
  }, [])

  // 打开（上升沿）：提取歌名 → 填关键词 → 自动搜索。
  // 仅在 open false→true 的瞬间初始化——open 期间 sourceTitle 变化（如
  // 自动连播切歌）不重跑，避免清掉用户已输入的关键词；初始化走
  // setTimeout(0) 规避 effect 内同步 setState
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (!open || wasOpenRef.current) return
    wasOpenRef.current = true
    const timer = setTimeout(() => {
      const kw = extractSongTitle(sourceTitle)
      setKeyword(kw)
      setUnfoldDone(false)
      if (kw) void runSearch(kw)
    }, 0)
    return () => {
      clearTimeout(timer)
      // StrictMode 双挂载 / 依赖变化重跑时复位标记，保证初始化必然执行
      wasOpenRef.current = false
    }
  }, [open, sourceTitle, runSearch])

  // 关闭：复位 + 停试听（setTimeout(0) 规避 effect 内同步 setState）
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => {
      wasOpenRef.current = false
      stopAudition()
      setResults([])
      setSearched(false)
      setFavBusyId(null)
    }, 0)
    return () => clearTimeout(timer)
  }, [open, stopAudition])

  /** 试听开关：本地 Audio 播放 standard 音质（点同一首 = 停止） */
  const toggleAudition = useCallback(
    (song: NcmSongLite) => {
      if (auditionRef.current) {
        auditionRef.current.pause()
        auditionRef.current = null
        if (auditionId === song.songId) {
          setAuditionId(null)
          return
        }
      }
      const audio = new Audio(
        `/api/music/stream?songId=${song.songId}&level=standard`
      )
      audio.volume = 0.8
      audio.onerror = () => {
        message.error(song.vip ? 'VIP 歌曲需登录后试听' : '试听失败')
        if (auditionRef.current === audio) {
          auditionRef.current = null
          setAuditionId(null)
        }
      }
      auditionRef.current = audio
      setAuditionId(song.songId)
      void audio.play().catch(() => {
        if (auditionRef.current === audio) {
          auditionRef.current = null
          setAuditionId(null)
        }
      })
    },
    [auditionId]
  )

  /** 收藏：直接加入当前账号「我喜欢的音乐」（用户歌单 specialType===5
   *  或名称匹配；502 = 已存在视为成功），不弹歌单选择面板 */
  const favoriteToLiked = useCallback(
    async (song: NcmSongLite) => {
      if (favBusyId != null) return
      setFavBusyId(song.songId)
      try {
        const playlists = await prefetchUserPlaylists()
        const liked = playlists.find(
          (p) => p.specialType === 5 || p.name.includes('喜欢的音乐')
        )
        if (!liked) {
          message.error('未找到「我喜欢的音乐」歌单，请确认已登录网易云账号')
          return
        }
        const { data } = await apiPost<{
          code?: number
          body?: { code?: number }
        }>(`/api/music/ncm/playlist/tracks?timestamp=${Date.now()}`, {
          op: 'add',
          pid: liked.id,
          tracks: String(song.songId),
        })
        const code = data?.code ?? data?.body?.code
        if (code === 200 || code === 502) {
          message.success(
            code === 502 ? '已在我喜欢的音乐中' : '已添加到我喜欢的音乐'
          )
        } else {
          message.error('收藏失败')
        }
      } catch (err) {
        console.error('[NcmSearchModal] 收藏到我喜欢的音乐失败:', err)
        message.error('收藏失败，请确认已登录网易云账号')
      } finally {
        setFavBusyId(null)
      }
    },
    [favBusyId]
  )

  if (!open) return null

  return createPortal(
    /* 蒙层（黑半透明，同歌词页设置弹窗；z-85 低于添加到歌单面板的 z-90：
        收藏面板叠于本弹窗之上） */
    <div
      className="fixed inset-0 z-[85]"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.4)' }}
      onClick={onClose}
    >
      {/* 面板：黑底 + 高斯模糊（歌词页设置弹窗同视觉），屏幕居中锚定——
          展开动画（宽→高两段式）以中心为原点向四周舒展，而非自底向上 */}
      <div
        className="absolute overflow-hidden"
        style={
          {
            left: '50%',
            top: '50%',
            width: 300,
            height: 'min(500px, calc(100vh - 160px))',
            transform: 'translate(-50%, -50%)',
            '--add-panel-h': 'min(500px, calc(100vh - 160px))',
            animation: 'cloud-add-in 0.4s 0.1s both',
            backgroundColor: 'rgba(8, 8, 8, 0.86)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '0.5px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)',
          } as React.CSSProperties
        }
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={(e) => {
          if (
            e.target === e.currentTarget &&
            e.animationName === 'cloud-add-in'
          ) {
            setUnfoldDone(true)
          }
        }}
      >
        {/* 四角白色方块点缀（歌词页设置弹窗同款装饰） */}
        <span
          aria-hidden="true"
          className="absolute left-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 left-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 z-[2] h-2 w-2 bg-white"
        />

        {/* 内容层（独立裁剪；展开期间内容不外溢） */}
        <div className="absolute inset-0 flex flex-col overflow-hidden">
          {/* 水印 */}
          <div
            className="pointer-events-none absolute left-5 top-9 select-none text-[52px] font-bold leading-none"
            style={{
              color: 'rgba(255, 255, 255, 0.08)',
              animation: 'cloud-add-watermark-in 0.2s 0.35s both',
            }}
            aria-hidden="true"
          >
            SEARCH
          </div>

          {/* 标题（0.5s 延迟淡入，Hydrogen .add-title-in 同节奏） */}
          <div
            className="relative z-[1] mt-7 shrink-0 text-center text-[15px] font-bold text-white"
            style={{ animation: 'cloud-add-title-in 0.2s 0.25s both' }}
          >
            在网易云搜索
          </div>

          {/* 关键词输入（自动提取结果可手动修正；Enter 或放大镜重新搜索） */}
          {unfoldDone && (
            <div className="relative z-[1] mx-6 mt-3 flex shrink-0 items-center gap-1.5">
              <input
                type="text"
                value={keyword}
                autoFocus
                autoComplete="off"
                placeholder="歌曲名"
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch(keyword)
                }}
                className="h-8 min-w-0 flex-1 border bg-transparent px-2.5 text-xs text-white outline-none placeholder:text-white/40"
                style={{
                  borderColor: 'rgba(255, 255, 255, 0.4)',
                  caretColor: '#ffffff',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#ffffff'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.4)'
                }}
              />
              <button
                type="button"
                onClick={() => void runSearch(keyword)}
                disabled={searching}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-white transition-colors hover:bg-white/10 disabled:opacity-40"
                style={{ borderColor: 'rgba(255, 255, 255, 0.4)' }}
                title="搜索"
                aria-label="搜索"
              >
                {searching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
              </button>
            </div>
          )}

          {/* 结果列表（延后到展开动画结束挂载） */}
          <div className="relative z-[1] mt-3 min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {unfoldDone && searching && results.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-white/55">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在搜索…
              </div>
            )}
            {unfoldDone && !searching && searched && results.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-xs text-white/55">
                <SearchX className="h-5 w-5 opacity-40" />
                未找到相关歌曲，换个关键词试试
              </div>
            )}
            {unfoldDone &&
              results.map((song) => {
                const auditioning = auditionId === song.songId
                return (
                  <div
                    key={song.songId}
                    className="flex items-center gap-2.5 rounded py-1.5 pr-1 transition-colors hover:bg-white/10"
                  >
                    {/* 封面 */}
                    <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-sm bg-white/8">
                      {song.cover ? (
                        <img
                          src={`${song.cover}?param=80y80`}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center">
                          <Music className="h-4 w-4 opacity-40" />
                        </span>
                      )}
                    </span>
                    {/* 歌名 + 歌手 */}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate text-xs font-bold text-white">
                          {song.name}
                        </span>
                        {song.vip && (
                          <span className="shrink-0 rounded border border-white/40 px-0.5 text-[9px] font-bold leading-tight text-white/55">
                            VIP
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[10px] text-white/55">
                        {song.artist || '—'}
                      </span>
                    </span>
                    {/* 时长 */}
                    <span className="shrink-0 text-[10px] tabular-nums text-white/55">
                      {formatDurationMs(song.durationMs)}
                    </span>
                    {/* 操作：试听 / 收藏 */}
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => toggleAudition(song)}
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded text-white transition-colors hover:bg-white/15',
                          auditioning && 'bg-white/15'
                        )}
                        title={auditioning ? '停止试听' : '试听'}
                        aria-label={auditioning ? '停止试听' : '试听'}
                      >
                        {auditioning ? (
                          <Pause className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={favBusyId != null}
                        onClick={() => void favoriteToLiked(song)}
                        className="flex h-6 w-6 items-center justify-center rounded text-white transition-colors hover:bg-white/15 disabled:opacity-60"
                        title="收藏到我喜欢的音乐"
                        aria-label="收藏到我喜欢的音乐"
                      >
                        {favBusyId === song.songId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Heart className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </span>
                  </div>
                )
              })}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
