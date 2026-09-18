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
 *   队列、不打扰一起听的其他人）；收藏 = 打开「添加到我的歌单」面板
 *   （AddToPlaylistModal 复用，z 更高叠于本弹窗之上，选完歌单回本弹窗）
 * - 视觉与展开动画完全沿用「添加到我的歌单」面板（glass-card +
 *   cloud-add-in 两段式展开 + 标题/水印分级淡入），内容同样延后到展开
 *   结束再挂载，动画期间零渲染抢帧
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
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { AddToPlaylistModal } from './AddToPlaylistModal'
import { prefetchUserPlaylists } from '../userPlaylists'
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

/**
 * 从 B站 视频标题提取歌曲名（启发式）：
 * 剥离【】[]（）() 括号标签（4K/MV/官方等引流噪声多在其中，书名号《》
 * 内常是歌名故保留）、清洗常见画质/版本噪声词、按 -｜/ 分隔取主段。
 * 提取结果仅作初始关键词，输入框可手动修正。
 */
function extractSongTitle(rawTitle: string): string {
  let t = rawTitle
  t = t.replace(/【[^】]*】/g, ' ')
  t = t.replace(/\[[^\]]*\]/g, ' ')
  t = t.replace(/《([^》]*)》/g, ' $1 ')
  t = t.replace(/（[^）]*）/g, ' ')
  t = t.replace(/\([^)]*\)/g, ' ')
  t = t.replace(
    /\b(4K|8K|1080P|720P|480P|60FPS|60fps|120FPS|Hi-?Res|无损|高清|蓝光|MV|PV|官方|纯享|完整版|正片|Live)\b/gi,
    ' '
  )
  t = (t.split(/[|｜/／]/)[0] ?? t).split(/\s*[-–—]\s*/)[0] ?? t
  return t.replace(/\s+/g, ' ').trim()
}

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
  /** 收藏目标（非空时叠开「添加到我的歌单」面板） */
  const [favSong, setFavSong] = useState<{
    songId: number
    name: string
  } | null>(null)
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

  // 打开：提取歌名 → 填关键词 → 自动搜索
  useEffect(() => {
    if (!open) return
    const kw = extractSongTitle(sourceTitle)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗打开驱动（提取关键词并自动搜索）
    setKeyword(kw)

    setUnfoldDone(false)
    if (kw) void runSearch(kw)
  }, [open, sourceTitle, runSearch])

  // 关闭：复位 + 停试听
  useEffect(() => {
    if (open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 弹窗关闭复位内部态
    stopAudition()
    setResults([])
    setSearched(false)
    setFavSong(null)
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

  /** 收藏：预取歌单缓存并叠开「添加到我的歌单」面板 */
  const openFavorite = useCallback((song: NcmSongLite) => {
    void prefetchUserPlaylists()
    setFavSong({ songId: song.songId, name: song.name })
  }, [])

  if (!open) return null

  return createPortal(
    /* 蒙层（z-85 低于添加到歌单面板的 z-90：收藏面板叠于本弹窗之上） */
    <div
      className="fixed inset-0 z-[85]"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)' }}
      onClick={onClose}
    >
      {/* 面板（与添加到歌单面板同款展开动画：0.3s 延迟后先横向再纵向） */}
      <div
        className="glass-card absolute"
        style={
          {
            left: '50%',
            bottom: 124,
            width: 300,
            height: 'min(500px, calc(100vh - 160px))',
            transform: 'translateX(-50%)',
            '--add-panel-h': 'min(500px, calc(100vh - 160px))',
            animation: 'cloud-add-in 0.6s 0.3s both',
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
        {/* 内容层（独立裁剪；展开期间内容不外溢） */}
        <div className="absolute inset-0 flex flex-col overflow-hidden">
          {/* 水印 */}
          <div
            className="pointer-events-none absolute left-5 top-9 select-none text-[52px] font-bold leading-none"
            style={{
              color:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
              animation: 'cloud-add-watermark-in 0.3s 0.6s both',
            }}
            aria-hidden="true"
          >
            SEARCH
          </div>

          {/* 标题（0.5s 延迟淡入，Hydrogen .add-title-in 同节奏） */}
          <div
            className="relative z-[1] mt-7 shrink-0 text-center text-[15px] font-bold"
            style={{
              color: 'var(--md-sys-color-on-surface)',
              animation: 'cloud-add-title-in 0.3s 0.5s both',
            }}
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
                placeholder="歌曲名"
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch(keyword)
                }}
                className="h-8 min-w-0 flex-1 border bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)] px-2.5 text-xs outline-none"
                style={{
                  borderColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)',
                  color: 'var(--md-sys-color-on-surface)',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor =
                    'var(--md-sys-color-on-surface)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor =
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)'
                }}
              />
              <button
                type="button"
                onClick={() => void runSearch(keyword)}
                disabled={searching}
                className="flex h-8 w-8 shrink-0 items-center justify-center transition-opacity hover:opacity-85 disabled:opacity-40"
                style={{
                  backgroundColor: 'var(--md-sys-color-primary)',
                  color: 'var(--md-sys-color-on-primary)',
                }}
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
              <div
                className="flex items-center justify-center gap-2 py-10 text-xs"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在搜索…
              </div>
            )}
            {unfoldDone && !searching && searched && results.length === 0 && (
              <div
                className="flex flex-col items-center justify-center gap-2 py-10 text-center text-xs"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
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
                    className="flex items-center gap-2.5 rounded py-1.5 pr-1 transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]"
                  >
                    {/* 封面 */}
                    <span
                      className="relative h-10 w-10 shrink-0 overflow-hidden rounded-sm"
                      style={{
                        backgroundColor:
                          'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                      }}
                    >
                      {song.cover ? (
                        <img
                          src={`${song.cover}?param=80y80`}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center">
                          <Music
                            className="h-4 w-4 opacity-40"
                            style={{
                              color: 'var(--md-sys-color-on-surface-variant)',
                            }}
                          />
                        </span>
                      )}
                    </span>
                    {/* 歌名 + 歌手 */}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span
                          className="truncate text-xs font-bold"
                          style={{ color: 'var(--md-sys-color-on-surface)' }}
                        >
                          {song.name}
                        </span>
                        {song.vip && (
                          <span
                            className="shrink-0 rounded border px-0.5 text-[9px] font-bold leading-tight"
                            style={{
                              borderColor:
                                'color-mix(in srgb, var(--md-sys-color-on-surface) 40%, transparent)',
                              color: 'var(--md-sys-color-on-surface-variant)',
                            }}
                          >
                            VIP
                          </span>
                        )}
                      </span>
                      <span
                        className="block truncate text-[10px]"
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      >
                        {song.artist || '—'}
                      </span>
                    </span>
                    {/* 时长 */}
                    <span
                      className="shrink-0 text-[10px] tabular-nums"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      {formatDurationMs(song.durationMs)}
                    </span>
                    {/* 操作：试听 / 收藏 */}
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => toggleAudition(song)}
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_12%,transparent)]',
                          auditioning &&
                            'bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_12%,transparent)]'
                        )}
                        style={{ color: 'var(--md-sys-color-on-surface)' }}
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
                        onClick={() => openFavorite(song)}
                        className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_12%,transparent)]"
                        style={{ color: 'var(--md-sys-color-on-surface)' }}
                        title="收藏到歌单"
                        aria-label="收藏到歌单"
                      >
                        <Heart className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                )
              })}
          </div>
        </div>
      </div>

      {/* 收藏目标（叠开添加到歌单面板；成功后回本弹窗） */}
      <AddToPlaylistModal
        open={favSong != null}
        song={favSong}
        onClose={() => setFavSong(null)}
      />
    </div>,
    document.body
  )
}
