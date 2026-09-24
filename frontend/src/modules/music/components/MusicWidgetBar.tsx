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
  ListEnd,
} from 'lucide-react'
import { apiGet, apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import {
  normalizeBiliLikeFavTitle,
  useMusicSettingsStore,
} from '../store-settings'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { usePlaybackPosition } from '../hooks/usePlaybackPosition'
import { OverflowMarquee } from './OverflowMarquee'
import { BiliFavCollectModal } from './BiliFavCollectModal'
import {
  ControlNextIcon,
  ControlPauseIcon,
  ControlPlayIcon,
  ControlPrevIcon,
} from './PlayerControlIcons'
import { AddToPlaylistModal } from './AddToPlaylistModal'
import { prefetchUserPlaylists } from '../userPlaylists'
import { prefetchBiliFavFolders } from '@/modules/bilibili/bilibiliApi'
import { cn, formatDuration } from '@/lib/utils'
import { PLAY_MODE_ORDER } from '../constants'

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
    playMode,
    setPlayMode,
    volume,
    setVolume,
  } = useMusicPlayer()
  // 播放进度：本组件内部量化订阅（0.5s 一档）——不再从 context 取
  // positionSec（那会带动整个播放控制栏以 4-8Hz 重渲染）
  const positionSec = usePlaybackPosition(0.5)

  const setPlayerOverlayOpen = useMusicStore((s) => s.setPlayerOverlayOpen)
  const setQueuePopupOpen = useMusicStore((s) => s.setQueuePopupOpen)
  const setPendingAlbumDetail = useMusicStore((s) => s.setPendingAlbumDetail)
  const setPage = useMusicStore((s) => s.setPage)
  const loginStatus = useMusicStore((s) => s.loginStatus)

  // ===== 进度条（细滑块；canControl 可拖动 seek，观众拖动转为 seek 申请） =====
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

  /**
   * 拖动进度（canControl 直接 seek；观众走 seek 申请——房主「自动通过」
   * 开启时立即生效，关闭时转房主审批）。
   * Hydrogen「广播值—实际值分离 + 松手才 transition」模式：拖动期间只更新
   * 本地预览值（进度条即时跟手、宽度无过渡），松手后才真 seek，随后位置值
   * 变化以 0.5s transition 平滑补间（对应 vue-slider :duration=0.5）。
   */
  const [dragPreviewSec, setDragPreviewSec] = useState<number | null>(null)
  const handleProgressPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (durationSec <= 0) return
      e.preventDefault()
      e.stopPropagation()
      setDragPreviewSec(computeTimeFromClientX(e.clientX))
      const handleMove = (ev: PointerEvent) => {
        setDragPreviewSec(computeTimeFromClientX(ev.clientX))
      }
      const handleUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        const target = computeTimeFromClientX(ev.clientX)
        if (canControl) seek(target)
        else requestControl('seek', target)
        // 松手即清预览：宽度从拖动终点以 0.5s transition 平滑到 seek 值
        setDragPreviewSec(null)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [canControl, durationSec, seek, requestControl, computeTimeFromClientX]
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
  // Hydrogen vue-slider :duration=0.3 等价：非拖动变化 0.3s 平滑补间，
  // 拖动期间即时跟手（无过渡）
  const volumeTrackRef = useRef<HTMLDivElement>(null)
  const [volumeDragging, setVolumeDragging] = useState(false)

  const handleVolumePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setVolumeDragging(true)
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
        setVolumeDragging(false)
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
        }>(`/api/music/ncm/user/account?timestamp=${Date.now()}`)
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

  // ===== B站 歌状态：当前播放为 B站 视频时，控制栏「添加到歌单」切换为
  // 「添加到哔哩哔哩收藏夹」（弹窗选择收藏夹），「专辑」切换为红心
  // （一键收藏到设置「红心收藏夹」指定的收藏夹，不存在自动创建） =====
  const isBiliSong = currentSong?.biliBvid != null
  /** 红心一键收藏的目标收藏夹（播放页设置「红心收藏夹」，默认 Music） */
  const biliLikeFavTitle = normalizeBiliLikeFavTitle(
    useMusicSettingsStore((s) => s.biliLikeFavTitle)
  )
  const [biliFavModalOpen, setBiliFavModalOpen] = useState(false)
  const [biliCollecting, setBiliCollecting] = useState(false)
  /** 已收藏记录（本地会话记忆：bvid + 目标收藏夹名；切到其他视频或
   *  更换目标收藏夹后红心回落空心） */
  const [biliCollectedMark, setBiliCollectedMark] = useState<{
    bvid: string
    folder: string
  } | null>(null)
  const biliCollected =
    isBiliSong &&
    currentSong?.biliBvid != null &&
    biliCollectedMark?.bvid === currentSong.biliBvid &&
    biliCollectedMark.folder === biliLikeFavTitle
  /** 收藏/取消收藏开关：已收藏（同一视频 + 同一目标收藏夹）时点击即
   *  取消收藏（后端同端点 del_media_ids），否则一键收藏 */
  const handleBiliCollect = useCallback(async () => {
    const bvid = currentSong?.biliBvid
    if (!bvid || biliCollecting) return
    const collected =
      biliCollectedMark?.bvid === bvid &&
      biliCollectedMark.folder === biliLikeFavTitle
    setBiliCollecting(true)
    try {
      const { data, ok } = await apiPost<{
        success?: boolean
        message?: string
        folderTitle?: string
      }>('/api/stream/bilibili/fav/collect', {
        bvid,
        folderTitle: biliLikeFavTitle,
        action: collected ? 'remove' : 'add',
      })
      if (!ok || data?.success === false) {
        throw new Error(
          data?.message || (collected ? '取消收藏失败' : '收藏失败')
        )
      }
      if (collected) {
        setBiliCollectedMark(null)
        message.success(
          `已取消收藏「${data?.folderTitle || biliLikeFavTitle}」`
        )
      } else {
        setBiliCollectedMark({ bvid, folder: biliLikeFavTitle })
        message.success(`已收藏到「${data?.folderTitle || biliLikeFavTitle}」`)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBiliCollecting(false)
    }
  }, [currentSong, biliCollecting, biliCollectedMark, biliLikeFavTitle])

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

  /** 播放模式图标（4 态） */
  const PlayModeIcon =
    playMode === 'repeat-one'
      ? Repeat1
      : playMode === 'shuffle'
        ? Shuffle
        : playMode === 'order'
          ? ListEnd
          : Repeat

  return (
    <div
      className="glass-card relative flex h-[65px] items-center"
      style={
        {
          // 玻璃作用域文字色：条体是主题驱动的玻璃面（glass-card），文字/
          // 图标用按「含玻璃层背景」判定的 scheme 文字色（ThemeProvider 注入
          // --lt-glass-*），不跟随全局壁纸级文字切换——否则深色模式亮壁纸
          // 下全局切深字，深色条体上深字不可读
          '--md-sys-color-on-surface': 'var(--lt-glass-on-surface)',
          '--md-sys-color-on-surface-variant':
            'var(--lt-glass-on-surface-variant)',
          '--md-sys-color-outline': 'var(--lt-glass-outline)',
          '--md-sys-color-outline-variant': 'var(--lt-glass-outline-variant)',
          // 悬浮感核心（Hydrogen 暗色 --shadow 规格）：比 glass-card 默认阴影
          // 更弥散更深，覆盖其内置 box-shadow
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
        } as React.CSSProperties
      }
    >
      {/* ===== 底部细进度条（hover / 拖动时向上加粗并显示时间） ===== */}
      {/* 定位：条体紧贴卡片底边（bottom-0，贴 border 内侧零缝隙），加粗 13px
          只向上扩展（容器锚定底边、高度增长自动向上伸展），完全在控制栏
          面板内不越界；水平方向左右各缩进一个圆角半径，两端不进圆角区域；
          z-10 提升图层。默认恒为 2.5px 细条（手机端不再常驻展开） */}
      <div
        className="pointer-events-none absolute bottom-0 right-0 left-0 z-10 group"
        style={{
          left: 'var(--md-sys-shape-corner)',
          right: 'var(--md-sys-shape-corner)',
        }}
      >
        {/* 命中层：桌面高度随视觉条，手机端固定 14px 透明热区（2.5px 薄条
            触屏难点中）；seek 比例按宽度计算，与视觉条一致 */}
        <div
          ref={progressRef}
          role="slider"
          aria-label={canControl ? '播放进度' : '播放进度（仅房主可拖动）'}
          aria-valuemin={0}
          aria-valuemax={Math.round(durationSec)}
          aria-valuenow={Math.round(positionSec)}
          aria-disabled={!canControl}
          className={cn(
            // touch-slider：触屏拖动时禁止页面滚动（pointer 监听挂在 window）
            'touch-slider pointer-events-auto relative w-full',
            canControl && 'cursor-pointer'
          )}
          onPointerDown={handleProgressPointerDown}
        >
          {/* 视觉条：默认 2.5px，hover（桌面）/拖动中（含触屏）加粗至 13px */}
          <div
            className={cn(
              'relative w-full transition-all duration-200 group-hover:h-[13px]',
              dragPreviewSec != null ? 'h-[13px]' : 'h-[2.5px]'
            )}
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent)',
            }}
          >
            <div
              className="absolute left-0 top-0 h-full bg-[var(--md-sys-color-primary)]"
              style={{
                // 拖动预览即时跟手；松手后 0.5s 平滑补间（同 ListenTogetherPanel）
                width: `${
                  (dragPreviewSec != null && durationSec > 0
                    ? Math.min(1, Math.max(0, dragPreviewSec / durationSec))
                    : progressRatio) * 100
                }%`,
                transition:
                  dragPreviewSec != null ? 'none' : 'width 0.5s linear',
              }}
            />
            {/* hover 显示当前/总时长（Hydrogen .music-time：白字 9px）；
                inset-y-0 + items-center 使文字垂直居中于加粗后的条内栏，
                而非溢出到条下方；leading-none 收紧行高防撑出 13px 条体；
                手机端默认不显示准确时间（定位经拖动预览展示） */}
            <div className="pointer-events-none absolute inset-y-0 left-1 hidden items-center px-0.5 text-[9px] font-bold leading-none tabular-nums text-white group-hover:flex">
              {formatDuration(positionSec)} / {formatDuration(durationSec)}
            </div>
          </div>
        </div>
      </div>

      {/* ===== 左：封面缩略图 + 歌曲信息（Hydrogen .music-info） ===== */}
      <div className="ml-[17px] flex min-w-0 flex-1 items-center max-md:ml-3">
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
        {/* 歌名（OverflowMarquee 跑马灯，Hydrogen .music-name 14px bold）+ 歌手；
            手机端自适应宽度（固定 175px 会挤压右侧控制区） */}
        <div className="ml-2 w-[175px] min-w-0 select-text max-md:w-auto max-md:flex-1 max-md:max-w-[150px]">
          <OverflowMarquee
            text={songName}
            className="block h-[18px] text-[14px] font-bold leading-[18px] text-[var(--md-sys-color-on-surface)]"
          />
          <div className="truncate text-[10px] leading-snug text-[var(--md-sys-color-on-surface-variant)]">
            {artist}
          </div>
        </div>
      </div>

      {/* ===== 右：控制键 + 音量 + 功能图标（Hydrogen .music-right 476px 定宽；
          手机端改自适应：隐藏音量条（手机用系统音量/完整播放器内调节）
          与次要图标，避免定宽溢出小屏） ===== */}
      <div className="flex w-[476px] max-w-[calc(100%-245px)] shrink-0 items-center max-md:w-auto max-md:max-w-none">
        {/* music-control（126px）：prev / play-pause / next（线条式 SVG） */}
        <div className="flex w-[126px] shrink-0 items-center px-[18px] max-md:w-auto max-md:px-1">
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
            className="mx-[15px] flex h-6 w-6 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90 max-md:mx-[7px]"
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

        {/* music-volume（120px）：7px 描边滑条 + 上方 VOLUME 标签与数字；
            手机端隐藏（小屏放不下，音量经系统/完整播放器调节） */}
        <div className="w-[120px] shrink-0 max-md:hidden">
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
                style={{
                  width: `${volume * 100}%`,
                  transition: volumeDragging ? 'none' : 'width 0.3s linear',
                }}
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

        {/* music-other（230px，space-evenly）：喜欢 / 加入队列 / 专辑 / 模式 / 队列；
            手机端仅保留喜欢/队列，并给右缘留出呼吸间距（原贴边太挤） */}
        <div className="flex w-[230px] shrink-0 items-center justify-evenly max-md:w-auto max-md:gap-3 max-md:pr-3.5">
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
          {/* 添加到歌单（圆圈加号，Hydrogen addToPlaylist：NCM 登录且有歌可见；
              手机端隐藏——入口保留在完整播放器内）。
              B站 歌时切换为「添加到哔哩哔哩我的收藏夹」（弹窗选择收藏夹） */}
          {(isBiliSong
            ? currentSong?.biliBvid != null
            : loginStatus.loggedIn && currentSong != null) && (
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90 max-md:hidden"
              // hover 即预取：网易云歌预取自建歌单、B站 歌预取收藏夹
              // （Hydrogen libraryStore 预载同思路，面板打开零等待）
              onPointerEnter={() => {
                if (isBiliSong) void prefetchBiliFavFolders()
                else void prefetchUserPlaylists()
              }}
              onClick={() => {
                if (isBiliSong) {
                  setBiliFavModalOpen(true)
                } else {
                  void prefetchUserPlaylists()
                  setAddPlaylistOpen(true)
                }
              }}
              title={isBiliSong ? '添加到哔哩哔哩收藏夹' : '添加到我的歌单'}
              aria-label={
                isBiliSong ? '添加到哔哩哔哩收藏夹' : '添加到我的歌单'
              }
            >
              <CirclePlus className="h-5 w-5" />
            </button>
          )}
          {/* 专辑（唱片）：解析当前歌专辑并跳转详情页（Hydrogen toAlbum；
              手机端隐藏——入口保留在完整播放器内）。
              B站 歌时切换为红心：一键收藏当前视频到设置的「红心收藏夹」 */}
          {currentSong &&
            (isBiliSong ? (
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center transition-transform hover:opacity-70 active:scale-90 max-md:hidden"
                onClick={() => void handleBiliCollect()}
                disabled={biliCollecting}
                title={
                  biliCollected
                    ? `已收藏到哔哩哔哩「${biliLikeFavTitle}」收藏夹；点击取消收藏`
                    : `收藏到哔哩哔哩「${biliLikeFavTitle}」收藏夹`
                }
                aria-label={
                  biliCollected
                    ? `已收藏到哔哩哔哩 ${biliLikeFavTitle} 收藏夹，点击取消收藏`
                    : `收藏到哔哩哔哩 ${biliLikeFavTitle} 收藏夹`
                }
              >
                <Heart
                  className={cn('h-5 w-5', biliCollecting && 'animate-pulse')}
                  fill={biliCollected ? '#E5404F' : 'none'}
                  stroke={biliCollected ? 'none' : 'currentColor'}
                />
              </button>
            ) : (
              <button
                type="button"
                className="flex h-5 w-5 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90 max-md:hidden"
                onClick={() => void handleToAlbum()}
                title="查看专辑"
                aria-label="查看专辑"
              >
                <Disc3 className="h-5 w-5" />
              </button>
            ))}
          {/* 播放模式（顺序循环 / 按顺序播放 / 单曲循环 / 随机 4 态循环；
              仅直接控制权可切；手机端隐藏——入口保留在完整播放器工具行内） */}
          <button
            type="button"
            className={cn(
              'flex h-5 w-5 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform hover:opacity-70 active:scale-90 max-md:hidden',
              !canControl && 'cursor-default opacity-50'
            )}
            onClick={cyclePlayMode}
            title={
              canControl
                ? playMode === 'sequence'
                  ? '顺序循环'
                  : playMode === 'order'
                    ? '按顺序播放'
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

      {/* 添加到我的歌单弹窗（Hydrogen ContextMenu.add-to-playlist；NCM 歌） */}
      <AddToPlaylistModal
        open={addPlaylistOpen}
        song={
          currentSong
            ? { songId: currentSong.songId, name: currentSong.name }
            : null
        }
        onClose={() => setAddPlaylistOpen(false)}
      />

      {/* B站 收藏夹选择弹窗（B站 歌的「添加到哔哩哔哩收藏夹」） */}
      <BiliFavCollectModal
        open={biliFavModalOpen}
        bvid={currentSong?.biliBvid ?? ''}
        onCollected={(bvid, folder) =>
          setBiliCollectedMark({ bvid, folder: folder ?? biliLikeFavTitle })
        }
        onClose={() => setBiliFavModalOpen(false)}
      />
    </div>
  )
}
