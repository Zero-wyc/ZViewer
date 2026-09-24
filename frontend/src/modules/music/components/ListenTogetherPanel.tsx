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
  useSyncExternalStore,
} from 'react'
import {
  getPositionSec,
  subscribePositionSec,
} from '../hooks/usePlaybackPosition'
import {
  ChevronDown,
  Contrast,
  ListMusic,
  MessageCircle,
  AlignLeft,
  Music,
  X,
  Check,
  Film,
  FolderPlus,
  Heart,
  MonitorPlay,
  Search,
  Settings,
  ExternalLink,
  Maximize,
  Minimize,
} from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet, apiPost } from '@/lib/api'
import { useIsPortraitMobile, useIsLandscapeShort } from '@/hooks/useMediaQuery'
import { useMusicVideoBackground } from '../hooks/useMusicVideoBackground'
import { useQueueAdd, songToUpsertItem } from '../hooks/useQueueAdd'
import { useMusicStore } from '../store'
import {
  useMusicSettingsStore,
  normalizeBgVideoFit,
  normalizeBiliCoverShape,
  normalizeBiliLikeFavTitle,
} from '../store-settings'
import { useMusicPlayer, MusicPlayerContext } from '../hooks/useMusicPlayer'
import { MusicPlayerProvider } from '../MusicPlayerContext'
import { DanmakuLayer } from '@/components/DanmakuLayer'
import { message } from '@/components/ui/message'
import { BiliFavCollectModal } from './BiliFavCollectModal'
import { prefetchBiliFavFolders } from '@/modules/bilibili/bilibiliApi'
import { mergeLyrics, type LyricLine } from '../utils/lrc'
import {
  applyLyricLineOffsets,
  buildNextLyricLineOffsetStore,
  getLyricOffsetSongKey,
  loadLyricLineOffsetStore,
  saveLyricLineOffsetStore,
  type LyricLineOffsetStore,
} from '../utils/lyricLineOffset'
import { cn } from '@/lib/utils'
import { OverflowMarquee } from './OverflowMarquee'
import { PlayerLyricPanel } from './PlayerLyricPanel'
import { MusicQueuePopup } from './MusicQueuePopup'
import { MusicVideoModal } from './MusicVideoModal'
import { AudioVisualizer } from './AudioVisualizer'
import {
  SongCommentsPanel,
  COMMENT_TOTAL_EVENT,
  getCommentCountBadge,
  getCommentTargetKey,
  prefetchSongCommentTotal,
} from './SongCommentsPanel'
import {
  BiliCommentsPanel,
  prefetchBiliCommentTotal,
} from './BiliCommentsPanel'
import { NcmSearchModal } from './NcmSearchModal'
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
  ModeOrderIcon,
  RomanLyricIcon,
  TransLyricIcon,
  DanmakuTvIcon,
} from './PlayerControlIcons'
import {
  TOOLBAR_TONE_VARS,
  CARD_TONE_VARS,
  LYRIC_PANEL_TONE_VARS,
  CARD_TINT,
} from '../utils/playerTone'
import {
  SYNC_NOTICE_AUTO_DISMISS_MS,
  LYRIC_ADVANCE_SEC,
  PLAY_MODE_ORDER,
  PLAY_MODE_META,
} from '../constants'
import { badgeWidth } from '../utils/commentBadge'
import { PlayerSettingsModal } from './PlayerSettingsModal'
import { PlayerProgressBar } from './PlayerProgressBar'
import { useBilibiliDanmaku } from '../hooks/useBilibiliDanmaku'
import { useBackgroundVideoSync } from '../hooks/useBackgroundVideoSync'
import { useImmersiveMode } from '../hooks/useImmersiveMode'
import { useSeekLock } from '../hooks/useSeekLock'
import { usePlayerUiTone } from '../hooks/usePlayerUiTone'
import { useToolbarScrollable } from '../hooks/useToolbarScrollable'
import { useFullscreenToggle } from '../hooks/useFullscreenToggle'
import type {
  NcmLyricResponse,
  NcmAccountResponse,
  NcmLikelistResponse,
} from '../types'

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
    syncNoticeKind,
    setSyncNotice,
    isPlaying,
    playMode,
    volume,
    setVolume,
    getAudio,
  } = useMusicPlayer()

  const closePlayerOverlay = useMusicStore((s) => s.closePlayerOverlay)
  const queuePopupOpen = useMusicStore((s) => s.queuePopupOpen)
  const setQueuePopupOpen = useMusicStore((s) => s.setQueuePopupOpen)
  const loginStatus = useMusicStore((s) => s.loginStatus)

  // 手机竖屏：完整播放器切上下单列（封面+控制在上、歌词在下）；
  // 手机横屏仍走双栏（卡片宽由 --lt-card-w clamp 保底）
  const isPortraitMobile = useIsPortraitMobile()
  // 横屏矮窗口（手机横屏全屏 / 桌面矮窗口）：桌面布局的固定大 padding
  // 在矮视口下吃掉近 40% 高度，切紧凑间距
  const isLandscapeShort = useIsLandscapeShort()

  // ===== 手机横屏 song-control 工具栏：默认隐藏，触摸屏幕任意处亮起 3s =====
  // 触屏无 hover，原 lt-touch-visible 常显会让工具栏常驻压在歌词面板上
  // （收起按钮与歌词文本重叠）；桌面矮窗口命中 isLandscapeShort 时仍走
  // group-hover 分支，不受本 state 影响
  const [landscapeToolbarVisible, setLandscapeToolbarVisible] = useState(false)
  const landscapeToolbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const flashLandscapeToolbar = useCallback(() => {
    if (!isLandscapeShort) return
    setLandscapeToolbarVisible(true)
    if (landscapeToolbarTimerRef.current)
      clearTimeout(landscapeToolbarTimerRef.current)
    landscapeToolbarTimerRef.current = setTimeout(
      () => setLandscapeToolbarVisible(false),
      3000
    )
  }, [isLandscapeShort])
  // 离开横屏（转竖屏/桌面）时复位显隐态（渲染期 prop-change 模式）
  const [prevLandscapeShort, setPrevLandscapeShort] = useState(isLandscapeShort)
  if (prevLandscapeShort !== isLandscapeShort) {
    setPrevLandscapeShort(isLandscapeShort)
    if (!isLandscapeShort) setLandscapeToolbarVisible(false)
  }
  useEffect(() => {
    return () => {
      if (landscapeToolbarTimerRef.current)
        clearTimeout(landscapeToolbarTimerRef.current)
    }
  }, [])
  // 手机竖屏歌词视图开关（工具行「歌词」按钮切换）：默认关 = 只显示播放卡
  // （卡片撑满剩余高度）；开启 = 隐藏播放卡、歌词区独占整页
  const [mobileLyricView, setMobileLyricView] = useState(false)
  // 桌面歌词视图开关：右侧歌词面板显隐（手机竖屏走 mobileLyricView，
  // 两态独立；song-control 的歌词/评论按钮会把桌面面板重新带出）
  const [desktopLyricView, setDesktopLyricView] = useState(true)
  // 歌词页快捷设置弹窗（黑底 SETTING 弹窗，承载背景/歌词调整项）
  const [showSettings, setShowSettings] = useState(false)
  // 「在网易云搜索」弹窗（B站 条目专用：歌名提取搜索 + 试听/收藏）
  const [ncmSearchOpen, setNcmSearchOpen] = useState(false)

  const queue = useMusicStore((s) => s.queue)
  const currentKey = useMusicStore((s) => s.currentKey)

  const songId = currentSong?.songId
  const cover = currentSong?.cover

  // ===== 自定义视频背景（Hydrogen PlayerVideo 复刻）：当前歌曲有 B站 视频
  // 关联时，解析（默认 720P 直链 / CLI 开启时高画质 DASH）后作为静音背景
  // 铺满播放器，跟随音乐播放/暂停；B站 本地插播曲目直接用其视频作背景 =====
  const musicVideoCli = useMusicSettingsStore((s) => s.musicVideoCli)
  /** CLI 高画质分辨率（qn，0=自动）：仅 CLI 路径生效，变更即重解析 */
  const musicVideoQn = useMusicSettingsStore((s) => s.musicVideoQn)
  const bgVideoFit = normalizeBgVideoFit(
    useMusicSettingsStore((s) => s.bgVideoFit)
  )
  const biliCoverShape = normalizeBiliCoverShape(
    useMusicSettingsStore((s) => s.biliCoverShape)
  )
  const isBiliSong = currentKey?.startsWith('bili:') ?? false
  /** B站 曲目原视频链接（工具栏跳转按钮）：仅 B站 条目且带 bvid 时生成；
   *  携带当前播放进度（?t= 秒），B站 页面打开后直接从该时间点续看。
   *  进度在点击时命令式读取（getPositionSec），不订阅避免高频重渲染 */
  const biliBvid = isBiliSong ? (currentSong?.biliBvid ?? null) : null
  const buildBiliSourceUrl = useCallback(() => {
    if (!isBiliSong || !biliBvid) return null
    const t = getPositionSec()
    return `https://www.bilibili.com/video/${biliBvid}${
      t >= 1 ? `?t=${Math.floor(t)}` : ''
    }`
  }, [isBiliSong, biliBvid])
  /** B站 评论区目标：使用当前播放 B站 视频的评论区（徽章/面板 key `bili:<bvid>`） */
  const currentBiliBvid = isBiliSong ? (currentSong?.biliBvid ?? null) : null
  /** 评论入口可用性：网易云需有效 songId，B站 条目有 bvid 即可 */
  const canComment = (songId != null && songId > 0) || currentBiliBvid != null

  // ===== B站 音源弹幕（复用一起看弹幕模块 DanmakuLayer）：整条链路已抽为
  //  useBilibiliDanmaku（拉取/缓存/重载对齐/250ms 时间轴驱动） =====
  const biliDanmakuEnabled = useMusicSettingsStore((s) => s.biliDanmakuEnabled)
  /** 工具栏弹幕开关用（与设置弹窗同一 setter） */
  const setMusicSettings = useMusicSettingsStore((s) => s.set)
  // 同 useBackgroundVideoSync：回包含 ref，**必须解构**后再在 render 期读取
  const {
    layerRef: biliDanmakuLayerRef,
    active: biliDanmakuActive,
    aboveUi: biliDanmakuAboveUi,
    style: biliDanmakuStyle,
  } = useBilibiliDanmaku({
    isBiliSong,
    biliCid: currentSong?.biliCid ?? 0,
    enabled: biliDanmakuEnabled,
  })

  const musicVideoBg = useMusicVideoBackground(
    isBiliSong ? null : (songId ?? null),
    musicVideoCli,
    isBiliSong ? (currentSong?.biliBvid ?? null) : null,
    currentSong?.biliCid ?? 0,
    musicVideoQn
  )
  // 背景视频回包的元组成员**必须解构**后使用：整体对象内含 videoRef，
  // 在 render 期做 `bgVideo.xxx` 成员访问会被 react-hooks/refs 规则判为
  // 「渲染期读 ref」而报错
  const {
    videoRef: bgVideoRef,
    visible: bgVideoVisible,
    hasSource: bgVideoReady,
    videoHandlers: bgVideoHandlers,
  } = useBackgroundVideoSync({
    source: musicVideoBg.source,
    status: musicVideoBg.status,
    isPlaying,
  })
  const {
    immersive,
    enter: enterImmersive,
    onTap: handleImmersiveTap,
  } = useImmersiveMode({ available: bgVideoReady, togglePlay })

  // ===== 双击歌名 → 添加当前歌到播放队列（仅网易云歌；B站 视频不响应）。
  // notify 模式：未在队列时入队并弹顶部「已添加」提示；已在队列时先弹
  // 非模态确认提示（同普通提示窗口样式、不影响其他操作，hook 内实现）=====
  const { add: queueAdd } = useQueueAdd(socket, roomId, canManage ?? isHost)
  const handleSongNameDoubleClick = useCallback(() => {
    if (!currentSong || isBiliSong) return
    queueAdd(songToUpsertItem(currentSong), { notify: true })
  }, [currentSong, isBiliSong, queueAdd])

  // ===== 右面板模式（Hydrogen rightPanelMode：0 歌词 / 1 评论区） =====
  const [rightPanelMode, setRightPanelMode] = useState<0 | 1>(0)
  /** 评论数徽章（SongCommentsPanel 广播缓存，万位缩写） */
  const [commentBadge, setCommentBadge] = useState('0')
  useEffect(() => {
    // B站 条目徽章走 `bili:<bvid>`（BiliCommentsPanel 广播），网易云仍走 `song:<songId>`
    const key = currentBiliBvid
      ? `bili:${currentBiliBvid}`
      : getCommentTargetKey(songId ?? -1)
    const refresh = () => setCommentBadge(getCommentCountBadge(key))
    refresh()
    window.addEventListener(COMMENT_TOTAL_EVENT, refresh)
    // 徽章预加载：歌曲加载即后台拉取评论总数写入徽章缓存（缓存命中自动
    // 跳过；评论区面板打开时仍会完整拉取覆盖）——无需先点开评论区
    if (currentBiliBvid) {
      void prefetchBiliCommentTotal(currentBiliBvid)
    } else if (songId != null && songId > 0) {
      void prefetchSongCommentTotal(songId)
    }
    return () => window.removeEventListener(COMMENT_TOTAL_EVENT, refresh)
  }, [currentBiliBvid, songId])

  // ===== 歌词加载状态（区分 无歌词/纯音乐/正常 三态 + 首帧防闪烁） =====
  const [lyricLines, setLyricLines] = useState<LyricLine[]>([])
  const [emptyMode, setEmptyMode] = useState<'none' | 'pure' | null>(null)
  const [lyricRevealed, setLyricRevealed] = useState(false)
  // 歌词单行偏移仓库（"song:.songId" → { lineKey → offsetSec }，
  // localStorage 持久化，跨会话生效；Hydrogen playerStore.lyricLineOffsets 同语义）
  const [lineOffsetStore, setLineOffsetStore] = useState<LyricLineOffsetStore>(
    () => loadLyricLineOffsetStore()
  )
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
            mergeLyrics(
              raw,
              data?.tlyric?.lyric ?? '',
              data?.romalrc?.lyric ?? data?.rlyric?.lyric
            )
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
        // 反闪烁（Hydrogen prepareLyricReveal）：等字体加载完成 + 双帧布局
        // 稳定后再显示歌词区（字体就绪超时 1.5s 兜底，避免阻塞展示）
        const fontsReady = document.fonts?.ready ?? Promise.resolve()
        const timeout = new Promise((resolve) => setTimeout(resolve, 1500))
        Promise.race([fontsReady, timeout]).then(() => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (!cancelled) setLyricRevealed(true)
            })
          )
        })
      }
    }
    void loadLyric()
    return () => {
      cancelled = true
    }
  }, [songId])

  // ===== B站 本地插播曲目：歌词用 AI 字幕（conclusion/get）转换 =====
  useEffect(() => {
    if (!currentKey?.startsWith('bili:')) return
    const bvid = currentSong?.biliBvid
    const cid = currentSong?.biliCid
    if (!bvid || !cid) return
    let cancelled = false
    void (async () => {
      try {
        const { data } = await apiGet<{
          lines?: Array<{ from: number; to: number; content: string }>
        }>(
          `/api/stream/bilibili/ai-subtitle?bvid=${bvid}&cid=${cid}&duration=${Math.round(
            (currentSong?.durationMs ?? 0) / 1000
          )}`
        )
        if (cancelled) return
        const lines: LyricLine[] = (data?.lines ?? [])
          .filter((l) => l.content.trim() !== '')
          .map((l, i) => ({
            time: l.from,
            text: l.content,
            lyricLineKey: `bili:${bvid}:${cid}:${i}`,
          }))
        setLyricLines(lines)
        setEmptyMode(lines.length > 0 ? null : 'none')
      } catch {
        if (!cancelled) {
          // AI 字幕不可用（未登录 B站/视频无字幕）：显示无歌词占位
          setLyricLines([])
          setEmptyMode('none')
        }
      }
      const fontsReady = document.fonts?.ready ?? Promise.resolve()
      const timeout = new Promise((resolve) => setTimeout(resolve, 800))
      Promise.race([fontsReady, timeout]).then(() => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (!cancelled) setLyricRevealed(true)
          })
        )
      })
    })()
    return () => {
      cancelled = true
    }
  }, [
    currentKey,
    currentSong?.biliBvid,
    currentSong?.biliCid,
    currentSong?.durationMs,
  ])

  // ===== 切歌黑块滑出定时（700ms 后滑出露出新歌名） =====
  useEffect(() => {
    if (!songSwitching) return
    const timer = setTimeout(() => setSongSwitching(false), 700)
    return () => clearTimeout(timer)
  }, [songSwitching])

  // ===== 喜欢（Hydrogen likeSong：NCM 登录后可见） =====
  // 查询当前喜欢状态（/account 取 uid → /likelist 取 ids；异步回调内 setState）
  const canLike = loginStatus.loggedIn && songId != null && songId > 0

  // ===== B站 收藏（歌词页工具栏）：直接收藏到「红心收藏夹」（与播放条
  // 红心同语义同后端）+ 打开收藏夹选择弹窗；已收藏记录为本地会话记忆 =====
  const biliLikeFavTitle = normalizeBiliLikeFavTitle(
    useMusicSettingsStore((s) => s.biliLikeFavTitle)
  )
  const [biliFavModalOpen, setBiliFavModalOpen] = useState(false)
  const [biliCollecting, setBiliCollecting] = useState(false)
  /** 红心收藏标记：folder/folderId 为**实际命中**的收藏夹（官方接口查得，
   *  可能不是设置的目标夹——视频可能被在 B站 端收进别的夹/夹改名） */
  const [biliCollectedMark, setBiliCollectedMark] = useState<{
    bvid: string
    folder: string
    folderId?: number
  } | null>(null)
  const biliCollected = biliBvid != null && biliCollectedMark?.bvid === biliBvid
  /** 收藏/取消收藏开关：已收藏（该视频在任意收藏夹中）时点击即取消收藏
   *  （后端 resource/deal del_media_ids，定向到实际命中的收藏夹 id），
   *  否则一键收藏到设置的目标夹 */
  const handleBiliCollect = useCallback(async () => {
    if (!biliBvid || biliCollecting) return
    const collected = biliCollectedMark?.bvid === biliBvid
    setBiliCollecting(true)
    try {
      const { data, ok } = await apiPost<{
        success?: boolean
        message?: string
        folderTitle?: string
        folderId?: number
      }>('/api/stream/bilibili/fav/collect', {
        bvid: biliBvid,
        folderTitle: biliLikeFavTitle,
        action: collected ? 'remove' : 'add',
        // 取消收藏时带实际命中夹的 id，避免按标题解析到别的夹
        ...(collected && biliCollectedMark?.folderId
          ? { mediaId: biliCollectedMark.folderId }
          : {}),
      })
      if (!ok || data?.success === false) {
        throw new Error(
          data?.message || (collected ? '取消收藏失败' : '收藏失败')
        )
      }
      if (collected) {
        setBiliCollectedMark(null)
        message.success(
          `已取消收藏「${
            data?.folderTitle || biliCollectedMark?.folder || biliLikeFavTitle
          }」`
        )
      } else {
        setBiliCollectedMark({
          bvid: biliBvid,
          folder: data?.folderTitle || biliLikeFavTitle,
          folderId: data?.folderId,
        })
        message.success(`已收藏到「${data?.folderTitle || biliLikeFavTitle}」`)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBiliCollecting(false)
    }
  }, [biliBvid, biliCollecting, biliCollectedMark, biliLikeFavTitle])

  // 红心回显：切到 B站 歌曲时用 B站 官方接口查询该视频是否已在收藏夹里
  // （fav/folder/created/list-all 带 rid → fav_state，任意夹命中即点亮，
  //  不限于设置的目标夹；未登录/失败静默，回显是辅助能力不弹错误——
  //  本地会话内的 mark 仍以此查询结果对齐）
  useEffect(() => {
    if (!biliBvid) return
    let cancelled = false
    void (async () => {
      try {
        const { data, ok } = await apiGet<{
          success?: boolean
          collected?: boolean
          folderId?: number
          folderTitle?: string
        }>(
          `/api/stream/bilibili/fav/status?bvid=${biliBvid}&timestamp=${Date.now()}`
        )
        if (cancelled || !ok || data?.success === false) return
        setBiliCollectedMark(
          data?.collected
            ? {
                bvid: biliBvid,
                folder: data.folderTitle ?? biliLikeFavTitle,
                folderId: data.folderId,
              }
            : null
        )
      } catch (err) {
        console.error('[ListenTogether] B站 收藏状态查询失败:', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [biliBvid, biliLikeFavTitle])

  useEffect(() => {
    if (!canLike || songId == null) return
    let cancelled = false
    const query = async () => {
      try {
        const acc = await apiGet<NcmAccountResponse>(
          `/api/music/ncm/user/account?timestamp=${Date.now()}`
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

  /** 带偏移的显示行（原时间 − 行偏移，强制单调防倒序，右键菜单数据源） */
  const displayLyricLines = useMemo(
    () =>
      applyLyricLineOffsets(
        lyricLines,
        lineOffsetStore,
        getLyricOffsetSongKey(songId)
      ),
    [lyricLines, lineOffsetStore, songId]
  )

  /** 行偏移更新：delta>0 提前 / delta<0 延后 / delta=0 重置为本行已生效偏移的负值 */
  const handleUpdateLineOffset = useCallback(
    (line: LyricLine, deltaSec: number) => {
      const songKey = getLyricOffsetSongKey(songId)
      const lineKey = line.lyricLineKey
      if (!songKey || !lineKey) return
      const current = line.lyricLineOffsetSec ?? 0
      const nextOffset = deltaSec !== 0 ? current + deltaSec : -current
      setLineOffsetStore((prev) => {
        const next = buildNextLyricLineOffsetStore(
          prev,
          songKey,
          lineKey,
          nextOffset
        )
        saveLyricLineOffsetStore(next)
        return next
      })
    },
    [songId]
  )

  /**
   * 当前高亮歌词行（最后一个 time <= positionSec + 提前量的行，二分查找）。
   * 快照 = 行索引本身：仅当跨行时才触发本组件重渲染（而非每秒 4-8 次）。
   */
  const activeLyricIndex = useSyncExternalStore(
    subscribePositionSec,
    () => {
      const pos = getPositionSec()
      if (displayLyricLines.length === 0) return -1
      let ans = -1
      let lo = 0
      let hi = displayLyricLines.length - 1
      const target = pos + LYRIC_ADVANCE_SEC
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (displayLyricLines[mid].time <= target) {
          ans = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return ans
    },
    () => -1
  )

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

  // ===== 提示条退出动画：syncNotice 清除后保留最后文案 0.3s 播放上飘
  //  淡出，动画结束才真正卸载（此前直接闪现消失）。状态同步走 render 期
  //  调整（react-hooks 禁止 effect 内同步 setState 与渲染期读 ref），
  //  卸载定时器走 effect；与 MusicAppShell 左上角提示区同构 =====
  const [noticeView, setNoticeView] = useState<{
    text: string
    kind: 'info' | 'approval'
  } | null>(null)
  const [noticeLeaving, setNoticeLeaving] = useState(false)
  if (syncNotice) {
    if (
      noticeLeaving ||
      noticeView?.text !== syncNotice ||
      noticeView?.kind !== syncNoticeKind
    ) {
      setNoticeView({ text: syncNotice, kind: syncNoticeKind })
      setNoticeLeaving(false)
    }
  } else if (noticeView && !noticeLeaving) {
    setNoticeLeaving(true)
  }
  useEffect(() => {
    if (!noticeLeaving) return
    const timer = setTimeout(() => {
      setNoticeLeaving(false)
      setNoticeView(null)
    }, 300)
    return () => clearTimeout(timer)
  }, [noticeLeaving])

  // ===== 进度条（Hydrogen 样式）：抽为独立组件 PlayerProgressBar——
  // 进度经 usePlaybackPosition(0.25) 量化订阅，positionSec 的高频更新只
  // 重渲染进度条本身（含拖动预览），不拖累整块播放面板 =====
  const durationSec = currentSong ? currentSong.durationMs / 1000 : 0

  const { seekLock, seekWithLock, lockOnly } = useSeekLock({ seek, currentKey })

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

  /**
   * 观众 seek 申请：本地只挂等位锁托住展示值（不真 seek 本地音频），
   * 实际跳转由房主端执行——「自动通过」开启时立即执行并广播对齐，
   * 关闭时走左上角审批条；等位锁 2s 超时兜底回落实际进度。
   */
  const handleViewerSeek = useCallback(
    (time: number) => {
      lockOnly(time)
      requestControl('seek', time)
    },
    [lockOnly, requestControl]
  )

  /** 歌词行 seek（房主直接控制；观众转为 seek 申请，同样挂等位锁防回跳） */
  const handleLyricSeek = useCallback(
    (time: number) => {
      if (canControl) seekWithLock(time)
      else handleViewerSeek(time)
    },
    [canControl, seekWithLock, handleViewerSeek]
  )

  /** 播放模式轮换（仅房主，切换后广播同步） */
  const handleTogglePlayMode = useCallback(() => {
    const idx = PLAY_MODE_ORDER.indexOf(playMode)
    const nextMode =
      PLAY_MODE_ORDER[(idx + 1) % PLAY_MODE_ORDER.length] ?? 'order'
    setPlayMode(nextMode)
  }, [playMode, setPlayMode])

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

  // ===== 设置驱动（Hydrogen settingsStore 消费点） =====
  const coverBlur = useMusicSettingsStore((s) => s.coverBlur)
  const coverBlurLevel = useMusicSettingsStore((s) => s.coverBlurLevel)
  const videoBlurLevel = useMusicSettingsStore((s) => s.videoBlurLevel)
  /** 封面背景模糊半径：毛玻璃关闭时 0（显示未模糊封面而非纯色底） */
  const coverBlurPx = coverBlur ? coverBlurLevel : 0
  const bgDim = useMusicSettingsStore((s) => s.bgDim)
  const {
    uiTone,
    toggleUiTone: togglePlayerUiTone,
    toolbarTone,
  } = usePlayerUiTone()
  const { toolbarRef, scrollable: toolbarScrollable } = useToolbarScrollable()
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreenToggle()
  const uiOpacity = useMusicSettingsStore((s) => s.uiOpacity)
  /** UI 毛玻璃模糊浓度（px，0-40）：播放卡/歌词面板冰霜层的模糊半径；
   *  非法值回退默认 12px */
  const uiBlurLevel = useMusicSettingsStore((s) => s.uiBlurLevel)
  const uiBlurPx =
    Number.isFinite(uiBlurLevel) && uiBlurLevel >= 0
      ? Math.min(40, uiBlurLevel)
      : 12
  const lyricBlur = useMusicSettingsStore((s) => s.lyricBlur)
  const lyricBlurLevel = useMusicSettingsStore((s) => s.lyricBlurLevel)
  const lyricMaskOpacity = useMusicSettingsStore((s) => s.lyricMaskOpacity)
  const lyricMaskBlur = useMusicSettingsStore((s) => s.lyricMaskBlur)
  const audioVisualizer = useMusicSettingsStore((s) => s.audioVisualizer)
  const level = useMusicSettingsStore((s) => s.level)
  const lyricSize = useMusicSettingsStore((s) => s.lyricSize)
  const tlyricSize = useMusicSettingsStore((s) => s.tlyricSize)
  const rlyricSize = useMusicSettingsStore((s) => s.rlyricSize)
  const lyricInterlude = useMusicSettingsStore((s) => s.lyricInterlude)
  const defaultShowTrans = useMusicSettingsStore((s) => s.showSongTranslation)

  // ===== 歌词类型开关（Hydrogen lyricType：trans / roma）：
  // 翻译初值取自设置「显示歌曲翻译」；切换为播放器内即时态，不写回设置。
  // 原词无开关恒显示（「隐藏原词」入口已移除），lyricOriginal 固定 true =====
  const [lyricOriginal] = useState(true)
  const [lyricTrans, setLyricTrans] = useState(defaultShowTrans)
  const [lyricRoma, setLyricRoma] = useState(false)
  // 添加视频弹窗（Hydrogen playerStore.addMusicVideo 开关同语义）
  const [showMusicVideo, setShowMusicVideo] = useState(false)
  const showTranslation = lyricTrans

  /** 播放模式图标（四态：顺序循环 / 按顺序播放 / 单曲循环 / 随机） */
  const PlayModeIcon =
    playMode === 'repeat-one'
      ? ModeRepeatOneIcon
      : playMode === 'shuffle'
        ? ModeShuffleIcon
        : playMode === 'order'
          ? ModeOrderIcon
          : ModeSequenceIcon

  // 歌词类型可用性（song-control 开关的显示条件：当前歌有对应歌词数据才
  // 显示；原词无开关恒显示，不参与）
  const hasTransLyric = lyricLines.some(
    (l) => l.translation != null && l.translation.trim() !== ''
  )
  const hasRomaLyric = lyricLines.some(
    (l) => l.roman != null && l.roman.trim() !== ''
  )

  // ===== 实际音质元数据（Hydrogen song-quality 角标：真实采样率/比特率）。
  // 复用 /stream 同构解析链的后端 /song-quality 端点；失败静默回退设置档位 =====
  const [songQuality, setSongQuality] = useState<{
    sr: number
    br: number
    level: string
  } | null>(null)
  // 切歌时清空（render 期调整，替代 effect 内同步 setState）
  const [prevQualitySongId, setPrevQualitySongId] = useState<number | null>(
    typeof songId === 'number' ? songId : -1
  )
  if (prevQualitySongId !== songId) {
    setPrevQualitySongId(typeof songId === 'number' ? songId : -1)
    setSongQuality(null)
  }
  useEffect(() => {
    if (songId == null || songId <= 0) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const { data } = await apiGet<{
          success?: boolean
          sr?: number
          br?: number
          level?: string
        }>(`/api/music/song-quality?songId=${songId}&level=${level}`)
        if (!cancelled) {
          setSongQuality({
            sr: typeof data?.sr === 'number' ? data.sr : 0,
            br: typeof data?.br === 'number' ? data.br : 0,
            level: typeof data?.level === 'string' ? data.level : '',
          })
        }
      } catch {
        if (!cancelled) setSongQuality(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [songId, level])

  /** 音质角标文案（Hydrogen Lyric.vue：`${sr/1000}KHz/${br/1000}Kbps/LEVEL`，
   *  缺失的字段段自动隐藏；上游解析失败时仅显示设置档位） */
  const qualityLabel = useMemo(() => {
    const parts: string[] = []
    if (songQuality && songQuality.sr > 0)
      parts.push(`${songQuality.sr / 1000}KHz`)
    if (songQuality && songQuality.br > 0)
      parts.push(`${Math.round(songQuality.br / 1000)}Kbps`)
    parts.push((songQuality?.level || level).toUpperCase())
    return parts.join('/')
  }, [songQuality, level])

  // ===== 渲染 =====
  // 空态条件 = 队列为空 **且** 没有任何当前曲目：B站 视频插播不入房间
  // 队列（个人插播语义），播放期间 queue 仍为空，此时必须照常渲染主
  // 内容（播放卡 + 歌词 + 视频背景），否则会误显示「还没有歌曲」占位
  const queueEmpty = queue.length === 0 && currentSong == null
  /** 前景 UI 整体透明度（设置：UI 透明度 %，30-100；非法值回退不透明）。
   *  播放卡/歌词面板为「冰霜层 + UI 图层」分层结构：淡出只作用于 UI
   *  图层（底色+内容一起），冰霜层的 backdrop 模糊不参与——模糊与
   *  透明度同时成立（见播放卡渲染处的分层注释） */
  const uiFade =
    Number.isFinite(uiOpacity) && uiOpacity > 0
      ? Math.min(1, Math.max(0.3, uiOpacity / 100))
      : 1
  const songName = currentSong?.name ?? '一起听'
  const artist = currentSong?.artist ?? ''

  // ===== 歌词面板是否真正可见（派生值，非 state）=====
  // 用户开关（桌面 desktopLyricView / 竖屏 mobileLyricView）为「想看歌词」
  // 的意图；但歌词就绪后若判定无歌词（emptyMode='none'）或纯音乐
  // （'pure'），面板只剩空玻璃壳 + Lyric-Area 占位，等同用户手动收起
  // ——直接不渲染面板，播放卡居中。评论区（rightPanelMode===1）不受
  // 无歌词影响，照常展示。
  // 用派生而非 effect 改 state：用户手动开歌词时该曲目无歌词则视图保持
  // 收起，且**开关图标同步呈关闭态**，避免「点亮了却什么都不出现」；
  // 切到有歌词的曲目时 emptyMode 复位 null，面板自动回来。
  const lyricPanelVisible =
    rightPanelMode === 1 || (lyricRevealed && emptyMode === null)

  // 竖屏「歌词独占整页」是否真正生效：开关打开 **且** 有歌词可显示。
  // 无歌词时若仍按开关值隐藏播放卡，而歌词面板又因 lyricPanelVisible
  // 被卸载 → 整页空白。故播放卡的显隐也跟随本值（无歌词自动回到播放卡）
  const mobileLyricViewActive = mobileLyricView && lyricPanelVisible

  // ===== 切歌封面交叉溶解：换曲瞬间快照上一首封面为独立背景层（0.9s
  //       淡出，动画结束即卸载），与新封面 zen-cover-fade 淡入交叠——
  //       当前背景（封面或视频消失后的空档）优雅溶解为下一首封面，
  //       视频就绪后再淡入视频。render 期派生更新（React 官方 props
  //       变化调 state 模式，规避 effect 同步 setState） =====
  const [bgCoverFade, setBgCoverFade] = useState<string | null>(null)
  const [lastRenderCover, setLastRenderCover] = useState<string | null>(
    cover ?? null
  )
  if ((cover ?? null) !== lastRenderCover) {
    setLastRenderCover(cover ?? null)
    if (lastRenderCover) {
      setBgCoverFade(lastRenderCover)
    }
  }

  return (
    <div
      className="relative flex h-full min-w-0 flex-col overflow-hidden"
      // 提示条黑底 alpha 跟随滑块（zen-notice-bar 内 calc 引用）；
      // --lt-ui-blur 为冰霜层模糊半径（设置：UI 模糊浓度）；
      // 文字系变量局部引用到 --lt-glass-*（按「含玻璃层的有效背景」判定
      // 的 scheme 文字色，ThemeProvider 注入）——播放页文字坐在冰霜面板
      // 上，不用全局壁纸级切换的文字色，否则深色模式亮壁纸下全局切深字
      // 会让面板上深字不可读
      style={
        {
          '--lt-ui-alpha': uiFade,
          '--lt-ui-blur': `${uiBlurPx}px`,
          '--md-sys-color-on-surface': 'var(--lt-glass-on-surface)',
          '--md-sys-color-on-surface-variant':
            'var(--lt-glass-on-surface-variant)',
          '--md-sys-color-outline': 'var(--lt-glass-outline)',
          '--md-sys-color-outline-variant': 'var(--lt-glass-outline-variant)',
        } as React.CSSProperties
      }
    >
      {/* ===== 封面背景（Hydrogen 复刻 + 模糊度可调）：有封面即渲染——
          毛玻璃开启时按设置模糊半径模糊，关闭时模糊 0（显示未模糊封面，
          非纯色底）；模糊半径经 --cover-blur 注入 lt-cover-backdrop 的
          CSS 规则。切歌时淡入淡出 ===== */}
      {cover && (
        <div
          key={songId}
          className="lt-cover-backdrop zen-cover-fade pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[120%] w-[120%] overflow-hidden"
          style={
            {
              '--cover-blur': `${coverBlurPx}px`,
            } as React.CSSProperties
          }
          aria-hidden="true"
        >
          <img
            src={cover}
            alt=""
            className="h-full w-full object-cover"
            style={{ transform: 'scale(1.08)' }}
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

      {/* ===== 上一首封面快照（切歌交叉溶解）：盖在新封面之上 0.9s 淡出，
          动画结束即卸载；视频未就绪的空档由此层兜住，背景无黑屏 ===== */}
      {bgCoverFade && (
        <div
          key={bgCoverFade}
          className="lt-cover-backdrop zen-cover-fade-out pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[120%] w-[120%] overflow-hidden"
          style={
            {
              '--cover-blur': `${coverBlurPx}px`,
            } as React.CSSProperties
          }
          aria-hidden="true"
          onAnimationEnd={() => setBgCoverFade(null)}
        >
          <img
            src={bgCoverFade}
            alt=""
            className="h-full w-full object-cover"
            style={{ transform: 'scale(1.08)' }}
          />
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--md-sys-color-surface)_30%,transparent)]" />
        </div>
      )}

      {/* ===== 自定义视频背景（Hydrogen PlayerVideo 复刻）：静音铺满 + 跟随
          音乐播放/暂停，盖在封面模糊背景之上；解析未就绪时自然露出封面
          模糊兜底。纯净模式时提升为 fixed 全屏唯一图层（元素不重挂，
          播放流不断）。视频绑定与解析见 useMusicVideoBackground ===== */}
      {musicVideoBg.source?.url && (
        <>
          {/* ===== contain 黑边填充：放大模糊的封面铺满底层（视频网站
              同款手法），视频 object-contain 完整显示不裁剪，"黑边"
              区域由画面感填充，视觉无黑边（仅完整显示模式需要；
              裁切铺满/拉伸填充下视频本身铺满，无需底层） ===== */}
          {bgVideoFit === 'contain' && (
            <div
              aria-hidden="true"
              className={cn(
                'pointer-events-none overflow-hidden',
                immersive ? 'fixed inset-0 z-[70]' : 'absolute inset-0 z-0'
              )}
            >
              {cover && (
                <img
                  src={cover}
                  alt=""
                  className="h-full w-full scale-125 object-cover"
                  style={{
                    filter: 'blur(60px) brightness(0.75) saturate(120%)',
                  }}
                />
              )}
            </div>
          )}
          {/* 视频本体：画面适配方式随设置（完整显示 contain / 裁切铺满
              cover / 拉伸填充 fill）；纯净模式 fixed 全屏，元素不重挂
              播放流不断）；metadata 就绪即对齐音频进度
              （切歌/中途加入房间时视频直接跳到音频当前进度）。
              可见性门控：首帧可播（canplay/playing）前保持透明——
              视频解析/缓冲期间优雅显示封面背景，就绪后 0.9s ease 淡入；
              视频自身永不接收指针事件（纯净模式点击穿透到点按层） */}
          <video
            ref={bgVideoRef}
            muted
            playsInline
            autoPlay
            loop
            onLoadedMetadata={bgVideoHandlers.onLoadedMetadata}
            onCanPlay={bgVideoHandlers.onCanPlay}
            onPlaying={bgVideoHandlers.onPlaying}
            className={cn(
              'pointer-events-none h-full w-full',
              bgVideoFit === 'cover'
                ? 'object-cover'
                : bgVideoFit === 'fill'
                  ? 'object-fill'
                  : 'object-contain',
              immersive ? 'fixed inset-0 z-[70]' : 'absolute inset-0 z-0'
            )}
            style={{
              opacity: bgVideoVisible ? 1 : 0,
              transition: 'opacity 0.9s ease',
              // 视频背景模糊（设置可调）：模糊边缘会半透明羽化露出底层
              // 封面/纯色底，同步放大 10% 裁掉羽化边（cover/fill 模式）；
              // contain 模式视频本体不铺满，放大无副作用
              ...(videoBlurLevel > 0
                ? {
                    filter: `blur(${videoBlurLevel}px)`,
                    transform: 'scale(1.1)',
                  }
                : {}),
            }}
          />
        </>
      )}

      {/* ===== 背景压暗（设置：背景压暗 %）：黑色遮罩盖在封面/视频背景
          之上、内容之下（DOM 晚于同级 z-0 背景层 → 自然画在其上；
          主内容容器 z-[1] 不受影响）。纯净模式单独在 fixed 视频之上
          叠加（见 immersive 分支 z-[72]） ===== */}
      {bgDim > 0 && !immersive && (
        <div
          aria-hidden="true"
          className="zen-cover-fade pointer-events-none absolute inset-0 z-0"
          style={{ backgroundColor: '#000', opacity: bgDim / 100 }}
        />
      )}

      {/* ===== 纯净模式覆盖层：单击切换播放/暂停（video 保持
          pointer-events-none 让点击穿透），双击屏幕直接退出纯净模式
          （无退出按钮；Esc 仍可退出） ===== */}
      {immersive && (
        <>
          <button
            type="button"
            aria-label="单击切换播放/暂停，双击退出纯净模式"
            onClick={handleImmersiveTap}
            className="fixed inset-0 z-[65] cursor-pointer"
          />
          {/* 背景压暗同样作用于纯净模式：叠在 fixed 视频（z-70）之上，
              保证纯视频画面也跟随同一压暗设置 */}
          {bgDim > 0 && (
            <div
              aria-hidden="true"
              className="pointer-events-none fixed inset-0 z-[72]"
              style={{ backgroundColor: '#000', opacity: bgDim / 100 }}
            />
          )}
        </>
      )}

      {/* ===== B站 音源弹幕层（复用一起看弹幕模块）：仅 B站 条目渲染，
          悬浮铺满整页顶部（显示区域比例随弹幕设置），pointer-events-none
          不挡任何交互。层级随设置切换：UI 上方 = z-10（前景 UI 之上、
          左上角提示 z-30 之下）；UI 底部 = z-1（仅铺在封面/视频背景之上，
          DOM 序早于 z-[1] 前景内容 → 被播放卡/歌词遮挡）；纯净模式一律
          抬升到 fixed 视频（z-70）与压暗层（z-72）之上保持可见 ===== */}
      {biliDanmakuActive && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            zIndex: immersive ? 73 : biliDanmakuAboveUi ? 10 : 1,
          }}
        >
          <DanmakuLayer
            ref={biliDanmakuLayerRef}
            opacity={biliDanmakuStyle.opacity}
            displayArea={biliDanmakuStyle.displayArea}
            density={biliDanmakuStyle.advanced.density}
            speed={biliDanmakuStyle.speed}
            scaleWithScreen={biliDanmakuStyle.scaleWithScreen}
            filters={biliDanmakuStyle.filters}
            advancedStyle={biliDanmakuStyle.advanced}
            fontSize={biliDanmakuStyle.fontSize}
          />
        </div>
      )}

      {/* ===== 左上角提示区：房主离线提示 + syncNotice（含房主审批按钮） ===== */}
      <div
        className={cn(
          'pointer-events-none absolute left-4 top-4 z-30 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 max-md:left-3 max-md:top-3',
          immersive && 'invisible'
        )}
      >
        {hostOffline && !canControl && (
          <div className="zen-notice-bar zen-stagger-fade-up pointer-events-auto flex items-center gap-2 rounded-[14px] px-3.5 py-2 text-xs font-medium">
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--md-sys-color-tertiary)] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--md-sys-color-tertiary)]" />
            </span>
            房主已离开，您可以自主控制播放
          </div>
        )}
        {(syncNotice || noticeLeaving) && noticeView && (
          <div
            className={cn(
              'zen-notice-bar pointer-events-auto flex items-center gap-2.5 rounded-[14px] py-2 pl-3.5 pr-2 text-xs font-medium',
              // 退出动画期间替换入场动画类（上飘淡出后再卸载）
              noticeLeaving ? 'zen-notice-leave' : 'zen-notice-drop-in'
            )}
          >
            <span>{noticeView.text}</span>
            {/* 仅审批类提示（观众控制申请）渲染通过/拒绝按钮；
                纯状态提示（解析进度、结果回执等）不显示；
                退出动画期间 pendingControl 已定，不再渲染 */}
            {isHost && !noticeLeaving && noticeView.kind === 'approval' && (
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={approveControl}
                  className="flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-bold text-[#111114] transition-all hover:opacity-85 active:scale-95"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.92)' }}
                  title="通过申请"
                >
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                  通过
                </button>
                <button
                  type="button"
                  onClick={rejectControl}
                  className="flex h-6 items-center gap-1 rounded-full border border-white/20 px-2.5 text-[11px] font-medium text-[#ff6b6b] transition-colors hover:border-white/35 hover:bg-white/10 active:scale-95"
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

      {/* 队列弹窗不再挂于此处：挂到 song-control 队列按钮旁（下方 song-control 内） */}

      {queueEmpty ? (
        /* 空队列：主区域居中空状态（纯净模式下隐藏） */
        <div
          className={cn(
            'relative z-[1] flex flex-1 flex-col items-center justify-center gap-3',
            immersive && 'invisible'
          )}
          style={uiFade < 1 ? { opacity: uiFade } : undefined}
        >
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
        /* ===== 主内容：左播放卡 + 右歌词面板（Hydrogen .music-player 两栏，
            纵向 padding 对齐 Hydrogen 95px/60px，卡高=减去该 padding 的内容区）。
            手机竖屏切上下单列（卡片全宽居上、歌词居下）；桌面/横屏保持两栏，
            卡宽经 --lt-card-w clamp 保底（横屏矮窗口不至于压成细线） ===== */
        <div
          onPointerDown={isLandscapeShort ? flashLandscapeToolbar : undefined}
          className={cn(
            'relative z-[1] flex h-full min-h-0 items-stretch justify-start',
            'pb-[60px] pt-[95px]',
            isWebFullscreen ? 'px-[60px]' : 'px-[45px]',
            isPortraitMobile &&
              'flex-col justify-start gap-2.5 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-16',
            // 横屏矮窗口（手机横屏全屏歌词页）：固定 pt-95px/pb-60px 会吃掉
            // 近 40% 高度——收紧为固定小间距，把空间还给卡片与歌词面板；
            // song-control 的 50px 专列由播放卡右侧恒定 mr 预留（见卡片
            // 注释），不依赖本容器 gap（触摸屏幕任意处亮起工具栏 3s）
            isLandscapeShort && 'px-4 pb-5 pt-9',
            immersive && 'invisible'
          )}
          style={
            {
              '--lt-card-w': 'clamp(280px, 42vh, 480px)',
            } as React.CSSProperties
          }
        >
          {/* ===== 左侧播放卡（Hydrogen .player-container 两层结构）：
              外层承载入场动画与四角方块（不裁剪，方块出界 0.75vh 完整显示）；
              内层 .player（100%×100% overflow hidden）承载半透明背景与内容。
              手机竖屏歌词视图开启时隐藏，歌词关闭时撑满剩余高度；
              key 随视图切换重挂，切回播放视图时重播入场动画 ===== */}
          <div
            key={
              isPortraitMobile
                ? mobileLyricViewActive
                  ? 'm-hidden'
                  : 'm-card'
                : 'd-card'
            }
            className={cn(
              'player-card-in group relative z-[1] shrink-0',
              isPortraitMobile
                ? cn(
                    'w-full max-w-[420px] self-center',
                    mobileLyricViewActive ? 'hidden' : 'flex-1'
                  )
                : cn(
                    // 右侧恒定 mr-[50px] = song-control 工具栏专列：无论
                    // 工具栏显隐，这 50px 都结构化保留空置（工具栏 absolute
                    // 悬出区恰好落在列内），歌词面板 flex-1 只占剩余宽度，
                    // 任何模式下都不与歌词文本重叠（旧版依赖面板 ml/gap
                    // 间接让位，桌面 ml 丢失后整列压在歌词上）
                    'mr-[50px] w-[var(--lt-card-w)] max-w-[calc(100%-50px-2rem)]'
                  )
            )}
            style={
              {
                padding: '16px 12px',
                paddingBottom: '4vh',
                // 播放卡信息层文字（时间/歌手/VOLUME/进度/三键）与卡底 tint
                // 同源、随播放页 UI 深浅色开关整体翻转：卡底是毛玻璃（tint +
                // 模糊采样），采样内容亮度不定——文字若按主题 scheme 分支，
                // 必然出现浅字配亮底/黑字配暗底的「灰字」失配（用户三轮反馈
                // 的根因）。因此文字色不按主题/端分支，恒与 tint 同组切换
                // （浅色 UI = 纯黑字，on-surface 与 -variant 同值；深色 UI =
                // 纯白字同值），保证任何卡底上对比度确定。light 组为改版前
                // 「恒黑字白底」定稿值（映射见 CARD_TONE_VARS）
                ...CARD_TONE_VARS[uiTone],
              } as React.CSSProperties
            }
          >
            {/* 四角黑色实心方块装饰（Hydrogen .border：1.5vh，出界 0.75vh；
                max() 保底避免横屏矮窗口下缩到不可见） */}
            <span
              className="pointer-events-none absolute -left-[max(0.75vh,4px)] -top-[max(0.75vh,4px)] z-[100] h-[max(1.5vh,8px)] w-[max(1.5vh,8px)]"
              style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute -right-[max(0.75vh,4px)] -top-[max(0.75vh,4px)] z-[100] h-[max(1.5vh,8px)] w-[max(1.5vh,8px)]"
              style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute -bottom-[max(0.75vh,4px)] -right-[max(0.75vh,4px)] z-[100] h-[max(1.5vh,8px)] w-[max(1.5vh,8px)]"
              style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute -bottom-[max(0.75vh,4px)] -left-[max(0.75vh,4px)] z-[100] h-[max(1.5vh,8px)] w-[max(1.5vh,8px)]"
              style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
              aria-hidden="true"
            />

            {/* song-control 工具栏（Hydrogen .song-control：绝对定位悬出
                卡片右侧 50px，落进播放卡恒定 mr-[50px] 预留的专列内——
                该列无论工具栏显隐都结构化保留空置，歌词面板永不与其重叠；
                显示模式同 Hydrogen——基态 opacity:0 常隐（列空置），鼠标
                悬停卡片/工具栏区域时重播「信号灯」闪烁动画并以 both 定格
                在可见，移开即隐（列恢复空置）。
                挂在**外层**（内层 overflow-hidden 会裁掉悬出部分）。
                图标集为原版 SVG：歌词显隐 / 罗马音 / 翻译 / 原词开关
                （歌词三项有对应数据才显示）+ 纯净模式（背景视频就绪时）+
                喜欢 + 播放模式（房主）+ 播放队列 + 设置（背景/歌词调整
                弹窗）+ 收起。
                手机竖屏隐藏（卡片全宽后右侧 50px 悬出区会出屏），改为
                卡片下方的水平工具行（见下方 isPortraitMobile 分支） */}
            <div
              ref={toolbarRef}
              onPointerDown={flashLandscapeToolbar}
              className={cn(
                'lt-icon-outline absolute bottom-[max(2vh,10px)] right-[-50px] z-[10] flex w-[50px] flex-col items-center gap-[max(3vh,14px)]',
                // 显隐模式：桌面 = Hydrogen 同款（基态常隐——专列空置 +
                // hover 信号灯动画定格可见 + 触屏常显兜底）；手机横屏 =
                // 默认隐藏（专列照样占位空置），触摸屏幕任意处亮起 3s 后
                // 淡出（触屏无 hover，常显会常驻压在歌词面板注意力上）
                isLandscapeShort
                  ? cn(
                      'transition-opacity duration-300',
                      landscapeToolbarVisible
                        ? 'opacity-100'
                        : 'pointer-events-none opacity-0'
                    )
                  : cn(
                      'lt-touch-visible opacity-0 focus-within:opacity-100',
                      'group-hover:animate-[song-control-in_0.3s_both]'
                    ),
                // 限高常挂 + 滚动态开放 overflow（原因见 toolbarScrollable
                // 声明处注释）；hide-scrollbar 隐藏滚动条保留触摸滑动
                'max-h-full',
                toolbarScrollable && 'overflow-y-auto hide-scrollbar',
                isPortraitMobile && 'hidden'
              )}
              style={{
                color: 'var(--md-sys-color-on-surface)',
                // 工具栏色调跟随主题深浅（不跟 UI 开关）：文字三色容器级
                // 统一覆盖，按钮的 var() 引用跟随
                ...TOOLBAR_TONE_VARS[toolbarTone],
              }}
            >
              {/* 隐藏/显示歌词（桌面）：隐藏右侧歌词面板、播放卡居中；
                  纯视图级开关，与手机竖屏的 mobileLyricView 相互独立。
                  图标沿用移动端 AlignLeft，显隐语义一致。
                  图标高亮跟随「开关态 且 该曲目确实有歌词可显示」
                  ——无歌词曲目时面板被 lyricPanelVisible 收起，图标同步呈
                  关闭态，避免「点亮了却什么都不出现」的误导 */}
              <button
                type="button"
                onClick={() => setDesktopLyricView((v) => !v)}
                className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                style={{
                  color:
                    desktopLyricView && lyricPanelVisible
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                }}
                title={
                  desktopLyricView && lyricPanelVisible
                    ? '隐藏歌词'
                    : '显示歌词'
                }
                aria-label="切换歌词显示"
                aria-pressed={desktopLyricView && lyricPanelVisible}
              >
                <AlignLeft className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
              </button>
              {hasRomaLyric && (
                <button
                  type="button"
                  onClick={() => setLyricRoma((v) => !v)}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color: lyricRoma
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricRoma ? '隐藏罗马音' : '显示罗马音'}
                  aria-label="切换罗马音显示"
                >
                  <RomanLyricIcon className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {hasTransLyric && (
                <button
                  type="button"
                  onClick={() => setLyricTrans((v) => !v)}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color: lyricTrans
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricTrans ? '隐藏翻译' : '显示翻译'}
                  aria-label="切换翻译显示"
                >
                  <TransLyricIcon className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 纯净模式（背景视频就绪时可用）：隐藏全部界面，仅显示
                  背景视频；原右上角胶囊与收起按钮重叠，移入本工具栏。
                  immersive 时整个面板 invisible，无需额外隐藏本按钮 */}
              {bgVideoReady && (
                <button
                  type="button"
                  onClick={enterImmersive}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                  title="纯净模式：隐藏全部界面，仅显示背景视频"
                  aria-label="进入纯净模式"
                >
                  <MonitorPlay className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {canLike && (
                <button
                  type="button"
                  onClick={() => void handleLike()}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color: liked
                      ? 'var(--md-sys-color-error)'
                      : 'var(--md-sys-color-on-surface)',
                  }}
                  title={liked ? '取消喜欢' : '喜欢这首歌'}
                  aria-label={liked ? '取消喜欢' : '喜欢'}
                >
                  {liked ? (
                    <LikeFilledIcon className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                  ) : (
                    <LikeOutlineIcon className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                  )}
                </button>
              )}
              {isHost && (
                <button
                  type="button"
                  onClick={handleTogglePlayMode}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  title={`${PLAY_MODE_META[playMode].label}（点击${PLAY_MODE_META[playMode].next}）`}
                  aria-label={`播放模式：${PLAY_MODE_META[playMode].label}`}
                >
                  <PlayModeIcon className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 歌词/评论切换（Hydrogen comment-icon：气泡 + 数量胶囊徽章） */}
              {canComment && (
                <button
                  type="button"
                  onClick={() => {
                    setRightPanelMode((v) => (v === 0 ? 1 : 0))
                    // 面板被「隐藏歌词」收起时，查看评论/歌词的意图即带出面板
                    setDesktopLyricView(true)
                  }}
                  className="relative flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  title={rightPanelMode === 1 ? '查看歌词' : '查看评论'}
                  aria-label="切换歌词/评论区"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-full w-full overflow-visible"
                    aria-hidden="true"
                  >
                    <path
                      d="M6.4 5.5h8.3a2.8 2.8 0 0 1 2.8 2.8v5a2.8 2.8 0 0 1-2.8 2.8H9.3l-3.8 3v-3h-.3a2.8 2.8 0 0 1-2.8-2.8v-5a2.8 2.8 0 0 1 2.8-2.8h1.2z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <line
                      x1="7.2"
                      y1="9.9"
                      x2="13.3"
                      y2="9.9"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    />
                    <line
                      x1="7.2"
                      y1="12.6"
                      x2="11.4"
                      y2="12.6"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                    />
                    {/* 评论数徽章（Hydrogen comment-count-pill） */}
                    {commentBadge !== '0' && (
                      <>
                        <rect
                          x={24 - badgeWidth(commentBadge)}
                          y={0.7}
                          width={badgeWidth(commentBadge)}
                          height={9.2}
                          rx={4.6}
                          fill="var(--md-sys-color-on-surface)"
                          opacity={0.96}
                        />
                        <text
                          x={24 - badgeWidth(commentBadge) / 2}
                          y={5.35}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="var(--lt-tone-inverse, var(--md-sys-color-surface))"
                          fontSize={6.8}
                          fontWeight={700}
                        >
                          {commentBadge}
                        </text>
                      </>
                    )}
                  </svg>
                </button>
              )}
              {/* 添加视频（Hydrogen Player.vue toAddMusicVideo 入口） */}
              {songId != null && songId > 0 && (
                <button
                  type="button"
                  onClick={() => setShowMusicVideo(true)}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                  title="添加视频"
                  aria-label="添加视频"
                >
                  <Film className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 前往 B站 原视频（仅 B站 条目）：新标签页打开
                  bilibili.com/video/{bvid}，携带当前进度 ?t= 续看；
                  与网易云条目的「添加视频」槽位互斥复用 */}
              {buildBiliSourceUrl() && (
                <button
                  type="button"
                  onClick={() =>
                    window.open(
                      buildBiliSourceUrl(),
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                  title="在哔哩哔哩打开原视频"
                  aria-label="在哔哩哔哩打开原视频"
                >
                  <ExternalLink className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 弹幕开关（B站 条目）：工具栏一键显示/隐藏弹幕（与设置弹窗
                  总开关同一状态，样式/屏蔽词仍在设置弹窗调整） */}
              {isBiliSong && (
                <button
                  type="button"
                  onClick={() =>
                    setMusicSettings({
                      biliDanmakuEnabled: !biliDanmakuEnabled,
                    })
                  }
                  className={cn(
                    'flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90',
                    !biliDanmakuEnabled && 'opacity-50'
                  )}
                  style={{
                    color: biliDanmakuEnabled
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={biliDanmakuEnabled ? '关闭弹幕' : '开启弹幕'}
                  aria-label="切换弹幕显示"
                  aria-pressed={biliDanmakuEnabled}
                >
                  <DanmakuTvIcon
                    checked={biliDanmakuEnabled}
                    className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]"
                  />
                </button>
              )}
              {/* 在网易云搜索（仅 B站 条目）：自动提取歌名在网易云搜索，
                  结果支持试听/一键收藏到我喜欢的音乐——快速收藏 B站 听到的好歌 */}
              {isBiliSong && (
                <button
                  type="button"
                  onClick={() => setNcmSearchOpen(true)}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                  title="在网易云搜索这首歌"
                  aria-label="在网易云搜索这首歌"
                >
                  <Search className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 直接收藏（B站 条目）：一键收藏到设置的「红心收藏夹」
                  （与播放条红心同后端；实心红心 = 本会话已收藏） */}
              {biliBvid != null && (
                <button
                  type="button"
                  onClick={() => void handleBiliCollect()}
                  disabled={biliCollecting}
                  className={cn(
                    'flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90',
                    biliCollecting && 'animate-pulse'
                  )}
                  style={{
                    color: biliCollected
                      ? 'var(--md-sys-color-error)'
                      : 'var(--md-sys-color-on-surface)',
                  }}
                  title={
                    biliCollected
                      ? `已收藏到「${
                          biliCollectedMark?.folder ?? biliLikeFavTitle
                        }」收藏夹；点击取消收藏`
                      : `一键收藏到「${biliLikeFavTitle}」收藏夹`
                  }
                  aria-label="收藏到收藏夹"
                >
                  <Heart
                    className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]"
                    fill={biliCollected ? 'currentColor' : 'none'}
                  />
                </button>
              )}
              {/* 添加到收藏夹（B站 条目）：打开收藏夹选择弹窗 */}
              {biliBvid != null && (
                <button
                  type="button"
                  onPointerEnter={() => void prefetchBiliFavFolders()}
                  onClick={() => setBiliFavModalOpen(true)}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                  title="添加到收藏夹"
                  aria-label="添加到收藏夹"
                >
                  <FolderPlus className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 播放队列（弹窗侧挂到按钮右侧展开；点击展开、
                  再次点击同一按钮收回，展开态按钮高亮） */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setQueuePopupOpen(!queuePopupOpen)}
                  className={cn(
                    'flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90',
                    queuePopupOpen
                      ? 'text-[var(--md-sys-color-primary)]'
                      : 'text-[var(--md-sys-color-on-surface)]'
                  )}
                  title={queuePopupOpen ? '收起播放队列' : '播放队列'}
                  aria-label="切换播放队列"
                  aria-expanded={queuePopupOpen}
                >
                  <ListMusic className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
                {queuePopupOpen && (
                  <MusicQueuePopup
                    socket={socket}
                    roomId={roomId}
                    isHost={isHost}
                    canManage={canManage ?? isHost}
                    // 工具栏滚动激活后 overflow 会裁剪侧挂弹窗，
                    // 改走 fixed 底部 sheet（见 toolbarScrollable 注释）
                    placement={toolbarScrollable ? 'sheet' : 'side'}
                  />
                )}
              </div>
              {/* 快捷设置（黑底 SETTING 弹窗：背景设置项汇总） */}
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                title="设置"
                aria-label="打开设置"
              >
                <Settings className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
              </button>
              {/* 播放页 UI 深浅色切换：一键翻转播放卡文字/卡底 tint 与
                  歌词面板底色文字（见 uiTone 声明处），localStorage 持久化。
                  工具栏不在其列——工具栏悬在卡外画面背景上，随主题深浅翻转
                  （见 toolbarTone） */}
              <button
                type="button"
                onClick={togglePlayerUiTone}
                className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                title={
                  uiTone === 'light'
                    ? '播放卡/歌词面板：浅色（点击切换为深色）'
                    : '播放卡/歌词面板：深色（点击切换为浅色）'
                }
                aria-label="切换播放页 UI 深浅色"
              >
                <Contrast className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
              </button>
              {/* 全屏切换：整个应用进入/退出全屏（Esc 或再点退出） */}
              <button
                type="button"
                onClick={toggleFullscreen}
                className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                title={isFullscreen ? '退出全屏' : '全屏'}
                aria-label={isFullscreen ? '退出全屏' : '进入全屏'}
              >
                {isFullscreen ? (
                  <Minimize className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                ) : (
                  <Maximize className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                )}
              </button>
              <button
                type="button"
                onClick={closePlayerOverlay}
                className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                title="收起播放器"
                aria-label="收起播放器"
              >
                <ChevronDown className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
              </button>
            </div>

            {/* 内层 .player 两层结构（毛玻璃 + 透明度解耦）：
                ① 冰霜层——常驻满强度 backdrop 模糊（不随 UI 透明度淡出），
                   负责把页面背景模糊成不透明的「磨砂底」；
                ② UI 图层——面板底色 + 全部内容作为一个整体图层，随 UI
                   透明度整体淡出。图层背后是冰霜层（已模糊画面），淡出
                   永远不会露出锐利背景 → 模糊与透明度同时成立。
                   冰霜层/底色 tint 均 pointer-events-none：定位元素绘制在
                   非定位内容之上，不禁用指针会盖住 UI 图层里未加 relative
                   的交互元素（38d19ec 回归：三键播放控制按钮无法点击——
                   进度条/音量条因 track 有 relative 幸免） */}
            <div className="relative flex h-full w-full flex-col overflow-hidden">
              <div
                aria-hidden="true"
                className="lt-blur-surface pointer-events-none absolute inset-0"
                style={{
                  backdropFilter: 'blur(var(--lt-ui-blur, 12px))',
                  WebkitBackdropFilter: 'blur(var(--lt-ui-blur, 12px))',
                }}
              />
              {/* 卡底 tint 层（**在 uiFade 图层之外**）：卡底毛玻璃采样内容
                  亮度不定（亮封面→亮底、暗视频→暗底），信息层文字色恒与卡底
                  同源（见卡容器变量覆盖注释），故 tint 与文字同组随开关切换：
                  浅色 UI = 恒定亮白底（黑字全场景确定对比度），深色 UI = 恒定
                  暗黑底（白字同理）。刻意不放进下面的 uiFade 图层——UI 透明度
                  调低时若连 tint 一起淡出，文字会被稀释成灰、且露出更暗的模糊
                  背景，反而更糊；tint 常驻才能托住文字对比度。
                  竖屏 0.55 / 桌面横屏 0.45（桌面卡面更大，稍低不压背景） */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundColor: isPortraitMobile
                    ? CARD_TINT[uiTone].portrait
                    : CARD_TINT[uiTone].desktop,
                }}
              />
              <div
                className="relative flex h-full w-full flex-col"
                style={uiFade < 1 ? { opacity: uiFade } : undefined}
              >
                {/* 封面（max-height 38vh + 轻阴影）+ L 形角标内缩动画；
                  竖屏手机限高防吃掉控制区 */}
                <div className="relative shrink-0 p-[max(1.5vh,10px)]">
                  <div
                    className="relative overflow-hidden"
                    style={{ boxShadow: '0 0 8px 0 rgba(0, 0, 0, 0.05)' }}
                  >
                    {cover ? (
                      <img
                        src={cover}
                        alt={currentSong?.name ?? ''}
                        className={cn(
                          'block w-full object-cover',
                          // B站歌 + 正方形设置：封面居中裁剪呈正方形显示
                          //（网易云封面本就是正方形，不受此项影响）
                          isBiliSong &&
                            biliCoverShape === 'square' &&
                            'aspect-square'
                        )}
                        style={{
                          maxHeight: isPortraitMobile
                            ? 'min(36dvh, 320px)'
                            : '38vh',
                        }}
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
                  {/* 封面四角括号（Hydrogen Player.vue .c-border1..4：L 形，
                    各角独立贴合动画；终态相对卡边内缩 1vh，与毛玻璃边缘留出间隙；
                    max() 保底横屏矮窗口可见性） */}
                  <span
                    className="c-border-in-tl pointer-events-none absolute left-[max(1vh,5px)] top-[max(1vh,5px)] h-[max(4vh,20px)] w-[max(4vh,20px)] border-l-2 border-t-2"
                    style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
                    aria-hidden="true"
                  />
                  <span
                    className="c-border-in-tr pointer-events-none absolute right-[max(1vh,5px)] top-[max(1vh,5px)] h-[max(4vh,20px)] w-[max(4vh,20px)] border-r-2 border-t-2"
                    style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
                    aria-hidden="true"
                  />
                  <span
                    className="c-border-in-br pointer-events-none absolute bottom-[max(1vh,5px)] right-[max(1vh,5px)] h-[max(4vh,20px)] w-[max(4vh,20px)] border-b-2 border-r-2"
                    style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
                    aria-hidden="true"
                  />
                  <span
                    className="c-border-in-bl pointer-events-none absolute bottom-[max(1vh,5px)] left-[max(1vh,5px)] h-[max(4vh,20px)] w-[max(4vh,20px)] border-b-2 border-l-2"
                    style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
                    aria-hidden="true"
                  />
                </div>

                {/* 歌曲信息：歌名（黑块滑入遮字 + 跑马灯）+ 歌手（小方点 + 名） */}
                <div className="shrink-0 px-[max(1.5vh,10px)] pt-[max(1vh,6px)]">
                  {/* 歌名行（Hydrogen .info-music:first-child：pb 1.2vh + overflow 隐藏；
                    双击加入播放队列——网易云歌弹顶部提示/确认） */}
                  <div
                    className="relative min-w-0 overflow-hidden pb-[max(1.2vh,7px)]"
                    onDoubleClick={handleSongNameDoubleClick}
                    title="双击添加到播放队列"
                  >
                    <div
                      className={cn('min-w-0', songSwitching && 'opacity-0')}
                    >
                      <OverflowMarquee
                        text={songName}
                        className="pl-[max(1.5vh,10px)] text-[max(2.4vh,15px)] font-bold leading-[max(2.9vh,20px)] text-[var(--md-sys-color-on-surface)]"
                      />
                    </div>
                    {/* 黑色滑块：默认藏在左侧（露 5px 竖条，Hydrogen music-name-lable
                      原版样式；文字缩进 1.5vh 与竖条留出间隙），切歌时滑入遮住整行 */}
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-0 h-[max(2.9vh,20px)] w-full transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.12,1)]"
                      style={{
                        backgroundColor: 'var(--md-sys-color-on-surface)',
                        transform: songSwitching
                          ? 'translateX(0)'
                          : 'translateX(calc(-100% + 5px))',
                      }}
                    />
                  </div>
                  {/* 歌手行（Hydrogen .music-author-lable：top1px/left-2px 小方框
                    套 4px 中心点 rgb(105,105,105)；文本 10px 左距 10px）。
                    横屏矮窗口（isLandscapeShort）：迷你三键收纳到行尾右端——
                    高度不足时下方独立三键行取消，控件区不再臃肿 */}
                  <div className="relative flex min-w-0 items-center">
                    <span
                      className="pointer-events-none absolute -left-[2px] top-[1px] block h-2 w-2 shrink-0"
                      style={{ border: '0.5px solid rgb(105, 105, 105)' }}
                      aria-hidden="true"
                    >
                      <span
                        className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2"
                        style={{ backgroundColor: 'rgb(105, 105, 105)' }}
                      />
                    </span>
                    <span className="ml-[10px] min-w-0 truncate text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                      {artist || ' '}
                    </span>
                    {isLandscapeShort && (
                      <div className="ml-auto flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          className="flex h-[max(3.6vh,28px)] w-[max(3.6vh,28px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                          onClick={handlePrev}
                          title={canControl ? '上一首' : '向房主申请切换上一首'}
                          aria-label="上一首"
                        >
                          <ControlPrevIcon className="h-[max(3.6vh,28px)] w-[max(3.6vh,28px)]" />
                        </button>
                        <button
                          type="button"
                          className="flex h-[max(3.6vh,28px)] w-[max(3.6vh,28px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
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
                            <ControlPauseIcon className="h-[max(3.6vh,28px)] w-[max(3.6vh,28px)]" />
                          ) : (
                            <ControlPlayIcon className="h-[max(3.6vh,28px)] w-[max(3.6vh,28px)]" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="flex h-[max(3.6vh,28px)] w-[max(3.6vh,28px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                          onClick={handleNext}
                          title={canControl ? '下一首' : '向房主申请切换下一首'}
                          aria-label="下一首"
                        >
                          <ControlNextIcon className="h-[max(3.6vh,28px)] w-[max(3.6vh,28px)]" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 控制区（Hydrogen .player-control：进度 / 三键 / 音量 纵向分布；
                  滑条挂 touch-slider 禁触屏滚动，vh 尺寸全部 max() 保底，
                  保证横屏矮窗口下仍可读可点） */}
                <div className="flex min-h-0 flex-1 flex-col justify-between px-[max(1.5vh,10px)] pb-[max(1vh,6px)] pt-[max(1.5vh,10px)]">
                  {/* 进度区：时间行（1.5vh）+ 细黑条滑块（1.3vh + 0.5px 描边） */}
                  <div className="shrink-0">
                    <PlayerProgressBar
                      durationSec={durationSec}
                      canControl={canControl}
                      currentKey={currentKey}
                      seekLock={seekLock}
                      onSeek={seekWithLock}
                      onRequestSeek={handleViewerSeek}
                    />

                    {/* 音频可视化（设置：音频可视化 → 真实频谱于进度条下方；
                      captureStream 旁路 WebAudio analyser，Hydrogen 同思路） */}
                    {audioVisualizer && (
                      <div
                        className="flex shrink-0 items-center justify-center pt-[max(0.6vh,4px)]"
                        style={{ color: 'var(--md-sys-color-on-surface)' }}
                      >
                        <AudioVisualizer
                          getAudio={getAudio}
                          playing={isPlaying}
                        />
                      </div>
                    )}
                  </div>

                  {/* 三键控制（5vh，原版线条式 SVG：< 形箭头 / 描边三角 / 双竖线；
                    active 缩放 0.9；max(5vh,36px) 保底触屏可点）。
                    横屏矮窗口时隐藏——三键已收纳到歌手行右端（见上方
                    isLandscapeShort 分支），避免控件区纵向臃肿 */}
                  {!isLandscapeShort && (
                    <div className="flex shrink-0 items-center justify-evenly">
                      <button
                        type="button"
                        className="flex h-[max(5vh,36px)] w-[max(5vh,36px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                        onClick={handlePrev}
                        title={canControl ? '上一首' : '向房主申请切换上一首'}
                        aria-label="上一首"
                      >
                        <ControlPrevIcon className="h-[max(5vh,36px)] w-[max(5vh,36px)]" />
                      </button>
                      <button
                        type="button"
                        className="flex h-[max(5vh,36px)] w-[max(5vh,36px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
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
                          <ControlPauseIcon className="h-[max(5vh,36px)] w-[max(5vh,36px)]" />
                        ) : (
                          <ControlPlayIcon className="h-[max(5vh,36px)] w-[max(5vh,36px)]" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="flex h-[max(5vh,36px)] w-[max(5vh,36px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                        onClick={handleNext}
                        title={canControl ? '下一首' : '向房主申请切换下一首'}
                        aria-label="下一首"
                      >
                        <ControlNextIcon className="h-[max(5vh,36px)] w-[max(5vh,36px)]" />
                      </button>
                    </div>
                  )}

                  {/* 音量区（滑块与进度同款 + VOLUME 标签与百分比；
                    手机端保留——蓝牙/外放场景仍需软件音量）。
                    横屏矮窗口隐藏：物理音量键触手可及，软件音量让位给
                    进度条——高度不足时本区会与进度条重叠出框 */}
                  {!isLandscapeShort && (
                    <div className="shrink-0">
                      <div
                        ref={volumeTrackRef}
                        role="slider"
                        aria-label="音量"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(volume * 100)}
                        className="touch-slider relative h-[max(1.3vh,6px)] cursor-pointer"
                        style={{
                          boxShadow:
                            '0 0 0 0.5px var(--md-sys-color-on-surface)',
                        }}
                        onPointerDown={handleVolumePointerDown}
                      >
                        <div
                          className="absolute left-0 top-0 h-full"
                          style={{
                            width: `${volume * 100}%`,
                            backgroundColor: 'var(--md-sys-color-on-surface)',
                            transition: volumeDragging
                              ? 'none'
                              : 'width 0.3s ease',
                          }}
                        />
                      </div>
                      <div className="mt-[max(1vh,6px)] flex items-center justify-between text-[max(1.5vh,11px)] font-bold text-[var(--md-sys-color-on-surface)]">
                        <span className="tracking-widest">VOLUME</span>
                        <span className="tabular-nums">
                          {Math.round(volume * 100)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ===== 手机竖屏：水平工具行（替代右侧竖排 song-control——
              竖屏下卡片全宽，右侧 50px 悬出区会出屏；收起走右上角
              常显按钮，此处不再重复。触屏尺寸 32px 保证可点） ===== */}
          {isPortraitMobile && (
            <div
              className={cn(
                'lt-icon-outline relative z-[10] flex shrink-0 flex-wrap items-center justify-center gap-1'
              )}
              style={{
                color: 'var(--md-sys-color-on-surface)',
                // 工具栏色调跟随主题深浅（不跟 UI 开关）：文字三色容器级
                // 统一覆盖，按钮的 var() 引用跟随
                ...TOOLBAR_TONE_VARS[toolbarTone],
              }}
            >
              {/* 歌词视图开关：默认只显示播放卡，开启后歌词区独占整页。
                  高亮同桌面：跟随「开关态 且 确实有歌词」，无歌词曲目时
                  歌词视图被自动收起，图标同步呈关闭态 */}
              <button
                type="button"
                onClick={() => setMobileLyricView((v) => !v)}
                className="flex h-8 w-8 items-center justify-center transition-opacity active:scale-90"
                style={{
                  color: mobileLyricViewActive
                    ? 'var(--md-sys-color-on-surface)'
                    : 'var(--md-sys-color-on-surface-variant)',
                }}
                title={mobileLyricViewActive ? '隐藏歌词' : '显示歌词'}
                aria-label="切换歌词显示"
                aria-pressed={mobileLyricViewActive}
              >
                <AlignLeft className="h-5 w-5" />
              </button>
              {hasRomaLyric && (
                <button
                  type="button"
                  onClick={() => setLyricRoma((v) => !v)}
                  className="flex h-8 w-8 items-center justify-center transition-opacity active:scale-90"
                  style={{
                    color: lyricRoma
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricRoma ? '隐藏罗马音' : '显示罗马音'}
                  aria-label="切换罗马音显示"
                >
                  <RomanLyricIcon className="h-5 w-5" />
                </button>
              )}
              {hasTransLyric && (
                <button
                  type="button"
                  onClick={() => setLyricTrans((v) => !v)}
                  className="flex h-8 w-8 items-center justify-center transition-opacity active:scale-90"
                  style={{
                    color: lyricTrans
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricTrans ? '隐藏翻译' : '显示翻译'}
                  aria-label="切换翻译显示"
                >
                  <TransLyricIcon className="h-5 w-5" />
                </button>
              )}
              {/* 纯净模式（手机端）：与桌面 song-control 同一入口 */}
              {bgVideoReady && (
                <button
                  type="button"
                  onClick={enterImmersive}
                  className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                  title="纯净模式：隐藏全部界面，仅显示背景视频"
                  aria-label="进入纯净模式"
                >
                  <MonitorPlay className="h-5 w-5" />
                </button>
              )}
              {canLike && (
                <button
                  type="button"
                  onClick={() => void handleLike()}
                  className="flex h-8 w-8 items-center justify-center transition-opacity active:scale-90"
                  style={{
                    color: liked
                      ? 'var(--md-sys-color-error)'
                      : 'var(--md-sys-color-on-surface)',
                  }}
                  title={liked ? '取消喜欢' : '喜欢这首歌'}
                  aria-label={liked ? '取消喜欢' : '喜欢'}
                >
                  {liked ? (
                    <LikeFilledIcon className="h-5 w-5" />
                  ) : (
                    <LikeOutlineIcon className="h-5 w-5" />
                  )}
                </button>
              )}
              {isHost && (
                <button
                  type="button"
                  onClick={handleTogglePlayMode}
                  className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                  title={`${PLAY_MODE_META[playMode].label}（点击${PLAY_MODE_META[playMode].next}）`}
                  aria-label={`播放模式：${PLAY_MODE_META[playMode].label}`}
                >
                  <PlayModeIcon className="h-5 w-5" />
                </button>
              )}
              {/* 歌词/评论切换（评论数徽章以小圆点形式叠加）：
                  与桌面端同语义——歌词视图收起时，查看评论/歌词的意图
                  即带出面板，否则 mobileLyricView=false 时面板不渲染，
                  手机端永远看不到评论区 */}
              {canComment && (
                <button
                  type="button"
                  onClick={() => {
                    setRightPanelMode((v) => (v === 0 ? 1 : 0))
                    setMobileLyricView(true)
                  }}
                  className="relative flex h-8 w-8 items-center justify-center transition-opacity active:scale-90"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  title={rightPanelMode === 1 ? '查看歌词' : '查看评论'}
                  aria-label="切换歌词/评论区"
                >
                  <MessageCircle className="h-5 w-5" />
                  {commentBadge !== '0' && (
                    <span
                      className="absolute right-0.5 top-0.5 min-w-[14px] rounded-full px-0.5 text-center text-[9px] font-bold leading-[14px]"
                      style={{
                        backgroundColor: 'var(--md-sys-color-on-surface)',
                        color: 'var(--md-sys-color-surface)',
                      }}
                    >
                      {commentBadge}
                    </span>
                  )}
                </button>
              )}
              {/* 添加视频 */}
              {songId != null && songId > 0 && (
                <button
                  type="button"
                  onClick={() => setShowMusicVideo(true)}
                  className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                  title="添加视频"
                  aria-label="添加视频"
                >
                  <Film className="h-5 w-5" />
                </button>
              )}
              {/* 前往 B站 原视频（仅 B站 条目，与桌面 song-control 同语义） */}
              {buildBiliSourceUrl() && (
                <button
                  type="button"
                  onClick={() =>
                    window.open(
                      buildBiliSourceUrl(),
                      '_blank',
                      'noopener,noreferrer'
                    )
                  }
                  className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                  title="在哔哩哔哩打开原视频"
                  aria-label="在哔哩哔哩打开原视频"
                >
                  <ExternalLink className="h-5 w-5" />
                </button>
              )}
              {/* 播放队列（弹窗固定底部居中弹出；点击展开、
                  再次点击同一按钮收回，展开态按钮高亮） */}
              <button
                type="button"
                onClick={() => setQueuePopupOpen(!queuePopupOpen)}
                className={cn(
                  'flex h-8 w-8 items-center justify-center transition-opacity active:scale-90',
                  queuePopupOpen
                    ? 'text-[var(--md-sys-color-primary)]'
                    : 'text-[var(--md-sys-color-on-surface)]'
                )}
                title={queuePopupOpen ? '收起播放队列' : '播放队列'}
                aria-label="切换播放队列"
                aria-expanded={queuePopupOpen}
              >
                <ListMusic className="h-5 w-5" />
              </button>
              {queuePopupOpen && (
                <MusicQueuePopup
                  socket={socket}
                  roomId={roomId}
                  isHost={isHost}
                  canManage={canManage ?? isHost}
                  placement="sheet"
                />
              )}
              {/* 快捷设置（与桌面 song-control 同一弹窗） */}
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                title="设置"
                aria-label="打开设置"
              >
                <Settings className="h-5 w-5" />
              </button>
              {/* 播放页 UI 深浅色切换：与桌面 song-control 同一状态
                  （同样不含工具栏，工具栏随主题） */}
              <button
                type="button"
                onClick={togglePlayerUiTone}
                className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                title={
                  uiTone === 'light'
                    ? '播放卡/歌词面板：浅色（点击切换为深色）'
                    : '播放卡/歌词面板：深色（点击切换为浅色）'
                }
                aria-label="切换播放页 UI 深浅色"
              >
                <Contrast className="h-5 w-5" />
              </button>
              {/* 全屏切换：与桌面 song-control 同一状态（iOS 不支持时静默） */}
              <button
                type="button"
                onClick={toggleFullscreen}
                className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                title={isFullscreen ? '退出全屏' : '全屏'}
                aria-label={isFullscreen ? '退出全屏' : '进入全屏'}
              >
                {isFullscreen ? (
                  <Minimize className="h-5 w-5" />
                ) : (
                  <Maximize className="h-5 w-5" />
                )}
              </button>
            </div>
          )}
          {/* ===== 右侧歌词面板（Hydrogen .right-panel）：flex-1 占据播放卡
              （含右侧 50px 工具栏专列）之外的剩余宽度——专列由卡片恒定
              mr-[50px] 结构化预留，面板宽度与工具栏显隐无关，永不重叠；
              卡片入场动画展开时面板保持不动。
              手机竖屏改为单列下段（flex-1 占满剩余高度）。
              评论模式下整区替换为歌曲评论区，Hydrogen rightPanelMode=1；
              与左侧播放器卡同款半透明 surface + backdrop 模糊，
              避免无封面/未开封面模糊时被上层纯色背景盖住。
              手机竖屏由 mobileLyricView 控制、桌面由 song-control 的
              隐藏歌词开关（desktopLyricView）控制，关闭时不渲染。
              另：歌词就绪后若无歌词/纯音乐，lyricPanelVisible 为 false，
              面板整块不渲染（等同手动收起，注释见该派生值声明处） ===== */}
          {(isPortraitMobile ? mobileLyricViewActive : desktopLyricView) &&
            lyricPanelVisible && (
              <div
                className={cn(
                  'relative flex min-h-0 min-w-0 flex-col overflow-hidden',
                  isPortraitMobile ? 'w-full flex-1' : 'h-full flex-1'
                )}
                // 面板仅在「尚未就绪」时隐藏（visibility 而非 opacity/transform：
                // 容器一旦带 opacity<1 或 transform 就成为 Backdrop Root，后代
                // 冰霜层的 backdrop-filter 采样不到面板外背景，玻璃底会渲染成
                // 不透明白壳——本项目反复踩中的陷阱）。就绪后（含无歌词被
                // 上层条件整块卸载的分支）由冰霜层/内容层各自淡入，见下方
                style={{
                  visibility: lyricRevealed ? 'visible' : 'hidden',
                  // UI 深浅色：容器级覆盖歌词文字（on-surface）与面板底色/
                  // 高亮条反色文字（surface）两令牌，PlayerLyricPanel 全
                  // 令牌化零改动跟随翻转；与 visibility 同层不影响闸门
                  ...LYRIC_PANEL_TONE_VARS[uiTone],
                }}
              >
                {/* 冰霜层：常驻满强度毛玻璃（不随 UI 透明度淡出），同播放卡。
                  歌词就绪后由 lt-lyric-panel-in 淡入——面板的「展开」由此层
                  呈现（玻璃面先出现），内容随后在 0.25s 后跟上，避免现在
                  「先露半展开空壳、再突然弹歌词」的突兀感 */}
                <div
                  aria-hidden="true"
                  className="lt-blur-surface lt-lyric-panel-in pointer-events-none absolute inset-0"
                  style={{
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                  }}
                />
                {/* UI 图层：底色 + 歌词/评论区整体淡出，背后是冰霜层。
                  展开动画必须挂在本层而不能挂面板容器：容器带 transform/
                  opacity 时会成为 Backdrop Root，冰霜层 backdrop-filter
                  采样不到面板外背景，展开动画期间玻璃底会渲染成不透明白框、
                  结束后突然变回毛玻璃（突兀闪变）。
                  时序：冰霜层先淡入（面板玻璃面展开）→ 本层延迟 0.25s 后
                  淡入（歌词浮现），形成「面板先张开、歌词再显现」的两段式，
                  避免旧版「半展开空壳僵住 → 歌词突然弹出」的突兀演出 */}
                <div
                  className="lt-lyric-content-in relative flex min-h-0 min-w-0 flex-col"
                  style={uiFade < 1 ? { opacity: uiFade } : undefined}
                >
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-surface) 45%, transparent)',
                    }}
                  />
                  {rightPanelMode === 1 ? (
                    currentBiliBvid != null ? (
                      <BiliCommentsPanel bvid={currentBiliBvid} />
                    ) : (
                      <SongCommentsPanel />
                    )
                  ) : lyricOriginal ? (
                    <PlayerLyricPanel
                      lines={displayLyricLines}
                      activeIndex={activeLyricIndex}
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
                      lyricBlurPx={lyricBlurLevel}
                      lyricMaskOpacity={lyricMaskOpacity / 100}
                      lyricMaskBlur={lyricMaskBlur}
                      onSeek={handleLyricSeek}
                      onUpdateLineOffset={handleUpdateLineOffset}
                      qualityLabel={qualityLabel}
                    />
                  ) : (
                    /* 原词隐藏 = 完全隐藏歌词：不渲染任何歌词行/翻译/罗马音/
                    高亮条/间奏倒计时——此前仅隐藏原词文本，翻译/罗马音与
                    滚动的高亮黑条会残留，歌词并未真正消失 */
                    <div className="flex-1" aria-hidden="true" />
                  )}
                </div>
              </div>
            )}
        </div>
      )}
      {/* 添加视频弹窗（Hydrogen MusicVideo：无全屏遮罩，绝对居中于播放页；
          搜索成功即按 songId 写入本地关联，驱动视频背景） */}
      {showMusicVideo && (
        <MusicVideoModal
          songId={songId ?? -1}
          songName={songName}
          onClose={() => setShowMusicVideo(false)}
        />
      )}

      {/* 歌词页快捷设置弹窗（纯净模式下不渲染，避免脱离沉浸画面） */}
      {showSettings && !immersive && (
        <PlayerSettingsModal onDismiss={() => setShowSettings(false)} />
      )}

      {/* 在网易云搜索弹窗（B站 条目：歌名提取搜索 + 试听/收藏到我喜欢的音乐） */}
      {ncmSearchOpen && (
        <NcmSearchModal
          open
          sourceTitle={currentSong?.name ?? ''}
          onClose={() => setNcmSearchOpen(false)}
        />
      )}

      {/* B站 收藏夹选择弹窗（工具栏「添加到收藏夹」） */}
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
