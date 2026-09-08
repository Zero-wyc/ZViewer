/**
 * 私人漫游页（Hydrogen PersonalFMPage + PersonalFM 范式）。
 *
 * 结构：
 * - 头部：黑底白字「PERSONAL FM」小标（fm-headline）+ 大标题「私人漫游」+
 *   副标题「根据你的音乐喜好为你推荐」
 * - 中部：大封面（中心卡 + fm-play-overlay 播放图标）+ 歌名（大字）/歌手/专辑
 * - 底部操作行：上一首 SkipBack、不喜欢 Trash2（fm_trash 后刷新）、
 *   喜欢 Heart（本地激活红）、下一首 SkipForward
 *
 * 权限：canControl（房主或房主离线）时可直接操作；观众无权限时按钮隐藏，
 * 显示「由房主控制漫游」提示。播放 = 把 FM 歌曲经 queue-upsert 加入队列并
 * playSong（条目可不带 id/order，仅要求可定位来源）。
 * 数据：/personal_fm 拉一批缓存本地（候选池），未登录提示登录。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Heart, Play, Pause, SkipBack, SkipForward, Trash2 } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet, apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import type { NcmSong } from '../types'
import { cn } from '@/lib/utils'
import { MusicLoginGate, PageBlockHeader } from './MusicLoginGate'

export interface MusicFmPageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）——FM 播放需经 queue-upsert */
  canManage: boolean
}

/** /personal_fm 响应条目（网易云结构：artists/album/duration） */
interface FmSongItem {
  id: number
  name: string
  artists?: Array<{ name?: string }>
  album?: { name?: string; picUrl?: string }
  duration?: number
}

/** FmSongItem → NcmSong */
function mapFmSong(item: FmSongItem): NcmSong {
  return {
    songId: item.id,
    name: item.name,
    artist: (item.artists ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(' / '),
    album: item.album?.name ?? '',
    cover: item.album?.picUrl ?? '',
    durationMs: item.duration ?? 0,
    vip: false,
  }
}

export function MusicFmPage({ socket, roomId }: MusicFmPageProps) {
  const loginStatus = useMusicStore((s) => s.loginStatus)
  const currentKey = useMusicStore((s) => s.currentKey)
  const isPlaying = useMusicStore((s) => s.isPlaying)
  const { playSong, togglePlay, canControl } = useMusicPlayer()

  /** 候选池（待播放的 FM 歌曲队列） */
  const [pool, setPool] = useState<NcmSong[]>([])
  /** 已播放历史（上一首回退用） */
  const [history, setHistory] = useState<NcmSong[]>([])
  /** 页面视图中的当前 FM 歌曲（与播放器 currentKey 对齐） */
  const [current, setCurrent] = useState<NcmSong | null>(null)
  /** 本地「喜欢」集合（会话内视觉态，不下发 API） */
  const [liked, setLiked] = useState<Set<number>>(() => new Set())
  /** 候选池拉取中（渲染用） */
  const [poolLoading, setPoolLoading] = useState(false)
  /** 候选池并发互斥（不参与渲染） */
  const loadingRef = useRef(false)

  /** 拉取一批 FM 候选（/personal_fm，约 3 首） */
  const fetchPool = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    setPoolLoading(true)
    try {
      const { data } = await apiGet<{ data?: FmSongItem[] }>(
        '/api/music/ncm/personal_fm'
      )
      const list = Array.isArray(data?.data) ? data.data : []
      if (list.length > 0) {
        setPool((prev) => {
          const seen = new Set(prev.map((s) => s.songId))
          const mapped = list
            .map(mapFmSong)
            .filter((s) => s.songId > 0 && !seen.has(s.songId))
          return [...prev, ...mapped]
        })
      }
    } catch (err) {
      console.error('[MusicFmPage] 私人漫游获取失败:', err)
    } finally {
      loadingRef.current = false
      setPoolLoading(false)
    }
  }, [])

  // 登录后拉取首批候选
  useEffect(() => {
    if (!loginStatus.loggedIn) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求（fetchPool 内 setState 均在异步回调中）
    void fetchPool()
  }, [loginStatus.loggedIn, fetchPool])

  /** 把 FM 歌曲加入队列并立即播放（canControl 语义，后端校验房主/房管） */
  const playFmSong = useCallback(
    (song: NcmSong) => {
      if (!socket || !roomId) {
        message.error('未连接房间')
        return
      }
      socket.emit(
        'music:queue-upsert',
        {
          roomId,
          item: {
            songId: song.songId,
            source: 'ncm',
            sourceId: null,
            name: song.name,
            artist: song.artist,
            album: song.album,
            cover: song.cover,
            durationMs: song.durationMs,
            vip: false,
          },
        },
        (response: { success?: boolean; message?: string }) => {
          if (response && response.success === false) {
            message.error(response.message || '加入队列失败')
          }
        }
      )
      playSong({
        id: -1,
        roomId: roomId,
        songId: song.songId,
        source: 'ncm',
        sourceId: null,
        name: song.name,
        artist: song.artist,
        album: song.album,
        cover: song.cover,
        durationMs: song.durationMs,
        vip: false,
        order: 0,
        addedBy: '',
      })
      setCurrent(song)
    },
    [socket, roomId, playSong]
  )

  /** 播放下一首：候选池出队 → upsert + playSong */
  const handleNext = useCallback(() => {
    if (!canControl) return
    // 候选池低水位：先补一批
    if (pool.length < 2) void fetchPool()
    const [next, ...rest] = pool
    if (!next) {
      message.info('漫游候选获取中，请稍后再试')
      return
    }
    setPool(rest)
    if (current) setHistory((prev) => [...prev, current])
    playFmSong(next)
  }, [canControl, pool, current, fetchPool, playFmSong])

  /** 上一首：沿已播放历史回退 */
  const handlePrev = useCallback(() => {
    if (!canControl) return
    if (history.length === 0) {
      message.info('没有上一首了')
      return
    }
    const prev = history[history.length - 1]
    setHistory((list) => list.slice(0, -1))
    if (current) setPool((p) => [current, ...p])
    playFmSong(prev)
  }, [canControl, history, current, playFmSong])

  /** 大封面播放按钮：已在播当前曲则切播放/暂停，否则播放下一首 */
  const handleCoverPlay = useCallback(() => {
    if (!canControl) return
    if (current && currentKey === `ncm:${current.songId}`) {
      togglePlay()
      return
    }
    handleNext()
  }, [canControl, current, currentKey, togglePlay, handleNext])

  /** 不喜欢：fm_trash 下发 + 本地移出 + 自动切下一首 */
  const handleTrash = useCallback(async () => {
    if (!canControl || !current) return
    try {
      await apiPost(`/api/music/ncm/fm_trash?songId=${current.songId}`)
      message.success('已减少类似歌曲推荐')
    } catch (err) {
      console.error('[MusicFmPage] fm_trash 失败:', err)
    }
    if (current) setHistory((prev) => [...prev, current])
    handleNext()
  }, [canControl, current, handleNext])

  /** 喜欢（本地视觉态） */
  const toggleLike = () => {
    if (!current) return
    setLiked((prev) => {
      const next = new Set(prev)
      if (next.has(current.songId)) next.delete(current.songId)
      else next.add(current.songId)
      return next
    })
  }

  if (!loginStatus.loggedIn) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        <PageBlockHeader titleEN="PERSONAL FM" titleCN="私人漫游" />
        <MusicLoginGate hint="登录后开启专属音乐漫游" />
      </div>
    )
  }

  const cover = current?.cover

  return (
    <div className="flex min-h-full flex-col items-center px-6 pb-32 pt-6 md:px-8">
      <PageBlockHeader titleEN="PERSONAL FM" titleCN="私人漫游" />
      <span className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
        根据你的音乐喜好为你推荐
      </span>

      {/* 观众无权限提示 */}
      {!canControl && (
        <div
          className="mt-4 rounded-full px-3 py-1 text-xs"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-tertiary) 12%, transparent)',
            color: 'var(--md-sys-color-tertiary)',
          }}
        >
          由房主控制漫游
        </div>
      )}

      {/* 中部：大封面 + 歌曲信息（候选池加载中/无歌时占位） */}
      <div className="mt-8 flex w-full max-w-[560px] flex-col items-center gap-5">
        <button
          type="button"
          className="relative block w-56 overflow-hidden border p-1.5 transition-colors"
          style={{
            borderColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent)',
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent)',
          }}
          onClick={handleCoverPlay}
          disabled={!canControl}
          title={canControl ? (isPlaying ? '暂停' : '播放') : undefined}
          aria-label={canControl ? (isPlaying ? '暂停' : '播放') : '播放'}
        >
          {cover ? (
            <img
              src={cover}
              alt=""
              className="block aspect-square w-full object-cover"
            />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {poolLoading ? '正在准备…' : '暂无漫游歌曲'}
            </div>
          )}
          {/* fm-play-overlay：播放/暂停图标 */}
          {canControl && current && (
            <span
              className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center border transition-transform duration-200 hover:scale-105"
              style={{
                backgroundColor: 'color-mix(in srgb, black 72%, transparent)',
                borderColor: 'color-mix(in srgb, black 24%, transparent)',
              }}
            >
              {isPlaying && currentKey === `ncm:${current.songId}` ? (
                <Pause className="h-8 w-8 text-white" />
              ) : (
                <Play className="h-8 w-8 text-white" />
              )}
            </span>
          )}
        </button>

        {/* 歌名 / 歌手 / 专辑（大字居中） */}
        {current ? (
          <div className="text-center">
            <h2
              className="text-2xl font-bold text-[var(--md-sys-color-on-surface)]"
              title={current.name}
            >
              {current.name}
            </h2>
            <p className="mt-1.5 text-sm text-[var(--md-sys-color-on-surface-variant)]">
              {current.artist}
            </p>
            {current.album && (
              <p className="mt-0.5 text-xs text-[var(--md-sys-color-on-surface-variant)] opacity-80">
                {current.album}
              </p>
            )}
          </div>
        ) : (
          <div className="text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
            点击封面开始漫游
          </div>
        )}

        {/* 底部操作行（无权限时隐藏） */}
        {canControl && current && (
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              className="flex h-9 min-w-16 items-center justify-center border text-[var(--md-sys-color-on-surface)] transition-transform hover:-translate-y-px hover:opacity-80 active:scale-95"
              style={{
                backgroundColor: 'var(--md-sys-color-on-surface)',
                color: 'var(--md-sys-color-surface)',
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent)',
              }}
              onClick={handlePrev}
              title="上一首"
              aria-label="上一首"
            >
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="flex h-9 min-w-16 items-center justify-center border text-[var(--md-sys-color-on-surface)] transition-transform hover:-translate-y-px hover:opacity-80 active:scale-95"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent)',
              }}
              onClick={() => void handleTrash()}
              title="不喜欢"
              aria-label="不喜欢"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={cn(
                'flex h-9 min-w-16 items-center justify-center border transition-transform hover:-translate-y-px hover:opacity-80 active:scale-95'
              )}
              style={{
                backgroundColor:
                  current && liked.has(current.songId)
                    ? 'color-mix(in srgb, var(--md-sys-color-error) 12%, transparent)'
                    : 'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
                borderColor:
                  current && liked.has(current.songId)
                    ? 'var(--md-sys-color-error)'
                    : 'color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent)',
                color:
                  current && liked.has(current.songId)
                    ? 'var(--md-sys-color-error)'
                    : 'var(--md-sys-color-on-surface)',
              }}
              onClick={toggleLike}
              title="喜欢"
              aria-label="喜欢"
            >
              <Heart
                className={cn(
                  'h-4 w-4',
                  current && liked.has(current.songId) && 'fill-current'
                )}
              />
            </button>
            <button
              type="button"
              className="flex h-9 min-w-16 items-center justify-center border text-[var(--md-sys-color-on-surface)] transition-transform hover:-translate-y-px hover:opacity-80 active:scale-95"
              style={{
                backgroundColor: 'var(--md-sys-color-on-surface)',
                color: 'var(--md-sys-color-surface)',
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent)',
              }}
              onClick={handleNext}
              title="下一首"
              aria-label="下一首"
            >
              <SkipForward className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
