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
import { Music } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { useIsPortraitMobile, useIsLandscapeShort } from '@/hooks/useMediaQuery'
import { useMusicVideoBackground } from '../hooks/useMusicVideoBackground'
import { useQueueAdd, songToUpsertItem } from '../hooks/useQueueAdd'
import { useMusicStore } from '../store'
import {
  useMusicSettingsStore,
  normalizeBgVideoFit,
  normalizeBiliCoverShape,
} from '../store-settings'
import { useMusicPlayer, MusicPlayerContext } from '../hooks/useMusicPlayer'
import { MusicPlayerProvider } from '../MusicPlayerContext'
import { DanmakuLayer } from '@/components/DanmakuLayer'
import { BiliFavCollectModal } from './BiliFavCollectModal'
import type { LyricLine } from '../utils/lrc'
import {
  applyLyricLineOffsets,
  buildNextLyricLineOffsetStore,
  getLyricOffsetSongKey,
  loadLyricLineOffsetStore,
  saveLyricLineOffsetStore,
  type LyricLineOffsetStore,
} from '../utils/lyricLineOffset'
import { cn } from '@/lib/utils'
import { MusicVideoModal } from './MusicVideoModal'
import {
  COMMENT_TOTAL_EVENT,
  getCommentCountBadge,
  getCommentTargetKey,
  prefetchSongCommentTotal,
} from './SongCommentsPanel'
import { prefetchBiliCommentTotal } from './BiliCommentsPanel'
import { NcmSearchModal } from './NcmSearchModal'
import { CARD_TONE_VARS } from '../utils/playerTone'
import { LYRIC_ADVANCE_SEC, PLAY_MODE_ORDER } from '../constants'
import { PlayerSettingsModal } from './PlayerSettingsModal'
import { useBilibiliDanmaku } from '../hooks/useBilibiliDanmaku'
import { useBackgroundVideoSync } from '../hooks/useBackgroundVideoSync'
import { useLyricTrack } from '../hooks/useLyricTrack'
import { useSongFavorite } from '../hooks/useSongFavorite'
import { useSongQuality } from '../hooks/useSongQuality'
import { useNoticeToast } from '../hooks/useNoticeToast'
import { PlayerBackgroundLayer } from './PlayerBackgroundLayer'
import { PlayerNoticeOverlay } from './PlayerNoticeOverlay'
import { PlayerSongControl } from './PlayerSongControl'
import { PlayerMobileToolbarRow } from './PlayerMobileToolbarRow'
import { PlayerCardFace } from './PlayerCardFace'
import { PlayerLyricPanelShell } from './PlayerLyricPanelShell'
import { useImmersiveMode } from '../hooks/useImmersiveMode'
import { useSeekLock } from '../hooks/useSeekLock'
import { usePlayerUiTone } from '../hooks/usePlayerUiTone'
import { useLandscapeToolbarFlash } from '../hooks/useLandscapeToolbarFlash'
import { useToolbarScrollable } from '../hooks/useToolbarScrollable'
import { useFullscreenToggle } from '../hooks/useFullscreenToggle'

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

  // ===== 手机横屏 song-control 工具栏：默认隐藏，触摸屏幕任意处亮起 3s
  //  （触屏无 hover，常显会常驻压在歌词面板上；桌面矮窗口走 group-hover
  //  分支不受影响）——整簇已抽为 useLandscapeToolbarFlash =====
  const { landscapeToolbarVisible, flashLandscapeToolbar } =
    useLandscapeToolbarFlash(isLandscapeShort)
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

  // ===== 歌词轨道（加载三态 / 网易云歌词请求 / B站 AI 字幕 / 切歌黑块）：
  // 整簇已抽为 useLyricTrack；切歌重置经 onSongSwitch 回调连带重置「喜欢」
  // 乐观态（render 期派生，语义与原内联实现一致） =====
  // 歌词单行偏移仓库（"song:.songId" → { lineKey → offsetSec }，
  // localStorage 持久化，跨会话生效；Hydrogen playerStore.lyricLineOffsets 同语义）
  const [lineOffsetStore, setLineOffsetStore] = useState<LyricLineOffsetStore>(
    () => loadLyricLineOffsetStore()
  )
  const { lyricLines, emptyMode, lyricRevealed, songSwitching } = useLyricTrack(
    {
      songId,
      currentKey,
      biliBvid: currentSong?.biliBvid,
      biliCid: currentSong?.biliCid,
      biliDurationMs: currentSong?.durationMs,
    }
  )

  // ===== 喜欢 / 收藏（网易云 likeSong + B站 红心收藏夹）：整簇已抽为
  //  useSongFavorite（可用性判定、乐观更新、状态查询、B站 收藏开关与回显） =====
  const {
    canLike,
    liked,
    toggleLike: handleLike,
    biliLikeFavTitle,
    biliFavModalOpen,
    setBiliFavModalOpen,
    biliCollected,
    biliCollectedMark,
    setBiliCollectedMark,
    biliCollecting,
    toggleBiliCollect: handleBiliCollect,
  } = useSongFavorite({
    songId,
    biliBvid,
    ncmLoggedIn: loginStatus.loggedIn,
  })

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

  /** 关闭瞬时提示（引用稳定：作为自动消失 effect 的依赖，避免 timer 被重建） */
  const dismissNotice = useCallback(() => setSyncNotice(null), [setSyncNotice])
  const { noticeView, noticeLeaving } = useNoticeToast({
    notice: syncNotice,
    noticeKind: syncNoticeKind,
    dismiss: dismissNotice,
  })

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

  // 歌词类型可用性（song-control 开关的显示条件：当前歌有对应歌词数据才
  // 显示；原词无开关恒显示，不参与）
  const hasTransLyric = lyricLines.some(
    (l) => l.translation != null && l.translation.trim() !== ''
  )
  const hasRomaLyric = lyricLines.some(
    (l) => l.roman != null && l.roman.trim() !== ''
  )

  // ===== 实际音质元数据（Hydrogen song-quality 角标）：整簇已抽为
  //  useSongQuality（/song-quality 查询 + 失败回退设置档位的角标文案） =====
  const qualityLabel = useSongQuality(songId)

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
      <PlayerBackgroundLayer
        cover={cover}
        songId={songId}
        coverBlurPx={coverBlurPx}
        videoUrl={musicVideoBg.source?.url ?? null}
        videoFit={bgVideoFit}
        videoBlurLevel={videoBlurLevel}
        videoRef={bgVideoRef}
        videoHandlers={bgVideoHandlers}
        videoVisible={bgVideoVisible}
        bgDim={bgDim}
        immersive={immersive}
        onImmersiveTap={handleImmersiveTap}
      />

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

      <PlayerNoticeOverlay
        hostOffline={hostOffline}
        canControl={canControl}
        syncNotice={syncNotice}
        noticeLeaving={noticeLeaving}
        noticeView={noticeView}
        isHost={isHost}
        approveControl={approveControl}
        rejectControl={rejectControl}
        immersive={immersive}
      />

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

            <PlayerSongControl
              toolbarRef={toolbarRef}
              flashLandscapeToolbar={flashLandscapeToolbar}
              isLandscapeShort={isLandscapeShort}
              landscapeToolbarVisible={landscapeToolbarVisible}
              toolbarScrollable={toolbarScrollable}
              isPortraitMobile={isPortraitMobile}
              toolbarTone={toolbarTone}
              desktopLyricView={desktopLyricView}
              lyricPanelVisible={lyricPanelVisible}
              onToggleDesktopLyricView={() => setDesktopLyricView((v) => !v)}
              hasRomaLyric={hasRomaLyric}
              lyricRoma={lyricRoma}
              onToggleLyricRoma={() => setLyricRoma((v) => !v)}
              hasTransLyric={hasTransLyric}
              lyricTrans={lyricTrans}
              onToggleLyricTrans={() => setLyricTrans((v) => !v)}
              bgVideoReady={bgVideoReady}
              onEnterImmersive={enterImmersive}
              canLike={canLike}
              liked={liked}
              onLike={handleLike}
              isHost={isHost}
              playMode={playMode}
              onTogglePlayMode={handleTogglePlayMode}
              canComment={canComment}
              rightPanelMode={rightPanelMode}
              commentBadge={commentBadge}
              onToggleCommentPanel={() => {
                setRightPanelMode((v) => (v === 0 ? 1 : 0))
                // 面板被「隐藏歌词」收起时，查看评论/歌词的意图即带出面板
                setDesktopLyricView(true)
              }}
              songId={songId}
              onAddMusicVideo={() => setShowMusicVideo(true)}
              getBiliSourceUrl={buildBiliSourceUrl}
              isBiliSong={isBiliSong}
              biliDanmakuEnabled={biliDanmakuEnabled}
              onToggleDanmaku={() =>
                setMusicSettings({ biliDanmakuEnabled: !biliDanmakuEnabled })
              }
              onOpenNcmSearch={() => setNcmSearchOpen(true)}
              biliBvid={biliBvid}
              biliCollected={biliCollected}
              biliCollectedMark={biliCollectedMark}
              biliLikeFavTitle={biliLikeFavTitle}
              biliCollecting={biliCollecting}
              onBiliCollect={handleBiliCollect}
              onOpenBiliFavModal={() => setBiliFavModalOpen(true)}
              queuePopupOpen={queuePopupOpen}
              onToggleQueuePopup={() => setQueuePopupOpen(!queuePopupOpen)}
              queuePlacement={toolbarScrollable ? 'sheet' : 'side'}
              socket={socket}
              roomId={roomId}
              canManage={canManage ?? isHost}
              onOpenSettings={() => setShowSettings(true)}
              uiTone={uiTone}
              onToggleUiTone={togglePlayerUiTone}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
              onClose={closePlayerOverlay}
            />

            {/* 内层 .player（毛玻璃+透明度解耦 / 卡底 tint / 封面 / 歌曲信息 /
                进度-三键-音量控制区）：整块已抽为 PlayerCardFace（分层原理
                与 38d19ec 指针遮挡回归注释见该组件头） */}
            <PlayerCardFace
              uiTone={uiTone}
              uiFade={uiFade}
              isPortraitMobile={isPortraitMobile}
              isLandscapeShort={isLandscapeShort}
              cover={cover}
              coverAlt={currentSong?.name ?? ''}
              isBiliSong={isBiliSong}
              biliCoverShape={biliCoverShape}
              songName={songName}
              artist={artist}
              songSwitching={songSwitching}
              onSongNameDoubleClick={handleSongNameDoubleClick}
              onPrev={handlePrev}
              onPlayPause={handlePlayPause}
              onNext={handleNext}
              canControl={canControl}
              isPlaying={isPlaying}
              durationSec={durationSec}
              currentKey={currentKey}
              seekLock={seekLock}
              onSeek={seekWithLock}
              onRequestSeek={handleViewerSeek}
              audioVisualizer={audioVisualizer}
              getAudio={getAudio}
              volume={volume}
              volumeDragging={volumeDragging}
              volumeTrackRef={volumeTrackRef}
              onVolumePointerDown={handleVolumePointerDown}
            />
          </div>

          {/* ===== 手机竖屏：水平工具行（替代右侧竖排 song-control——
              竖屏下卡片全宽，右侧 50px 悬出区会出屏；收起走右上角
              常显按钮，此处不再重复。触屏尺寸 32px 保证可点。
              整块已抽为 PlayerMobileToolbarRow） ===== */}
          {isPortraitMobile && (
            <PlayerMobileToolbarRow
              toolbarTone={toolbarTone}
              mobileLyricViewActive={mobileLyricViewActive}
              onToggleMobileLyricView={() => setMobileLyricView((v) => !v)}
              hasRomaLyric={hasRomaLyric}
              lyricRoma={lyricRoma}
              onToggleLyricRoma={() => setLyricRoma((v) => !v)}
              hasTransLyric={hasTransLyric}
              lyricTrans={lyricTrans}
              onToggleLyricTrans={() => setLyricTrans((v) => !v)}
              bgVideoReady={bgVideoReady}
              onEnterImmersive={enterImmersive}
              canLike={canLike}
              liked={liked}
              onLike={handleLike}
              isHost={isHost}
              playMode={playMode}
              onTogglePlayMode={handleTogglePlayMode}
              canComment={canComment}
              rightPanelMode={rightPanelMode}
              commentBadge={commentBadge}
              onToggleCommentPanel={() => {
                setRightPanelMode((v) => (v === 0 ? 1 : 0))
                setMobileLyricView(true)
              }}
              songId={songId}
              onAddMusicVideo={() => setShowMusicVideo(true)}
              getBiliSourceUrl={buildBiliSourceUrl}
              queuePopupOpen={queuePopupOpen}
              onToggleQueuePopup={() => setQueuePopupOpen(!queuePopupOpen)}
              socket={socket}
              roomId={roomId}
              canManage={canManage ?? isHost}
              onOpenSettings={() => setShowSettings(true)}
              uiTone={uiTone}
              onToggleUiTone={togglePlayerUiTone}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
            />
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
          {/* 面板外壳（visibility 闸门 / 冰霜层两段式入场 / 评论区切换 /
              PlayerLyricPanel 接线）：整块已抽为 PlayerLyricPanelShell */}
          {(isPortraitMobile ? mobileLyricViewActive : desktopLyricView) &&
            lyricPanelVisible && (
              <PlayerLyricPanelShell
                isPortraitMobile={isPortraitMobile}
                lyricRevealed={lyricRevealed}
                uiTone={uiTone}
                uiFade={uiFade}
                rightPanelMode={rightPanelMode}
                currentBiliBvid={currentBiliBvid}
                lyricOriginal={lyricOriginal}
                lyricRoma={lyricRoma}
                showTranslation={showTranslation}
                lines={displayLyricLines}
                activeIndex={activeLyricIndex}
                emptyMode={emptyMode}
                lyricSize={lyricSize}
                tlyricSize={tlyricSize}
                rlyricSize={rlyricSize}
                interludeThresholdSec={lyricInterlude}
                lyricBlur={lyricBlur}
                lyricBlurPx={lyricBlurLevel}
                lyricMaskOpacityPct={lyricMaskOpacity}
                lyricMaskBlur={lyricMaskBlur}
                onSeek={handleLyricSeek}
                onUpdateLineOffset={handleUpdateLineOffset}
                qualityLabel={qualityLabel}
              />
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
