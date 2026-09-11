/**
 * 一起听完整播放器（点击底栏封面展开，Hydrogen MusicPlayer.vue + Player.vue
 * + Lyric.vue 的 React 1:1 复刻）。
 *
 * 整页布局（flex 横排居中，Hydrogen .music-player 骨架）：
 * - 毛玻璃封面背景（backdrop）：封面图 absolute 铺满 120%（-10% 偏移），
 *   blur(50px) saturate(140%) brightness(1.08) scale(1.08)，上叠 surface 30%
 *   遮罩；无封面时不渲染，切歌时淡入淡出
 * - 左侧播放卡（42vh 宽，无圆角）：半透明白卡 + backdrop 模糊，入场动画
 *   player-card-in（0.7s delay 0.2s：先展开宽度至 42vh，再纵向展开至满高）；
 *   四角黑色实心方块（1.5vh，出界 0.75vh）+ 封面 L 形角标（4vh，1vh→0 内缩，
 *   延迟 0.65s）；内容自上而下：封面（max-height 38vh）/ 歌名（黑块滑入遮字
 *   切歌动画 + 跑马灯）/ 歌手（小方点 + 名）/ 时间行 + 进度条（1.3vh 黑条 +
 *   0.5px 描边）/ 三键控制（5vh）/ 音量滑块 + VOLUME 标签
 * - song-control 悬浮工具栏：卡片 hover 时「信号灯」闪烁显形（0.3s 闪三下），
 *   竖排：喜欢（NCM 登录）/ 播放队列 / 播放模式（房主）/ 翻译开关 / 收起
 * - 右侧歌词面板（flex-1，与左卡间距 50px）：PlayerLyricPanel（黑色高亮条、
 *   补偿式平滑滚动、手动滚动暂停、点击行 seek、间奏倒计时、Lyric-Area 占位）
 * - 提示区（页面左上角 absolute）：房主离线提示 / syncNotice（房主审批带
 *   通过/拒绝小按钮，5s 自动消失），文字提示非弹窗
 *
 * 播放引擎与同步逻辑由 MusicPlayerProvider 持有（内部 useListenTogether），
 * 本组件经 useMusicPlayer 消费；观众无直接控制权时控制按钮走申请制
 * （requestControl），房主端左上角提示申请并通过/拒绝。
 */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronDown, ListMusic, Music, X, Check } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { useMusicStore } from '../store'
import { useMusicSettingsStore } from '../store-settings'
import { useMusicPlayer, MusicPlayerContext } from '../hooks/useMusicPlayer'
import { MusicPlayerProvider } from '../MusicPlayerContext'
import { mergeLyrics, type LyricLine } from '../utils/lrc'
import type { PlayMode } from '../types'
import { cn, formatDuration } from '@/lib/utils'
import { OverflowMarquee } from './OverflowMarquee'
import { PlayerLyricPanel } from './PlayerLyricPanel'
import { MusicQueuePopup } from './MusicQueuePopup'
import { EqBars } from './SongRow'
import {
  ControlNextIcon,
  ControlPauseIcon,
  ControlPlayIcon,
  ControlPrevIcon,
  LikeFilledIcon,
  LikeOutlineIcon,
  ModeRepeatOneIcon,
  ModeSequenceIcon,
  ModeShuffleIcon,
  OriginalLyricIcon,
  RomanLyricIcon,
  TransLyricIcon,
} from './PlayerControlIcons'

export interface ListenTogetherPanelProps {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  /** 网页全屏模式（放大左右留白排版） */
  isWebFullscreen?: boolean
  /** 队列管理权限（房主/房管观众）；缺省按 isHost 判定 */
  canManage?: boolean
}

/** 网易云 /lyric 原始响应（后端透传结构） */
interface NcmLyricResponse {
  lrc?: { lyric?: string }
  tlyric?: { lyric?: string }
  rlyric?: { lyric?: string }
}

/** 网易云 /account 响应（宽松解析 uid） */
interface NcmAccountResponse {
  data?: { account?: { id?: number } }
  account?: { id?: number }
  profile?: { userId?: number }
}

/** 网易云 /likelist 响应（宽松解析 ids） */
interface NcmLikelistResponse {
  data?: { ids?: number[] }
  ids?: number[]
}

/** syncNotice 自动消失时长（毫秒） */
const SYNC_NOTICE_AUTO_DISMISS_MS = 5000

/** 歌词高亮提前量（秒）：接近下一行时间标签前即切换高亮 */
const LYRIC_ADVANCE_SEC = 0.2

/** 播放模式轮换顺序 */
const PLAY_MODE_ORDER: PlayMode[] = ['sequence', 'repeat-one', 'shuffle']

const PLAY_MODE_META: Record<PlayMode, { label: string; next: string }> = {
  sequence: { label: '顺序循环', next: '切换为单曲循环' },
  'repeat-one': { label: '单曲循环', next: '切换为随机播放' },
  shuffle: { label: '随机播放', next: '切换为顺序循环' },
}

export function ListenTogetherPanel({
  socket,
  roomId,
  isHost,
  username,
  isWebFullscreen,
  canManage,
}: ListenTogetherPanelProps) {
  // 页面级集成：RoomPage/WatchPage 用 MusicPlayerProvider 包裹整个 RoomLayout，
  // 使主区域框架（MusicAppShell）与此完整播放器覆盖层共享同一引擎。
  // 此时直接复用外层实例，避免嵌套 Provider 重复创建音频引擎
  //（双引擎会导致切歌与主播放器不同步）。
  const outerPlayer = useContext(MusicPlayerContext)
  if (outerPlayer) {
    return (
      <ListenTogetherInner
        socket={socket}
        roomId={roomId}
        isHost={isHost}
        isWebFullscreen={isWebFullscreen}
        canManage={canManage}
      />
    )
  }
  return (
    <MusicPlayerProvider
      socket={socket}
      roomId={roomId}
      isHost={isHost}
      username={username}
    >
      <ListenTogetherInner
        socket={socket}
        roomId={roomId}
        isHost={isHost}
        isWebFullscreen={isWebFullscreen}
        canManage={canManage}
      />
    </MusicPlayerProvider>
  )
}

function ListenTogetherInner({
  socket,
  roomId,
  isHost,
  isWebFullscreen,
  canManage,
}: {
  socket: Socket | null
  roomId: string
  isHost: boolean
  isWebFullscreen?: boolean
  /** 队列管理权限；缺省按 isHost 判定 */
  canManage?: boolean
}) {
  const {
    togglePlay,
    next,
    prev,
    seek,
    setPlayMode,
    requestControl,
    approveControl,
    rejectControl,
    currentSong,
    canControl,
    hostOffline,
    syncNotice,
    setSyncNotice,
    positionSec,
    isPlaying,
    playMode,
    volume,
    setVolume,
  } = useMusicPlayer()

  const closePlayerOverlay = useMusicStore((s) => s.closePlayerOverlay)
  const queuePopupOpen = useMusicStore((s) => s.queuePopupOpen)
  const setQueuePopupOpen = useMusicStore((s) => s.setQueuePopupOpen)
  const loginStatus = useMusicStore((s) => s.loginStatus)

  const queue = useMusicStore((s) => s.queue)

  const songId = currentSong?.songId
  const cover = currentSong?.cover

  // ===== 歌词加载状态（区分 无歌词/纯音乐/正常 三态 + 首帧防闪烁） =====
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([])
  const [emptyMode, setEmptyMode] = useState<'none' | 'pure' | null>(null)
  const [lyricRevealed, setLyricRevealed] = useState(false)
  // 切歌动画（歌名黑块滑入遮字）
  const [songSwitching, setSongSwitching] = useState(false)
  // 喜欢（乐观状态）
  const [liked, setLiked] = useState(false)
  const [likeBusy, setLikeBusy] = useState(false)

  // ===== 切歌驱动的同步重置（render 期调整状态，替代 effect 内同步 setState）：
  // 歌词清空走防闪烁隐藏（Hydrogen 切歌 lyricShow=false 同语义）、
  // 黑块滑入、喜欢乐观态重置 =====
  const [prevSongId, setPrevSongId] = useState<number | null | undefined>(
    songId
  )
  if (prevSongId !== songId) {
    setPrevSongId(songId)
    setLyricLines([])
    const noLyricSong = songId == null || songId <= 0
    setEmptyMode(noLyricSong ? 'none' : null)
    setLyricRevealed(noLyricSong)
    setSongSwitching(songId != null)
    setLiked(false)
  }

  // ===== 歌词请求（异步回调内 setState；重置已在 render 期完成） =====
  useEffect(() => {
    if (songId == null || songId <= 0) return
    let cancelled = false
    const loadLyric = async () => {
      try {
        const { data } = await apiGet<NcmLyricResponse>(
          `/api/music/ncm/lyric?id=${songId}`
        )
        if (cancelled) return
        const raw = data?.lrc?.lyric ?? ''
        if (!raw.trim()) {
          // 接口无歌词 → Lyric-Area 占位装饰
          setLyricLines([])
          setEmptyMode('none')
        } else if (raw.includes('纯音乐')) {
          // 纯音乐 → 单行占位（Hydrogen buildPureMusicRows）
          setLyricLines([])
          setEmptyMode('pure')
        } else {
          setLyricLines(
            mergeLyrics(raw, data?.tlyric?.lyric ?? '', data?.rlyric?.lyric)
          )
          setEmptyMode(null)
        }
      } catch (err) {
        console.error('[ListenTogetherPanel] 获取歌词失败:', err)
        if (!cancelled) {
          setLyricLines([])
          setEmptyMode('none')
        }
      }
      if (!cancelled) {
        // 双帧等待布局稳定后再显示（防首帧错位闪烁）
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (!cancelled) setLyricRevealed(true)
          })
        )
      }
    }
    void loadLyric()
    return () => {
      cancelled = true
    }
  }, [songId])

  // ===== 切歌黑块滑出定时（700ms 后滑出露出新歌名） =====
  useEffect(() => {
    if (!songSwitching) return
    const timer = setTimeout(() => setSongSwitching(false), 700)
    return () => clearTimeout(timer)
  }, [songSwitching])

  // ===== 喜欢（Hydrogen likeSong：NCM 登录后可见） =====
  // 查询当前喜欢状态（/account 取 uid → /likelist 取 ids；异步回调内 setState）
  const canLike = loginStatus.loggedIn && songId != null && songId > 0

  useEffect(() => {
    if (!canLike || songId == null) return
    let cancelled = false
    const query = async () => {
      try {
        const acc = await apiGet<NcmAccountResponse>(
          `/api/music/ncm/account?timestamp=${Date.now()}`
        )
        if (cancelled) return
        const uid = acc?.data?.account?.id ?? acc?.data?.profile?.userId
        if (!uid) return
        const list = await apiGet<NcmLikelistResponse>(
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

  /** 当前高亮歌词行（最后一个 time <= positionSec + 提前量的行，二分查找） */
  const activeLyricIndex = useMemo(() => {
    if (lyricLines.length === 0) return -1
    let ans = -1
    let lo = 0
    let hi = lyricLines.length - 1
    const target = positionSec + LYRIC_ADVANCE_SEC
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (lyricLines[mid].time <= target) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }, [lyricLines, positionSec])

  // ===== 喜欢（Hydrogen likeSong：NCM 登录且非塞壬曲目可见） =====
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

  // ===== syncNotice：5s 自动消失 =====
  useEffect(() => {
    if (!syncNotice) return
    const timer = setTimeout(
      () => setSyncNotice(null),
      SYNC_NOTICE_AUTO_DISMISS_MS
    )
    return () => clearTimeout(timer)
  }, [syncNotice, setSyncNotice])

  // ===== 进度条（Hydrogen 样式：1.3vh 黑条 + 0.5px 描边；canControl 可拖动） =====
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

  /** 拖动进度（仅 canControl；观众只读展示） */
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
    if (canControl) {
      togglePlay()
    } else {
      requestControl(isPlaying ? 'pause' : 'play')
    }
  }, [canControl, togglePlay, requestControl, isPlaying])

  const handleNext = useCallback(() => {
    if (canControl) next()
    else requestControl('next')
  }, [canControl, next, requestControl])

  const handlePrev = useCallback(() => {
    if (canControl) prev()
    else requestControl('prev')
  }, [canControl, prev, requestControl])

  /** 歌词行 seek（观众无控制权时不可用，与进度条一致） */
  const handleLyricSeek = useCallback(
    (time: number) => {
      if (canControl) seek(time)
    },
    [canControl, seek]
  )

  /** 播放模式轮换（仅房主，切换后广播同步） */
  const handleTogglePlayMode = useCallback(() => {
    const idx = PLAY_MODE_ORDER.indexOf(playMode)
    const nextMode =
      PLAY_MODE_ORDER[(idx + 1) % PLAY_MODE_ORDER.length] ?? 'sequence'
    setPlayMode(nextMode)
  }, [playMode, setPlayMode])

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

  // ===== 设置驱动（Hydrogen settingsStore 消费点） =====
  const coverBlur = useMusicSettingsStore((s) => s.coverBlur)
  const lyricBlur = useMusicSettingsStore((s) => s.lyricBlur)
  const audioVisualizer = useMusicSettingsStore((s) => s.audioVisualizer)
  const level = useMusicSettingsStore((s) => s.level)
  const lyricSize = useMusicSettingsStore((s) => s.lyricSize)
  const tlyricSize = useMusicSettingsStore((s) => s.tlyricSize)
  const rlyricSize = useMusicSettingsStore((s) => s.rlyricSize)
  const lyricInterlude = useMusicSettingsStore((s) => s.lyricInterlude)
  const defaultShowTrans = useMusicSettingsStore((s) => s.showSongTranslation)

  // ===== 歌词类型开关（Hydrogen lyricType：original / trans / roma）：
  // 翻译初值取自设置「显示歌曲翻译」；切换为播放器内即时态，不写回设置 =====
  const [lyricOriginal, setLyricOriginal] = useState(true)
  const [lyricTrans, setLyricTrans] = useState(defaultShowTrans)
  const [lyricRoma, setLyricRoma] = useState(false)
  const showTranslation = lyricTrans

  /** 播放模式图标（原版 SVG 三态：顺序 / 单曲循环 / 随机） */
  const PlayModeIcon =
    playMode === 'repeat-one'
      ? ModeRepeatOneIcon
      : playMode === 'shuffle'
        ? ModeShuffleIcon
        : ModeSequenceIcon

  // 歌词类型可用性（song-control 三开关的显示条件：当前歌有对应歌词数据才显示）
  const hasOriginalLyric = lyricLines.some((l) => l.text.trim() !== '')
  const hasTransLyric = lyricLines.some(
    (l) => l.translation != null && l.translation.trim() !== ''
  )
  const hasRomaLyric = lyricLines.some(
    (l) => l.roman != null && l.roman.trim() !== ''
  )

  // ===== 渲染 =====
  const queueEmpty = queue.length === 0
  const songName = currentSong?.name ?? '一起听'
  const artist = currentSong?.artist ?? ''

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden">
      {/* ===== 毛玻璃封面背景（设置：开启背景封面模糊；无封面时不渲染，
          切歌时淡入淡出） ===== */}
      {cover && coverBlur && (
        <div
          key={songId}
          className="zen-cover-fade pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[120%] w-[120%] overflow-hidden"
          aria-hidden="true"
        >
          <img
            src={cover}
            alt=""
            className="h-full w-full object-cover"
            style={{
              filter: 'blur(50px) saturate(140%) brightness(1.08)',
              transform: 'scale(1.08)',
            }}
            onError={(e) => {
              e.currentTarget.parentElement?.style.setProperty(
                'display',
                'none'
              )
            }}
          />
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--md-sys-color-surface)_30%,transparent)]" />
        </div>
      )}

      {/* ===== 左上角提示区：房主离线提示 + syncNotice（含房主审批按钮） ===== */}
      <div className="pointer-events-none absolute left-4 top-4 z-30 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2">
        {hostOffline && !canControl && (
          <div
            className="pointer-events-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-tertiary) 15%, transparent)',
              color: 'var(--md-sys-color-tertiary)',
            }}
          >
            房主已离开，您可以自主控制播放
          </div>
        )}
        {syncNotice && (
          <div
            className="pointer-events-auto flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
              color: 'var(--md-sys-color-on-surface)',
            }}
          >
            <span>{syncNotice}</span>
            {isHost && (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={approveControl}
                  className="flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                  title="通过申请"
                >
                  <Check className="h-3 w-3" />
                  通过
                </button>
                <button
                  type="button"
                  onClick={rejectControl}
                  className="flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{ color: 'var(--md-sys-color-error)' }}
                  title="拒绝申请"
                >
                  <X className="h-3 w-3" />
                  拒绝
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* ===== 队列弹窗（Player 页内挂载：与底栏共享 queuePopupOpen 状态，
          从悬浮条原位置附近向上弹出） ===== */}
      {queuePopupOpen && (
        <div className="absolute bottom-[130px] right-[45px] z-50 h-0">
          <MusicQueuePopup
            socket={socket}
            roomId={roomId}
            isHost={isHost}
            canManage={canManage ?? isHost}
          />
        </div>
      )}

      {queueEmpty ? (
        /* 空队列：主区域居中空状态 */
        <div className="relative z-[1] flex flex-1 flex-col items-center justify-center gap-3">
          <div
            className="flex h-16 w-16 items-center justify-center rounded-full"
            style={{ backgroundColor: 'var(--glass-bg)' }}
          >
            <Music
              className="h-8 w-8 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
          </div>
          <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
            还没有歌曲
          </span>
          <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            在主框架搜索添加
          </span>
        </div>
      ) : (
        /* ===== 主内容：左播放卡 + 右歌词面板（Hydrogen .music-player 两栏） ===== */
        <div
          className={cn(
            'relative z-[1] flex h-full min-h-0 items-stretch justify-center',
            isWebFullscreen
              ? 'px-[60px] pb-[50px] pt-8'
              : 'px-[45px] pb-[45px] pt-6'
          )}
        >
          {/* ===== 左侧播放卡（Hydrogen .player-container 两层结构）：
              外层承载入场动画与四角方块（不裁剪，方块出界 0.75vh 完整显示）；
              内层 .player（100%×100% overflow hidden）承载半透明背景与内容 ===== */}
          <div
            className="player-card-in group relative z-[1] w-[42vh] max-w-[calc(100%-2rem)] shrink-0"
            style={{ padding: '4vh 12px' }}
          >
            {/* 四角黑色实心方块装饰（Hydrogen .border：1.5vh，出界 0.75vh） */}
            <span
              className="pointer-events-none absolute -left-[0.75vh] -top-[0.75vh] z-[100] h-[1.5vh] w-[1.5vh]"
              style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute -right-[0.75vh] -top-[0.75vh] z-[100] h-[1.5vh] w-[1.5vh]"
              style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute -bottom-[0.75vh] -right-[0.75vh] z-[100] h-[1.5vh] w-[1.5vh]"
              style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute -bottom-[0.75vh] -left-[0.75vh] z-[100] h-[1.5vh] w-[1.5vh]"
              style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              aria-hidden="true"
            />

            {/* song-control 悬浮工具栏（Hydrogen .song-control：绝对定位悬出
                卡片右侧 50px，正好落在左卡与右卡的间隙内；常显，hover 卡片时
                重播「信号灯」闪烁动画）。挂在**外层**（内层 overflow-hidden
                会裁掉悬出部分）。图标集为原版 SVG：罗马音 / 翻译 / 原词
                三开关（有对应歌词数据才显示）+ 喜欢 + 播放模式（房主）+
                播放队列 + 收起 */}
            <div className="absolute bottom-[2vh] right-[-50px] z-[10] flex w-[50px] flex-col items-center gap-[3vh] group-hover:animate-[song-control-in_0.3s_both]">
              {hasRomaLyric && (
                <button
                  type="button"
                  onClick={() => setLyricRoma((v) => !v)}
                  className="flex h-[2.5vh] w-[2.5vh] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color: lyricRoma
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricRoma ? '隐藏罗马音' : '显示罗马音'}
                  aria-label="切换罗马音显示"
                >
                  <RomanLyricIcon className="h-[2.5vh] w-[2.5vh]" />
                </button>
              )}
              {hasTransLyric && (
                <button
                  type="button"
                  onClick={() => setLyricTrans((v) => !v)}
                  className="flex h-[2.5vh] w-[2.5vh] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color: lyricTrans
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricTrans ? '隐藏翻译' : '显示翻译'}
                  aria-label="切换翻译显示"
                >
                  <TransLyricIcon className="h-[2.5vh] w-[2.5vh]" />
                </button>
              )}
              {hasOriginalLyric && (
                <button
                  type="button"
                  onClick={() => setLyricOriginal((v) => !v)}
                  className="flex h-[2.5vh] w-[2.5vh] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color: lyricOriginal
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricOriginal ? '隐藏原词' : '显示原词'}
                  aria-label="切换原词显示"
                >
                  <OriginalLyricIcon className="h-[2.5vh] w-[2.5vh]" />
                </button>
              )}
              {canLike && (
                <button
                  type="button"
                  onClick={() => void handleLike()}
                  className="flex h-[2.5vh] w-[2.5vh] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color: liked
                      ? 'var(--md-sys-color-error)'
                      : 'var(--md-sys-color-on-surface)',
                  }}
                  title={liked ? '取消喜欢' : '喜欢这首歌'}
                  aria-label={liked ? '取消喜欢' : '喜欢'}
                >
                  {liked ? (
                    <LikeFilledIcon className="h-[2.5vh] w-[2.5vh]" />
                  ) : (
                    <LikeOutlineIcon className="h-[2.5vh] w-[2.5vh]" />
                  )}
                </button>
              )}
              {isHost && (
                <button
                  type="button"
                  onClick={handleTogglePlayMode}
                  className="flex h-[2.5vh] w-[2.5vh] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  title={`${PLAY_MODE_META[playMode].label}（点击${PLAY_MODE_META[playMode].next}）`}
                  aria-label={`播放模式：${PLAY_MODE_META[playMode].label}`}
                >
                  <PlayModeIcon className="h-[2.5vh] w-[2.5vh]" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setQueuePopupOpen(true)}
                className="flex h-[2.5vh] w-[2.5vh] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                title="播放队列"
                aria-label="播放队列"
              >
                <ListMusic className="h-[2.5vh] w-[2.5vh]" />
              </button>
              <button
                type="button"
                onClick={closePlayerOverlay}
                className="flex h-[2.5vh] w-[2.5vh] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                title="收起播放器"
                aria-label="收起播放器"
              >
                <ChevronDown className="h-[2.5vh] w-[2.5vh]" />
              </button>
            </div>

            {/* 内层 .player：半透明白卡（Hydrogen rgba(255,255,255,0.35) 的 M3 主题
                适配）+ backdrop 模糊 + 内容裁剪（动画期间内容不外溢） */}
            <div
              className="relative flex h-full w-full flex-col overflow-hidden"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-surface) 45%, transparent)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
              }}
            >
              {/* 封面（max-height 38vh + 轻阴影）+ L 形角标内缩动画 */}
              <div className="relative shrink-0 p-[1.5vh]">
                <div
                  className="relative overflow-hidden"
                  style={{ boxShadow: '0 0 8px 0 rgba(0, 0, 0, 0.05)' }}
                >
                  {cover ? (
                    <img
                      src={cover}
                      alt={currentSong?.name ?? ''}
                      className="block w-full object-cover"
                      style={{ maxHeight: '38vh' }}
                    />
                  ) : (
                    <div
                      className="flex aspect-square w-full items-center justify-center"
                      style={{
                        backgroundColor:
                          'var(--md-sys-color-surface-container-high)',
                      }}
                    >
                      <Music
                        className="h-10 w-10 opacity-40"
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      />
                    </div>
                  )}
                </div>
                {/* L 形角标 ×4（4vh，1vh → 0 内缩，延迟 0.65s） */}
                <span
                  className="c-border-in pointer-events-none absolute left-0 top-0 h-[4vh] w-[4vh] border-l-2 border-t-2"
                  style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
                  aria-hidden="true"
                />
                <span
                  className="c-border-in pointer-events-none absolute right-0 top-0 h-[4vh] w-[4vh] border-r-2 border-t-2"
                  style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
                  aria-hidden="true"
                />
                <span
                  className="c-border-in pointer-events-none absolute bottom-0 right-0 h-[4vh] w-[4vh] border-b-2 border-r-2"
                  style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
                  aria-hidden="true"
                />
                <span
                  className="c-border-in pointer-events-none absolute bottom-0 left-0 h-[4vh] w-[4vh] border-b-2 border-l-2"
                  style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
                  aria-hidden="true"
                />
              </div>

              {/* 歌曲信息：歌名（黑块滑入遮字 + 跑马灯）+ 歌手（小方点 + 名） */}
              <div className="shrink-0 px-[1.5vh] pt-[1vh]">
                {/* 歌名行（Hydrogen .music-name-lable 黑色滑块切歌动画） */}
                <div className="relative min-w-0">
                  <OverflowMarquee
                    text={songName}
                    className="text-[2.4vh] font-bold leading-[2.9vh] text-[var(--md-sys-color-on-surface)]"
                  />
                  {/* 黑色滑块：默认藏在左侧（露 5px 小方块），切歌时滑入遮住整行 */}
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-0 h-[2.9vh] w-full transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.12,1)]"
                    style={{
                      backgroundColor: 'var(--md-sys-color-on-surface)',
                      transform: songSwitching
                        ? 'translateX(0)'
                        : 'translateX(calc(-100% + 5px))',
                    }}
                  />
                </div>
                {/* 歌手行（Hydrogen .music-author-lable 小方点 + 作者名） */}
                <div className="mt-[0.6vh] flex min-w-0 items-center gap-2">
                  <span
                    className="relative block h-2 w-2 shrink-0"
                    style={{ border: '0.5px solid rgb(105, 105, 105)' }}
                    aria-hidden="true"
                  >
                    <span
                      className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2"
                      style={{
                        backgroundColor: 'var(--md-sys-color-on-surface)',
                      }}
                    />
                  </span>
                  <span className="min-w-0 truncate text-[1.4vh] text-[var(--md-sys-color-on-surface-variant)]">
                    {artist || ' '}
                  </span>
                </div>
              </div>

              {/* 控制区（Hydrogen .player-control：进度 / 三键 / 音量 纵向分布） */}
              <div className="flex min-h-0 flex-1 flex-col justify-between px-[1.5vh] pb-[1vh] pt-[1.5vh]">
                {/* 进度区：时间行（1.5vh）+ 细黑条滑块（1.3vh + 0.5px 描边） */}
                <div className="shrink-0">
                  <div className="flex items-center justify-between text-[1.5vh] font-bold tabular-nums text-[var(--md-sys-color-on-surface)]">
                    <span>{formatDuration(positionSec)}</span>
                    <span>{formatDuration(durationSec)}</span>
                  </div>
                  <div
                    ref={progressRef}
                    role="slider"
                    aria-label={
                      canControl ? '播放进度' : '播放进度（仅房主可拖动）'
                    }
                    aria-valuemin={0}
                    aria-valuemax={Math.round(durationSec)}
                    aria-valuenow={Math.round(positionSec)}
                    aria-disabled={!canControl}
                    className={cn(
                      'relative mt-[1vh] h-[1.3vh]',
                      canControl && 'cursor-pointer'
                    )}
                    style={{
                      boxShadow: '0 0 0 0.5px var(--md-sys-color-on-surface)',
                    }}
                    onPointerDown={handleProgressPointerDown}
                  >
                    <div
                      className="absolute left-0 top-0 h-full"
                      style={{
                        width: `${progressRatio * 100}%`,
                        backgroundColor: 'var(--md-sys-color-on-surface)',
                      }}
                    />
                  </div>

                  {/* 音频可视化（设置：音频可视化 → EQ 频谱动画于进度条下方） */}
                  {audioVisualizer && (
                    <div
                      className="flex shrink-0 items-center justify-center pt-[0.6vh]"
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                    >
                      <EqBars paused={!isPlaying} />
                    </div>
                  )}
                </div>

                {/* 三键控制（5vh，原版线条式 SVG：< 形箭头 / 描边三角 / 双竖线；
                    active 缩放 0.9） */}
                <div className="flex shrink-0 items-center justify-evenly">
                  <button
                    type="button"
                    className="flex h-[5vh] w-[5vh] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                    onClick={handlePrev}
                    title={canControl ? '上一首' : '向房主申请切换上一首'}
                    aria-label="上一首"
                  >
                    <ControlPrevIcon className="h-[5vh] w-[5vh]" />
                  </button>
                  <button
                    type="button"
                    className="flex h-[5vh] w-[5vh] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
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
                      <ControlPauseIcon className="h-[5vh] w-[5vh]" />
                    ) : (
                      <ControlPlayIcon className="h-[5vh] w-[5vh]" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="flex h-[5vh] w-[5vh] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                    onClick={handleNext}
                    title={canControl ? '下一首' : '向房主申请切换下一首'}
                    aria-label="下一首"
                  >
                    <ControlNextIcon className="h-[5vh] w-[5vh]" />
                  </button>
                </div>

                {/* 音量区（滑块与进度同款 + VOLUME 标签与百分比） */}
                <div className="shrink-0">
                  <div
                    ref={volumeTrackRef}
                    role="slider"
                    aria-label="音量"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(volume * 100)}
                    className="relative h-[1.3vh] cursor-pointer"
                    style={{
                      boxShadow: '0 0 0 0.5px var(--md-sys-color-on-surface)',
                    }}
                    onPointerDown={handleVolumePointerDown}
                  >
                    <div
                      className="absolute left-0 top-0 h-full"
                      style={{
                        width: `${volume * 100}%`,
                        backgroundColor: 'var(--md-sys-color-on-surface)',
                      }}
                    />
                  </div>
                  <div className="mt-[1vh] flex items-center justify-between text-[1.5vh] font-bold text-[var(--md-sys-color-on-surface)]">
                    <span className="tracking-widest">VOLUME</span>
                    <span className="tabular-nums">
                      {Math.round(volume * 100)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ===== 右侧歌词面板（Hydrogen .right-panel：宽度固定计算
              calc(100% - 42vh - 50px)，卡片入场动画展开时面板保持不动） ===== */}
          <div className="ml-[50px] flex h-full w-[calc(100%-42vh-50px)] min-w-0 flex-col">
            <PlayerLyricPanel
              lines={lyricLines}
              activeIndex={activeLyricIndex}
              positionSec={positionSec}
              emptyMode={emptyMode}
              revealed={lyricRevealed}
              showTranslation={showTranslation}
              showOriginal={lyricOriginal}
              showRoman={lyricRoma}
              lyricSize={lyricSize}
              tlyricSize={tlyricSize}
              rlyricSize={rlyricSize}
              interludeThresholdSec={lyricInterlude}
              lyricBlur={lyricBlur}
              onSeek={handleLyricSeek}
            />
          </div>
        </div>
      )}

      {/* 音质标识（Hydrogen 右下角 music-quality：当前音质档位大写 + 方块装饰） */}
      <div className="pointer-events-none absolute bottom-4 right-6 z-[6] flex items-center gap-1.5">
        <span
          className="text-xs font-medium tracking-wide"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          {level.toUpperCase()}
        </span>
        <span
          className="h-2 w-2"
          style={{
            border: '1px solid var(--md-sys-color-on-surface-variant)',
          }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
