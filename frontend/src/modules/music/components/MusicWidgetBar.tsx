/**
 * 底部播放控制栏（Hydrogen MusicWidget 1:1 复刻，fixed 悬浮范式）。
 *
 * 悬浮形态（移植 Hydrogen .musicWidget 规格）：fixed 水平居中 + 底距 35px +
 * 定宽 722px × 高 65px + 弥散阴影；容器由 MusicAppShell 提供，本组件只负责
 * 卡片本体（M3 适配：glass 玻璃质感 + 圆角）。
 *
 * 结构（Hydrogen flex row：左信息区自适应 + 右固定 476px）：
 * - 顶部细进度条：absolute top-0 + translateY(-50%) 骑边定位（Hydrogen
 *   .music-progress-container 方案），2.5px → hover 13px 过渡，primary 填充；
 *   hover 显示「当前 / 总时长」白字（9px，条上方悬浮，Hydrogen .music-time）；
 *   canControl 可拖动 seek，观众只读
 * - 左 music-info（ml 17px）：封面 45px（0.5px 边框，点击 → 完整播放器覆盖层；
 *   hover 黑色遮罩 + 上箭头从底部滑入，Hydrogen .open-player）+ 歌名（14px bold，
 *   OverflowMarquee 跑马灯）+ 歌手（10px，单行截断）
 * - 右 music-right（476px 定宽）：
 *   - music-control（126px）：prev / play-pause / next —— Hydrogen 线条式
 *     SVG（< 形箭头 + 描边三角 + 两竖线 pause，stroke 8/200）原样移植
 *   - music-volume（120px）：7px 描边滑条（border 1px + 0.5px shadow）+
 *     上方 VOLUME 标签（8px）与数字；仅本地生效
 *   - music-other（230px，space-evenly，5 × 20px 图标）：喜欢（描边心/红心，
 *     NCM 登录可见）、添加到歌单（圆圈加号，Hydrogen addToPlaylist：弹窗选择
 *     自建歌单后 POST /playlist/tracks，个人操作登录即可）、专辑（唱片，
 *     Hydrogen toAlbum：解析当前歌 al.id 跳转专辑详情页）、播放模式
 *     （顺序/单曲/随机 3 态循环，canControl）、队列弹窗
 * - widget-back：右上角 5px 圆点装饰（Hydrogen 同款）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CirclePlus,
  Disc3,
  Heart,
  ListMusic,
  Repeat,
  Repeat1,
  Shuffle,
} from 'lucide-react'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { OverflowMarquee } from './OverflowMarquee'
import {
  ControlNextIcon,
  ControlPauseIcon,
  ControlPlayIcon,
  ControlPrevIcon,
} from './PlayerControlIcons'
import { AddToPlaylistModal } from './AddToPlaylistModal'
import type { PlayMode } from '../types'
import { cn, formatDuration } from '@/lib/utils'

/** 播放模式循环顺序（Hydrogen changePlayMode 3 态） */
const PLAY_MODE_ORDER: PlayMode[] = ['sequence', 'repeat-one', 'shuffle']

export function MusicWidgetBar() {
  const {
    togglePlay,
    next,
    prev,
    seek,
    requestControl,
    canControl,
    currentSong,
    isPlaying,
    positionSec,
    playMode,
    setPlayMode,
    volume,
    setVolume,
  } = useMusicPlayer()

  const setPlayerOverlayOpen = useMusicStore((s) => s.setPlayerOverlayOpen)
  const setQueuePopupOpen = useMusicStore((s) => s.setQueuePopupOpen)
  const setPendingAlbumDetail = useMusicStore((s) => s.setPendingAlbumDetail)
  const setPage = useMusicStore((s) => s.setPage)
  const loginStatus = useMusicStore((s) => s.loginStatus)

  // ===== 进度条（细滑块；canControl 可拖动 seek，观众只读展示） =====
  const durationSec = currentSong ? currentSong.durationMs / 1000 : 0
  const progressRatio =
    durationSec > 0 ? Math.min(1, Math.max(0, positionSec / durationSec)) : 0
  const progressRef = useRef<HTMLDivElement>(null)

  const computeTimeFromClientX = useCallback(
    (clientX: number): number => {
      const el = progressRef.current
      if (!el || durationSec <= 0) return 0
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return 0
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return ratio * durationSec
    },
    [durationSec]
  )

  const handleProgressPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!canControl || durationSec <= 0) return
      e.preventDefault()
      e.stopPropagation()
      seek(computeTimeFromClientX(e.clientX))
      const handleMove = (ev: PointerEvent) => {
        seek(computeTimeFromClientX(ev.clientX))
      }
      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [canControl, durationSec, seek, computeTimeFromClientX]
  )

  // ===== 控制按钮（观众点击走申请，房主/房主离线 canControl 直接控制） =====
  const handlePlayPause = useCallback(() => {
    if (canControl) togglePlay()
    else requestControl(isPlaying ? 'pause' : 'play')
  }, [canControl, togglePlay, requestControl, isPlaying])

  const handleNext = useCallback(() => {
    if (canControl) next()
    else requestControl('next')
  }, [canControl, next, requestControl])

  const handlePrev = useCallback(() => {
    if (canControl) prev()
    else requestControl('prev')
  }, [canControl, prev, requestControl])

  /** 播放模式 3 态循环（仅直接控制权持有者可切换） */
  const cyclePlayMode = useCallback(() => {
    if (!canControl) return
    const idx = PLAY_MODE_ORDER.indexOf(playMode)
    setPlayMode(PLAY_MODE_ORDER[(idx + 1) % PLAY_MODE_ORDER.length])
  }, [canControl, playMode, setPlayMode])

  // ===== 音量横条滑块（仅本地生效不参与房间同步） =====
  const volumeTrackRef = useRef<HTMLDivElement>(null)

  const handleVolumePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const compute = (clientX: number) => {
        const el = volumeTrackRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0) return
        const ratio = Math.min(
          1,
          Math.max(0, (clientX - rect.left) / rect.width)
        )
        setVolume(ratio)
      }
      compute(e.clientX)
      const handleMove = (ev: PointerEvent) => compute(ev.clientX)
      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [setVolume]
  )

  // ===== 喜欢（Hydrogen likeSong：NCM 登录且当前有歌可见；乐观更新） =====
  const songId = currentSong?.songId ?? null
  const canLike = loginStatus.loggedIn && songId != null && songId > 0
  const [liked, setLiked] = useState(false)
  const [likeBusy, setLikeBusy] = useState(false)

  // 查询当前喜欢状态（/account 取 uid → /likelist 取 ids；异步回调内 setState）
  useEffect(() => {
    if (!canLike || songId == null) return
    let cancelled = false
    const query = async () => {
      try {
        const acc = await apiGet<{
          account?: { id?: number }
          profile?: { userId?: number }
        }>(`/api/music/ncm/account?timestamp=${Date.now()}`)
        if (cancelled) return
        const uid = acc?.data?.account?.id ?? acc?.data?.profile?.userId
        if (!uid) return
        const list = await apiGet<{ ids?: number[] }>(
          `/api/music/ncm/likelist?uid=${uid}&timestamp=${Date.now()}`
        )
        if (cancelled) return
        const ids = list?.data?.ids ?? []
        if (Array.isArray(ids)) setLiked(ids.includes(songId))
      } catch {
        // 静默失败：按钮仍可点（乐观更新），仅初始状态未知
      }
    }
    void query()
    return () => {
      cancelled = true
    }
  }, [canLike, songId])

  /** 切歌时重置喜欢乐观态（render 期调整，替代 effect 内同步 setState） */
  const [prevLikedSongId, setPrevLikedSongId] = useState<number | null>(songId)
  if (prevLikedSongId !== songId) {
    setPrevLikedSongId(songId)
    setLiked(false)
    setLikeBusy(false)
  }

  const handleLike = useCallback(async () => {
    if (!canLike || songId == null || likeBusy) return
    const nextLiked = !liked
    setLiked(nextLiked)
    setLikeBusy(true)
    try {
      await apiGet(
        `/api/music/ncm/like?id=${songId}&like=${nextLiked}&timestamp=${Date.now()}`
      )
    } catch {
      // 失败回滚乐观状态
      setLiked(!nextLiked)
    } finally {
      setLikeBusy(false)
    }
  }, [canLike, songId, liked, likeBusy])

  // ===== 添加到歌单（Hydrogen addToPlaylist：弹窗选择自建歌单，
  //       个人操作 NCM 登录即可，不依赖房主/房管权限） =====
  const [addPlaylistOpen, setAddPlaylistOpen] = useState(false)

  // ===== 专辑跳转（Hydrogen toAlbum：解析当前歌的专辑 ID 后跳转专辑详情页） =====
  const handleToAlbum = useCallback(async () => {
    if (!currentSong || currentSong.songId <= 0) return
    try {
      const { data } = await apiGet<{
        songs?: Array<{ al?: { id?: number; name?: string; picUrl?: string } }>
      }>(
        `/api/music/ncm/song/detail?ids=${currentSong.songId}&timestamp=${Date.now()}`
      )
      const album = data?.songs?.[0]?.al
      if (!album?.id) {
        message.info('该歌曲暂无专辑信息')
        return
      }
      // 写入待打开详情并切到我的音乐页（详情页由 MusicMyPage 消费打开）
      setPendingAlbumDetail({
        id: album.id,
        name: album.name || '专辑',
        cover: album.picUrl,
      })
      setPage('mymusic')
    } catch (err) {
      console.error('[MusicWidgetBar] 专辑解析失败:', err)
      message.info('该歌曲暂无专辑信息')
    }
  }, [currentSong, setPendingAlbumDetail, setPage])

  const cover = currentSong?.cover
  const songName = currentSong?.name ?? '一起听'
  const artist = currentSong?.artist ?? ''

  /** 播放模式图标（3 态） */
  const PlayModeIcon =
    playMode === 'repeat-one'
      ? Repeat1
      : playMode === 'shuffle'
        ? Shuffle
        : Repeat

  return (
    <div
      className="glass-card relative flex h-[65px] items-center"
      style={{
        // 悬浮感核心（Hydrogen 暗色 --shadow 规格）：比 glass-card 默认阴影
        // 更弥散更深，覆盖其内置 box-shadow
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
      }}
    >
      {/* ===== 顶部细进度条（hover 向下加粗并显示时间） ===== */}
      {/* 定位：条体紧贴卡片顶边（top-0，贴 border 内侧零缝隙），hover 13px
          只向下扩展，完全在控制栏面板内不越界；水平方向左右各缩进一个
          圆角半径，两端不进圆角区域；z-10 提升图层，加粗时盖住封面缩略图 */}
      <div
        className="pointer-events-none absolute top-0 right-0 left-0 z-10 group"
        style={{
          left: 'var(--md-sys-shape-corner)',
          right: 'var(--md-sys-shape-corner)',
        }}
      >
        <div
          ref={progressRef}
          role="slider"
          aria-label={canControl ? '播放进度' : '播放进度（仅房主可拖动）'}
          aria-valuemin={0}
          aria-valuemax={Math.round(durationSec)}
          aria-valuenow={Math.round(positionSec)}
          aria-disabled={!canControl}
          className={cn(
            'pointer-events-auto relative h-[2.5px] transition-all duration-200 hover:h-[13px]',
            canControl && 'cursor-pointer'
          )}
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent)',
          }}
          onPointerDown={handleProgressPointerDown}
        >
          <div
            className="absolute left-0 top-0 h-full bg-[var(--md-sys-color-primary)]"
            style={{ width: `${progressRatio * 100}%` }}
          />
          {/* hover 显示当前/总时长（Hydrogen .music-time：白字 9px，条内上方） */}
          <div className="pointer-events-none absolute left-1 top-1.5 hidden items-center px-0.5 text-[9px] font-bold tabular-nums text-white group-hover:flex">
            {formatDuration(positionSec)} / {formatDuration(durationSec)}
          </div>
        </div>
      </div>

      {/* ===== 左：封面缩略图 + 歌曲信息（Hydrogen .music-info） ===== */}
      <div className="ml-[17px] flex min-w-0 flex-1 items-center">
        {/* 封面：点击打开完整播放器覆盖层；hover 黑色遮罩 + 箭头从底部滑入 */}
        <button
          type="button"
          disabled={!cover}
          className={cn(
            'group/cover relative h-[45px] w-[45px] shrink-0 overflow-hidden border',
            cover ? 'cursor-pointer' : 'cursor-default'
          )}
          style={{
            borderColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
            backgroundColor: 'var(--md-sys-color-surface-container-high)',
          }}
          onClick={cover ? () => setPlayerOverlayOpen(true) : undefined}
          title={cover ? '打开完整播放器' : undefined}
          aria-label={cover ? '打开完整播放器' : undefined}
        >
          {cover ? (
            <img src={cover} alt="" className="h-full w-full object-cover" />
          ) : (
            <ListMusic
              className="m-auto h-4 w-4 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
          )}
          {/* hover 遮罩 + 上箭头从底部滑入（Hydrogen .open-player：top 120% → 50%） */}
          {cover && (
            <span
              className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover/cover:opacity-100"
              style={{
                backgroundColor: 'color-mix(in srgb, black 50%, transparent)',
              }}
            >
              <svg
                viewBox="0 0 1024 1024"
                className="h-[40%] w-[40%] -translate-y-[120%] transition-transform duration-200 ease-[cubic-bezier(0,1.06,0.77,0.99)] group-hover/cover:translate-y-0"
                aria-hidden="true"
              >
                <path
                  d="M960.1 699.7l-72.8 72.8L512 397.1 136.7 772.5l-72.8-72.8L512 251.5z"
                  fill="#ffffff"
                />
              </svg>
            </span>
          )}
        </button>
        {/* 歌名（OverflowMarquee 跑马灯，Hydrogen .music-name 14px bold）+ 歌手 */}
        <div className="ml-2 w-[175px] min-w-0 select-text">
          <OverflowMarquee
            text={songName}
            className="block h-[18px] text-[14px] font-bold leading-[18px] text-[var(--md-sys-color-on-surface)]"
          />
          <div className="truncate text-[10px] leading-snug text-[var(--md-sys-color-on-surface-variant)]">
            {artist}
          </div>
        </div>
      </div>

      {/* ===== 右：控制键 + 音量 + 功能图标（Hydrogen .music-right 476px 定宽） ===== */}
      <div className="flex w-[476px] max-w-[calc(100%-245px)] shrink-0 items-center">
        {/* music-control（126px）：prev / play-pause / next（线条式 SVG） */}
        <div className="flex w-[126px] shrink-0 items-center px-[18px]">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
            onClick={handlePrev}
            title={canControl ? '上一首' : '向房主申请切换上一首'}
            aria-label="上一首"
          >
            <ControlPrevIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="mx-[15px] flex h-6 w-6 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
            onClick={handlePlayPause}
            title={
              canControl
                ? isPlaying
                  ? '暂停'
                  : '播放'
                : isPlaying
                  ? '申请暂停'
                  : '申请继续播放'
            }
            aria-label="播放或暂停"
          >
            {isPlaying ? (
              <ControlPauseIcon className="h-5 w-5" />
            ) : (
              <ControlPlayIcon className="h-5 w-5" />
            )}
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
            onClick={handleNext}
            title={canControl ? '下一首' : '向房主申请切换下一首'}
            aria-label="下一首"
          >
            <ControlNextIcon className="h-5 w-5" />
          </button>
        </div>

        {/* music-volume（120px）：7px 描边滑条 + 上方 VOLUME 标签与数字 */}
        <div className="w-[120px] shrink-0">
          <div className="relative h-[7px]">
            <div
              ref={volumeTrackRef}
              role="slider"
              aria-label="音量"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(volume * 100)}
              className="relative h-[7px] cursor-pointer"
              style={{
                border: '1px solid var(--md-sys-color-on-surface)',
                boxShadow: '0 0 0 0.5px var(--md-sys-color-on-surface)',
              }}
              onPointerDown={handleVolumePointerDown}
            >
              <div
                className="absolute left-0 top-0 h-full bg-[var(--md-sys-color-on-surface)]"
                style={{ width: `${volume * 100}%` }}
              />
            </div>
            <div className="absolute -top-[10px] left-0 flex items-center">
              <span className="mr-1.5 text-[8px] tracking-widest text-[var(--md-sys-color-on-surface-variant)]">
                VOLUME
              </span>
              <span
                className="text-[8px] tabular-nums"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
              >
                {Math.round(volume * 100)}
              </span>
            </div>
          </div>
        </div>

        {/* music-other（230px，space-evenly）：喜欢 / 加入队列 / 专辑 / 模式 / 队列 */}
        <div className="flex w-[230px] shrink-0 items-center justify-evenly">
          {/* 喜欢（描边心 / 红心，NCM 登录且有歌可见） */}
          {canLike && (
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
              onClick={() => void handleLike()}
              title={liked ? '取消喜欢' : '喜欢'}
              aria-label={liked ? '取消喜欢' : '喜欢'}
            >
              {liked ? (
                <Heart className="h-5 w-5" fill="#E5404F" stroke="none" />
              ) : (
                <Heart className="h-5 w-5" />
              )}
            </button>
          )}
          {/* 添加到歌单（圆圈加号，Hydrogen addToPlaylist：NCM 登录且有歌可见） */}
          {loginStatus.loggedIn && currentSong && (
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
              onClick={() => setAddPlaylistOpen(true)}
              title="添加到我的歌单"
              aria-label="添加到我的歌单"
            >
              <CirclePlus className="h-5 w-5" />
            </button>
          )}
          {/* 专辑（唱片）：解析当前歌专辑并跳转详情页（Hydrogen toAlbum） */}
          {currentSong && (
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
              onClick={() => void handleToAlbum()}
              title="查看专辑"
              aria-label="查看专辑"
            >
              <Disc3 className="h-5 w-5" />
            </button>
          )}
          {/* 播放模式（顺序 / 单曲循环 / 随机 3 态循环；仅直接控制权可切） */}
          <button
            type="button"
            className={cn(
              'flex h-5 w-5 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90',
              !canControl && 'cursor-default opacity-50'
            )}
            onClick={cyclePlayMode}
            title={
              canControl
                ? playMode === 'sequence'
                  ? '顺序循环'
                  : playMode === 'repeat-one'
                    ? '单曲循环'
                    : '随机播放'
                : '仅房主可切换播放模式'
            }
            aria-label="切换播放模式"
          >
            <PlayModeIcon className="h-5 w-5" />
          </button>
          {/* 队列弹窗 */}
          <button
            type="button"
            className="flex h-5 w-5 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90"
            onClick={() => setQueuePopupOpen(true)}
            title="播放队列"
            aria-label="播放队列"
          >
            <ListMusic className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* widget-back：右上角 5px 圆点装饰（Hydrogen 同款） */}
      <span
        className="absolute right-1.5 top-1.5 h-[5px] w-[5px] rounded-full"
        style={{ backgroundColor: 'rgba(160, 160, 160, 0.7)' }}
        aria-hidden="true"
      />

      {/* 添加到我的歌单弹窗（Hydrogen ContextMenu.add-to-playlist） */}
      <AddToPlaylistModal
        open={addPlaylistOpen}
        song={
          currentSong
            ? { songId: currentSong.songId, name: currentSong.name }
            : null
        }
        onClose={() => setAddPlaylistOpen(false)}
      />
    </div>
  )
}
