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
  usePlaybackPosition,
} from '../hooks/usePlaybackPosition'
import {
  ChevronDown,
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
  MonitorSmartphone,
  MessagesSquare,
  Search,
  Settings,
  ExternalLink,
} from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet, apiPost, getApiUrl } from '@/lib/api'
import { CLI_DEFAULT_PORT, useCliAgent } from '@/hooks/useCliAgent'
import { useIsPortraitMobile } from '@/hooks/useMediaQuery'
import { usePlayerSource } from '@/modules/player'
import { useMusicVideoBackground } from '../hooks/useMusicVideoBackground'
import { useBackdropAwareTone } from '../hooks/useBackdropAwareTone'
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
import {
  DanmakuLayer,
  type DanmakuLayerHandle,
} from '@/components/DanmakuLayer'
import { fetchBilibiliDanmakuByCid } from '@/modules/danmaku/api'
import type { DanmakuItem } from '@/modules/danmaku/types'
import { useDanmakuStore, DEFAULT_DANMAKU_STYLE } from '@/store/danmakuStore'
import {
  DanmakuStylePanel,
  DanmakuAdvancedSettings,
} from '@/modules/room/watch-together/DanmakuStylePanel'
import { FontPickerPanel } from '@/components/ui/FontPicker'
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
import type { PlayMode } from '../types'
import { cn, formatDuration } from '@/lib/utils'
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
  /** 罗马音官方字段名；rlyric 为旧命名兜底 */
  romalrc?: { lyric?: string }
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

/** 评论数徽章胶囊宽度（Hydrogen commentCountBadgeWidth 简化：首字符 13.8，后续每字符约 +7） */
function badgeWidth(text: string): number {
  return 13.8 + Math.max(0, text.length - 1) * 7
}

/** 歌词高亮提前量（秒）：接近下一行时间标签前即切换高亮 */
const LYRIC_ADVANCE_SEC = 0.2

/** 播放模式轮换顺序（order = 按顺序播放，不循环；B站 推荐连播仅此模式启用） */
const PLAY_MODE_ORDER: PlayMode[] = [
  'sequence',
  'order',
  'repeat-one',
  'shuffle',
]

const PLAY_MODE_META: Record<PlayMode, { label: string; next: string }> = {
  sequence: { label: '顺序循环', next: '切换为按顺序播放' },
  order: { label: '按顺序播放', next: '切换为单曲循环' },
  'repeat-one': { label: '单曲循环', next: '切换为随机播放' },
  shuffle: { label: '随机播放', next: '切换为顺序循环' },
}

/**
 * 从图片/视频当前帧采样平均亮度（0-1，Rec.709 加权）。
 * 16×16 canvas 足够反映整体明暗；跨域污染（tainted canvas）等异常返回 null。
 */
/** 视频背景进度同步的漂移校正阈值（秒）：播放中音视频偏差超过该值才安排 seek，
 *  避免每次 timeupdate 都 seek 造成视频反复卡顿 */
const BG_VIDEO_SYNC_THRESHOLD_SEC = 1.5
/** 大漂移 seek 的去抖窗口（毫秒）：拖动进度条期间只更新目标位置，
 *  停止后仅执行一次 seek——避免拖动过程连续大跨度 seek 导致的性能猛增 */
const BG_VIDEO_SEEK_DEBOUNCE_MS = 350
/** 追赶完成判定（秒）：seek 后残余漂移小于该值视为已同步，恢复原速 */
const BG_VIDEO_CATCHUP_EPSILON_SEC = 0.35
/** 追赶增益（秒）：rate = 1 + drift / 该值，漂移越大追得越快（约 4s 收敛） */
const BG_VIDEO_CATCHUP_GAIN_SEC = 4
/** 追赶 playbackRate 上下限：顺序解码远比随机 seek 便宜，用倍速慢慢吸收
 *  seek 耗时内音频多走的量（背景视频无声，轻微变速无感知） */
const BG_VIDEO_MAX_RATE = 1.5
const BG_VIDEO_MIN_RATE = 0.6

/** 极简滑轨（设置弹窗内嵌）：pointer 拖动即时回调，touch-slider 防触屏滚动 */
function TinySlider({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  const applyFromClientX = (clientX: number) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const snapped = Math.round((min + ratio * (max - min)) / step) * step
    onChange(Math.min(max, Math.max(min, Number(snapped.toFixed(2)))))
  }
  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      className="touch-slider relative h-6 cursor-pointer"
      onPointerDown={(e) => {
        e.preventDefault()
        applyFromClientX(e.clientX)
        const move = (ev: PointerEvent) => applyFromClientX(ev.clientX)
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/20" />
      <div
        className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)]"
        style={{ left: `${pct}%` }}
      />
    </div>
  )
}

/** 黑底弹窗内嵌 MD3 弹幕设置面板的变量作用域覆盖：DanmakuStylePanel /
 *  DanmakuAdvancedSettings / Slider / Switch / FontPickerPanel 均消费
 *  --md-sys-color-* 令牌，弹窗为纯黑底，按弹窗白主题语言（primary=白，
 *  与弹窗 toggle/双按钮一致）覆写暗色值 */
const DANMAKU_PANEL_TOKEN_OVERRIDES = {
  '--md-sys-color-on-surface': '#ececf0',
  '--md-sys-color-on-surface-variant': '#c6c6ce',
  '--md-sys-color-outline': '#8f8f97',
  '--md-sys-color-outline-variant': 'rgba(255, 255, 255, 0.24)',
  '--md-sys-color-primary': '#ffffff',
  '--md-sys-color-on-primary': '#000000',
  '--md-sys-color-primary-container': 'rgba(255, 255, 255, 0.92)',
  '--md-sys-color-on-primary-container': '#0a0a0a',
  '--md-sys-color-secondary-container': 'rgba(255, 255, 255, 0.14)',
  '--md-sys-color-on-secondary-container': '#f2f2f5',
  '--md-sys-color-surface': '#141418',
  '--md-sys-color-surface-container-high': 'rgba(255, 255, 255, 0.08)',
  '--md-sys-color-surface-container-highest': 'rgba(255, 255, 255, 0.12)',
  '--glass-bg': 'rgba(255, 255, 255, 0.08)',
} as React.CSSProperties

/** 歌词页快捷设置弹窗（Hydrogen「添加到我的歌单」弹窗同视觉语言改版）：
 * 黑底 + 高斯模糊 backdrop，顶部「设置」标题后压超大 SETTING 水印字，
 * 四角白色方块点缀；承载「一起听设置」的背景项（封面模糊 / 背景压暗 /
 * 视频背景 CLI 高画质），与设置页同一设置项、改动即时持久化。
 * 点遮罩或 Esc 关闭。 */
function PlayerSettingsModal({
  onDismiss,
  roomId,
}: {
  onDismiss: () => void
  roomId: string
}) {
  const coverBlur = useMusicSettingsStore((s) => s.coverBlur)
  const coverBlurLevel = useMusicSettingsStore((s) => s.coverBlurLevel)
  const bgDim = useMusicSettingsStore((s) => s.bgDim)
  const uiOpacity = useMusicSettingsStore((s) => s.uiOpacity)
  const musicVideoCli = useMusicSettingsStore((s) => s.musicVideoCli)
  const bgVideoFit = normalizeBgVideoFit(
    useMusicSettingsStore((s) => s.bgVideoFit)
  )
  const biliCoverShape = normalizeBiliCoverShape(
    useMusicSettingsStore((s) => s.biliCoverShape)
  )
  /** B站 红心收藏目标（播放栏 B站 条目红心一键收藏的收藏夹名） */
  const biliLikeFavTitle = normalizeBiliLikeFavTitle(
    useMusicSettingsStore((s) => s.biliLikeFavTitle)
  )
  const lyricBlur = useMusicSettingsStore((s) => s.lyricBlur)
  const lyricBlurLevel = useMusicSettingsStore((s) => s.lyricBlurLevel)
  const setSettings = useMusicSettingsStore((s) => s.set)

  // ===== CLI 高画质代理（BilibiliParseSettings 同构面板）：连接状态检测 +
  //       配置页入口（CLI 开关状态即 musicVideoCli 设置项本身） =====
  const cliAgent = useCliAgent(roomId)
  const cliAvailable = cliAgent.available
  const openCliSetup = () => {
    const url = new URL(`http://127.0.0.1:${CLI_DEFAULT_PORT}/`)
    url.searchParams.set('server', getApiUrl())
    url.searchParams.set('room', roomId)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  // ===== B站 弹幕设置（复用一起看弹幕设置组件）：总开关即 biliDanmakuEnabled
  //       设置项；样式面板与一起看共用 danmakuStore（跨页持久化生效） =====
  const biliDanmakuEnabled = useMusicSettingsStore((s) => s.biliDanmakuEnabled)
  const biliDanmakuAboveUi = useMusicSettingsStore((s) => s.biliDanmakuAboveUi)
  const danmakuStyle = useDanmakuStore((s) => s.style)
  const setDanmakuStyle = useDanmakuStore((s) => s.setStyle)
  const setDanmakuFilters = useDanmakuStore((s) => s.setFilters)
  const setDanmakuAdvanced = useDanmakuStore((s) => s.setAdvancedStyle)
  const resetDanmakuStyle = useDanmakuStore((s) => s.resetStyle)
  const [danmakuAdvancedOpen, setDanmakuAdvancedOpen] = useState(false)
  const [danmakuFontOpen, setDanmakuFontOpen] = useState(false)

  // ===== 红心收藏夹行内编辑态（点击名称胶囊 → 输入框，Enter/失焦保存，
  //       Escape 放弃；空白提交由归一化回退默认「Music」） =====
  const [favTitleEditing, setFavTitleEditing] = useState(false)
  /** 面板展开动画是否已结束（设置项延后挂载，动画期间零渲染） */
  const [unfoldDone, setUnfoldDone] = useState(false)
  const [favTitleDraft, setFavTitleDraft] = useState(biliLikeFavTitle)
  const commitFavTitle = () => {
    setSettings({ biliLikeFavTitle: normalizeBiliLikeFavTitle(favTitleDraft) })
    setFavTitleEditing(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <>
      {/* 遮罩（黑半透明，点击关闭） */}
      <button
        type="button"
        aria-label="关闭设置"
        className="fixed inset-0 z-[74] cursor-default bg-black/40"
        onClick={onDismiss}
      />
      <div
        className="fixed left-1/2 top-1/2 z-[75] flex w-[min(340px,calc(100vw-32px))] flex-col overflow-hidden"
        style={
          {
            transform: 'translate(-50%, -50%)',
            '--add-panel-w': 'min(340px, calc(100vw - 32px))',
            '--add-panel-h': 'min(674px, calc(100vh - 120px))',
            animation: 'cloud-add-in 0.4s 0.1s both',
            backgroundColor: 'rgba(8, 8, 8, 0.86)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '0.5px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)',
          } as React.CSSProperties
        }
        onAnimationEnd={(e) => {
          if (
            e.target === e.currentTarget &&
            e.animationName === 'cloud-add-in'
          ) {
            setUnfoldDone(true)
          }
        }}
      >
        {/* 四角白色方块点缀（Hydrogen 弹窗同款装饰） */}
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
        {/* 标题行：超大 SETTING 水印压在「设置」后面（左对齐、允许溢出裁剪） */}
        <div className="relative border-b border-white/70 px-5 pb-3 pt-4">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
          >
            SETTING
          </span>
          <p className="relative text-center text-[15px] font-bold text-white">
            设置
          </p>
        </div>
        {/* 背景设置项（与「一起听设置」同一 store，即时持久化）；
            展开动画结束后挂载（动画期间零渲染），内容超出面板高度滚动 */}
        {unfoldDone && (
          <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
            {/* 毛玻璃封面背景 */}
            <div className="flex items-center justify-between gap-3 px-5 py-3.5">
              <span className="text-[13px] font-bold text-white">
                毛玻璃封面背景
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={coverBlur}
                aria-label="毛玻璃封面背景"
                onClick={() => setSettings({ coverBlur: !coverBlur })}
                className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                style={{
                  backgroundColor: coverBlur
                    ? '#ffffff'
                    : 'rgba(255, 255, 255, 0.22)',
                }}
              >
                <span
                  className="absolute top-0.5 h-4 w-4 rounded-full transition-all duration-200"
                  style={{
                    left: coverBlur ? '18px' : '2px',
                    backgroundColor: coverBlur ? '#000000' : '#ffffff',
                  }}
                />
              </button>
            </div>
            {/* 封面模糊度（毛玻璃开启时的模糊半径；拖到 0 视为关闭，
              与歌词模糊/模糊浓度的联动语义一致） */}
            <div className="px-5 py-3.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[13px] font-bold text-white">模糊度</span>
                <span className="text-[12px] font-bold tabular-nums text-white/70">
                  {coverBlur ? `${coverBlurLevel}px` : '关闭'}
                </span>
              </div>
              <TinySlider
                value={coverBlurLevel}
                min={0}
                max={100}
                step={1}
                onChange={(v) =>
                  setSettings({ coverBlurLevel: v, coverBlur: v > 0 })
                }
              />
            </div>
            {/* 背景压暗（滑块） */}
            <div className="px-5 py-3.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[13px] font-bold text-white">
                  背景压暗
                </span>
                <span className="text-[12px] font-bold tabular-nums text-white/70">
                  {bgDim > 0 ? `${bgDim}%` : '关闭'}
                </span>
              </div>
              <TinySlider
                value={bgDim}
                min={0}
                max={100}
                step={1}
                onChange={(v) => setSettings({ bgDim: v })}
              />
            </div>
            {/* UI 透明度（滑块）：前景 UI（播放卡/歌词面板/工具栏等）整体
              透明度，背景（封面/视频/压暗）不受影响；100=默认不透明 */}
            <div className="px-5 py-3.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[13px] font-bold text-white">
                  UI 透明度
                </span>
                <span className="text-[12px] font-bold tabular-nums text-white/70">
                  {uiOpacity < 100 ? `${uiOpacity}%` : '默认'}
                </span>
              </div>
              <TinySlider
                value={uiOpacity}
                min={30}
                max={100}
                step={5}
                onChange={(v) => setSettings({ uiOpacity: v })}
              />
            </div>
            {/* CLI 高画质代理（BilibiliParseSettings 同构面板，黑底弹窗配色：
              标题行+连接状态点 → 关闭/启用双按钮 → 状态说明 → 配置页入口；
              CLI 开关即 musicVideoCli 设置项，改回开关语义并即时持久化） */}
            <div
              className="mx-5 my-3 rounded-lg p-3"
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.06)',
                border: '0.5px solid rgba(255, 255, 255, 0.12)',
              }}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                  style={{
                    background:
                      'linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05))',
                  }}
                >
                  <MonitorSmartphone
                    className="h-3 w-3"
                    style={{ color: 'rgba(255, 255, 255, 0.85)' }}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[10px] font-bold leading-tight text-white">
                    CLI 高画质代理
                  </span>
                  <span className="text-[8px] font-medium uppercase tracking-wide text-white/40">
                    LOCAL PROXY
                  </span>
                </div>
                {/* 连接状态（图示同语义：已连接发光 / 启用未连报错色 / 未启用灰） */}
                <div className="flex items-center gap-1">
                  <span
                    className="inline-block h-1 w-1 rounded-full"
                    style={{
                      backgroundColor: cliAvailable
                        ? '#ffffff'
                        : musicVideoCli
                          ? '#ff6b6b'
                          : 'rgba(255, 255, 255, 0.3)',
                      boxShadow: cliAvailable
                        ? '0 0 4px rgba(255, 255, 255, 0.9)'
                        : 'none',
                    }}
                  />
                  <span className="text-[9px] font-medium text-white/50">
                    {cliAvailable
                      ? '已连接'
                      : musicVideoCli
                        ? '未连接'
                        : '未启用'}
                  </span>
                </div>
              </div>
              {/* 关闭 / 启用（选中白底黑字，与弹窗 toggle 语言一致） */}
              <div className="mt-2 grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={() => setSettings({ musicVideoCli: false })}
                  className={cn(
                    'rounded-md py-1 text-[10px] font-semibold transition-all',
                    !musicVideoCli
                      ? 'bg-white text-black shadow-sm'
                      : 'bg-white/10 text-white/60 hover:bg-white/15'
                  )}
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => setSettings({ musicVideoCli: true })}
                  className={cn(
                    'rounded-md py-1 text-[10px] font-semibold transition-all',
                    musicVideoCli
                      ? 'bg-white text-black shadow-sm'
                      : 'bg-white/10 text-white/60 hover:bg-white/15'
                  )}
                >
                  启用
                </button>
              </div>
              <div className="mt-1 text-[9px] leading-snug text-white/50">
                {musicVideoCli
                  ? cliAvailable
                    ? `已连接本地代理 ${cliAgent.agentInfo?.version ?? ''}`
                    : '已启用但未检测到本地 CLI，请先启动本地代理以获取高画质视频背景'
                  : '使用本地 zcontrol-cli 获取大会员等高画质视频背景'}
              </div>
              <button
                type="button"
                onClick={openCliSetup}
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] font-semibold text-white/60 transition-colors hover:bg-white/10"
                style={{ border: '0.5px solid rgba(255, 255, 255, 0.2)' }}
              >
                <ExternalLink className="h-3 w-3" />
                打开 CLI 配置页
              </button>
            </div>
            {/* 背景显示方式（视频背景的画面适配方式，点击循环切换） */}
            <div className="flex items-center justify-between gap-3 px-5 py-3.5">
              <span className="min-w-0">
                <span className="block text-[13px] font-bold text-white">
                  背景显示方式
                </span>
                <span className="mt-0.5 block text-[11px] font-medium text-white/50">
                  视频背景铺满屏幕的方式
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  setSettings({
                    bgVideoFit:
                      bgVideoFit === 'contain'
                        ? 'cover'
                        : bgVideoFit === 'cover'
                          ? 'fill'
                          : 'contain',
                  })
                }
                className="w-[76px] shrink-0 rounded-full px-2 py-1.5 text-xs font-bold transition-opacity hover:opacity-70"
                style={{ backgroundColor: '#ffffff', color: '#000000' }}
                title="点击切换：完整显示 → 裁切铺满 → 拉伸填充"
                aria-label="切换背景显示方式"
              >
                {bgVideoFit === 'contain'
                  ? '完整显示'
                  : bgVideoFit === 'cover'
                    ? '裁切铺满'
                    : '拉伸填充'}
              </button>
            </div>
            {/* B站封面形状（仅哔哩哔哩歌曲的歌词页封面生效，点击循环切换） */}
            <div className="flex items-center justify-between gap-3 px-5 py-3.5">
              <span className="min-w-0">
                <span className="block text-[13px] font-bold text-white">
                  B站封面形状
                </span>
                <span className="mt-0.5 block text-[11px] font-medium text-white/50">
                  哔哩哔哩歌曲封面的显示裁剪方式
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  setSettings({
                    biliCoverShape:
                      biliCoverShape === 'original' ? 'square' : 'original',
                  })
                }
                className="w-[76px] shrink-0 rounded-full px-2 py-1.5 text-xs font-bold transition-opacity hover:opacity-70"
                style={{ backgroundColor: '#ffffff', color: '#000000' }}
                title="点击切换：原版（长方形）↔ 正方形（居中裁剪）"
                aria-label="切换 B站封面形状"
              >
                {biliCoverShape === 'original' ? '原版' : '正方形'}
              </button>
            </div>
            {/* 红心收藏夹（播放栏 B站 条目红心一键收藏的目标收藏夹；
              点击名称胶囊进入编辑，不存在时后端自动创建同名收藏夹） */}
            <div className="flex items-center justify-between gap-3 px-5 py-3.5">
              <span className="min-w-0">
                <span className="block text-[13px] font-bold text-white">
                  红心收藏夹
                </span>
                <span className="mt-0.5 block text-[11px] font-medium text-white/50">
                  点击红心收藏 B站 视频的目标收藏夹，不存在时自动创建
                </span>
              </span>
              {favTitleEditing ? (
                <input
                  autoFocus
                  value={favTitleDraft}
                  onChange={(e) => setFavTitleDraft(e.target.value)}
                  onBlur={commitFavTitle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitFavTitle()
                    if (e.key === 'Escape') setFavTitleEditing(false)
                  }}
                  className="h-[30px] w-[130px] shrink-0 rounded-full px-3 text-xs font-bold outline-none"
                  style={{ backgroundColor: '#ffffff', color: '#000000' }}
                  aria-label="红心收藏夹名称"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setFavTitleDraft(biliLikeFavTitle)
                    setFavTitleEditing(true)
                  }}
                  className="min-w-[76px] max-w-[130px] shrink-0 truncate rounded-full px-3 py-1.5 text-xs font-bold transition-opacity hover:opacity-70"
                  style={{ backgroundColor: '#ffffff', color: '#000000' }}
                  title="点击编辑收藏夹名称（留空恢复默认 Music）"
                  aria-label="编辑红心收藏夹名称"
                >
                  {biliLikeFavTitle}
                </button>
              )}
            </div>
            {/* 歌词模糊（非当前行 blur，当前行保持清晰） */}
            <div className="flex items-center justify-between gap-3 px-5 py-3.5">
              <span className="text-[13px] font-bold text-white">歌词模糊</span>
              <button
                type="button"
                role="switch"
                aria-checked={lyricBlur}
                aria-label="歌词模糊"
                onClick={() => setSettings({ lyricBlur: !lyricBlur })}
                className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                style={{
                  backgroundColor: lyricBlur
                    ? '#ffffff'
                    : 'rgba(255, 255, 255, 0.22)',
                }}
              >
                <span
                  className="absolute top-0.5 h-4 w-4 rounded-full transition-all duration-200"
                  style={{
                    left: lyricBlur ? '18px' : '2px',
                    backgroundColor: lyricBlur ? '#000000' : '#ffffff',
                  }}
                />
              </button>
            </div>
            {/* 歌词模糊浓度：拖到 0 视为关闭（联动上方开关与设置页） */}
            <div className="px-5 py-3.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[13px] font-bold text-white">
                  模糊浓度
                </span>
                <span className="text-[12px] font-bold tabular-nums text-white/70">
                  {lyricBlurLevel > 0 ? `${lyricBlurLevel}px` : '关闭'}
                </span>
              </div>
              <TinySlider
                value={lyricBlurLevel}
                min={0}
                max={10}
                step={0.5}
                onChange={(v) =>
                  setSettings({ lyricBlurLevel: v, lyricBlur: v > 0 })
                }
              />
            </div>
            {/* B站弹幕（复用一起看弹幕设置：总开关 + 样式面板 + 高级设置 +
              字体选择；样式与一起看共用 danmakuStore 持久化，跨页生效） */}
            <div
              className="mx-5 my-3 rounded-lg p-3"
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.06)',
                border: '0.5px solid rgba(255, 255, 255, 0.12)',
              }}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                  style={{
                    background:
                      'linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05))',
                  }}
                >
                  <MessagesSquare
                    className="h-3 w-3"
                    style={{ color: 'rgba(255, 255, 255, 0.85)' }}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[10px] font-bold leading-tight text-white">
                    B站弹幕
                  </span>
                  <span className="text-[8px] font-medium uppercase tracking-wide text-white/40">
                    DANMAKU
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={biliDanmakuEnabled}
                  aria-label="B站弹幕"
                  onClick={() =>
                    setSettings({ biliDanmakuEnabled: !biliDanmakuEnabled })
                  }
                  className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                  style={{
                    backgroundColor: biliDanmakuEnabled
                      ? '#ffffff'
                      : 'rgba(255, 255, 255, 0.22)',
                  }}
                >
                  <span
                    className="absolute top-0.5 h-4 w-4 rounded-full transition-all duration-200"
                    style={{
                      left: biliDanmakuEnabled ? '18px' : '2px',
                      backgroundColor: biliDanmakuEnabled
                        ? '#000000'
                        : '#ffffff',
                    }}
                  />
                </button>
              </div>
              {/* 弹幕层级（UI 上方 = 悬浮于播放卡/歌词等前景 UI 之上；
                UI 底部 = 仅铺在背景之上、被前景 UI 遮挡；纯净模式下
                前景 UI 隐藏，两种层级均显示在视频之上） */}
              {biliDanmakuEnabled && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-bold text-white">
                    弹幕层级
                  </span>
                  <div className="grid shrink-0 grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => setSettings({ biliDanmakuAboveUi: true })}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-[10px] font-semibold transition-all',
                        biliDanmakuAboveUi
                          ? 'bg-white text-black shadow-sm'
                          : 'bg-white/10 text-white/60 hover:bg-white/15'
                      )}
                    >
                      UI 上方
                    </button>
                    <button
                      type="button"
                      onClick={() => setSettings({ biliDanmakuAboveUi: false })}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-[10px] font-semibold transition-all',
                        !biliDanmakuAboveUi
                          ? 'bg-white text-black shadow-sm'
                          : 'bg-white/10 text-white/60 hover:bg-white/15'
                      )}
                    >
                      UI 底部
                    </button>
                  </div>
                </div>
              )}
              {/* 弹幕样式设置（仅启用时展开；MD3 令牌暗色覆盖使白主题组件
                融入黑底弹窗，primary=白与弹窗按钮语言一致） */}
              {biliDanmakuEnabled && (
                <div className="mt-2" style={DANMAKU_PANEL_TOKEN_OVERRIDES}>
                  <DanmakuStylePanel
                    style={danmakuStyle}
                    setStyle={setDanmakuStyle}
                    resetStyle={resetDanmakuStyle}
                    advancedOpen={danmakuAdvancedOpen}
                    onAdvancedToggle={() => {
                      setDanmakuAdvancedOpen((v) => !v)
                      setDanmakuFontOpen(false)
                    }}
                  />
                  {danmakuAdvancedOpen && (
                    <div className="mt-2 border-t border-white/10 pt-2">
                      <DanmakuAdvancedSettings
                        style={danmakuStyle}
                        setStyle={setDanmakuStyle}
                        setFilters={setDanmakuFilters}
                        setAdvancedStyle={setDanmakuAdvanced}
                        onFontPanelToggle={() => setDanmakuFontOpen((v) => !v)}
                      />
                      {danmakuFontOpen && (
                        <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-white/10 bg-black/30 p-1">
                          <FontPickerPanel
                            value={
                              danmakuStyle.advanced.fontFamily ===
                              DEFAULT_DANMAKU_STYLE.advanced.fontFamily
                                ? ''
                                : danmakuStyle.advanced.fontFamily
                            }
                            onChange={(v) =>
                              setDanmakuAdvanced({
                                fontFamily:
                                  v ||
                                  DEFAULT_DANMAKU_STYLE.advanced.fontFamily,
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/**
 * 播放进度条（Hydrogen 样式：1.3vh 黑条 + 0.5px 描边；canControl 可拖动）。
 * 独立组件：进度经 usePlaybackPosition(0.25) 量化订阅——positionSec 的
 * 高频更新只重渲染本组件（含拖动预览），不拖累整块播放面板。
 * seek 等位锁状态由父级持有（歌词行点击 seek 共用同一把锁），经 props 传入。
 */
function PlayerProgressBar({
  durationSec,
  canControl,
  currentKey,
  seekLock,
  onSeek,
}: {
  durationSec: number
  canControl: boolean
  currentKey: string | null
  /** seek 等位锁快照（父级持有：进度条拖动与歌词行点击共用） */
  seekLock: { key: string | null; sec: number } | null
  /** 执行 seek 并挂等位锁（父级实现：seek + setSeekLock） */
  onSeek: (sec: number) => void
}) {
  const positionSec = usePlaybackPosition(0.25)
  const progressRef = useRef<HTMLDivElement>(null)

  /** 拖动预览值（拖动期间进度条即时跟手，松手后才真 seek） */
  const [dragPreviewSec, setDragPreviewSec] = useState<number | null>(null)

  /** 进度条展示秒数：拖动预览 > seek 等位锁 > 实际播放进度 */
  const seekLockActive =
    seekLock != null &&
    seekLock.key === currentKey &&
    Math.abs(positionSec - seekLock.sec) > 0.75
  const progressDisplaySec =
    dragPreviewSec ?? (seekLockActive && seekLock ? seekLock.sec : positionSec)
  const progressDisplayRatio =
    durationSec > 0
      ? Math.min(1, Math.max(0, progressDisplaySec / durationSec))
      : 0

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
   * 拖动进度（仅 canControl；观众只读展示）。
   * Hydrogen vue-slider 模式复刻：拖动态 animateTime=0（即时跟手、无
   * transition 门），松手后外部值变化以 0.5s ease 平滑重定向（对应
   * :duration=0.5 与组件默认缓动）；松手 seek 后由 seek 等位锁托住展示
   * 值，杜绝「回退旧进度再前进」的横跳。
   */
  const handleProgressPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!canControl || durationSec <= 0) return
      e.preventDefault()
      e.stopPropagation()
      setDragPreviewSec(computeTimeFromClientX(e.clientX))
      const handleMove = (ev: PointerEvent) => {
        setDragPreviewSec(computeTimeFromClientX(ev.clientX))
      }
      const handleUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', handleMove)
        window.removeEventListener('pointerup', handleUp)
        onSeek(computeTimeFromClientX(ev.clientX))
        // 松手即清预览：等位锁接管展示值（锁定在 seek 目标），
        // 实际进度追上后以 0.5s ease 平滑恢复跟播
        setDragPreviewSec(null)
      }
      window.addEventListener('pointermove', handleMove)
      window.addEventListener('pointerup', handleUp)
    },
    [canControl, durationSec, onSeek, computeTimeFromClientX]
  )

  return (
    <>
      <div className="flex items-center justify-between text-[max(1.5vh,11px)] font-bold tabular-nums text-[var(--md-sys-color-on-surface)]">
        <span>{formatDuration(progressDisplaySec)}</span>
        <span>{formatDuration(durationSec)}</span>
      </div>
      <div
        ref={progressRef}
        role="slider"
        aria-label={canControl ? '播放进度' : '播放进度（仅房主可拖动）'}
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(positionSec)}
        aria-disabled={!canControl}
        className={cn(
          'touch-slider relative mt-[max(1vh,6px)] h-[max(1.3vh,6px)]',
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
            // 拖动预览值即时跟手（无过渡）；松手后位置值变化
            // 以 0.5s ease 平滑补间（Hydrogen vue-slider
            // :duration=0.5 与组件默认缓动）
            width: `${progressDisplayRatio * 100}%`,
            backgroundColor: 'var(--md-sys-color-on-surface)',
            transition: dragPreviewSec != null ? 'none' : 'width 0.5s ease',
          }}
        />
      </div>
    </>
  )
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

  // ===== 工具栏颜色逐按钮自适应背景（useBackdropAwareTone）=====
  // 采样范围根（面板根）：扫描子树内 [data-bg-tone] 按钮
  const panelRootRef = useRef<HTMLDivElement | null>(null)
  // 封面背景 img（兜底采样源；切歌重挂后 ref 自动更新）
  const coverImgElRef = useRef<HTMLImageElement | null>(null)

  const queue = useMusicStore((s) => s.queue)
  const currentKey = useMusicStore((s) => s.currentKey)

  const songId = currentSong?.songId
  const cover = currentSong?.cover

  // ===== 自定义视频背景（Hydrogen PlayerVideo 复刻）：当前歌曲有 B站 视频
  // 关联时，解析（默认 720P 直链 / CLI 开启时高画质 DASH）后作为静音背景
  // 铺满播放器，跟随音乐播放/暂停；B站 本地插播曲目直接用其视频作背景 =====
  const musicVideoCli = useMusicSettingsStore((s) => s.musicVideoCli)
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

  // ===== B站 音源弹幕（复用一起看弹幕模块 DanmakuLayer）：B站 条目按 cid
  // 拉官方弹幕，时间轴驱动走 positionSec（音频 timeupdate），不依赖视频元素；
  // 开关与样式设置在歌词页设置弹窗（样式与一起看共用 danmakuStore 持久化） =====
  const biliDanmakuEnabled = useMusicSettingsStore((s) => s.biliDanmakuEnabled)
  const biliDanmakuAboveUi = useMusicSettingsStore((s) => s.biliDanmakuAboveUi)
  /** 工具栏弹幕开关用（与设置弹窗同一 setter） */
  const setMusicSettings = useMusicSettingsStore((s) => s.set)
  const danmakuStyle = useDanmakuStore((s) => s.style)
  const biliDanmakuActive = isBiliSong && biliDanmakuEnabled
  const biliDanmakuLayerRef = useRef<DanmakuLayerHandle | null>(null)
  const biliDanmakuItemsRef = useRef<DanmakuItem[]>([])
  /** 最近一次同步的播放进度（秒）：弹幕（重）挂载 / 加载完成后 seek 对齐用 */
  const biliDanmakuTimeRef = useRef(0)
  const biliCid = currentSong?.biliCid ?? 0

  // cid 变化 → 清旧轨道 → 拉新弹幕（与一起看 WatchTogetherCore 同模式；
  // 弹幕层未挂载时仅更新缓存，挂载后由下方 effect 重载）
  useEffect(() => {
    if (!isBiliSong || !biliCid) return
    let cancelled = false
    biliDanmakuItemsRef.current = []
    biliDanmakuLayerRef.current?.loadDanmakuTrack('default', [])
    biliDanmakuLayerRef.current?.clear()
    fetchBilibiliDanmakuByCid(biliCid)
      .then((items) => {
        if (cancelled) return
        biliDanmakuItemsRef.current = items
        biliDanmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
        biliDanmakuLayerRef.current?.seek(biliDanmakuTimeRef.current)
      })
      .catch((err) => {
        console.error('[ListenTogether] load danmaku error:', err)
      })
    return () => {
      cancelled = true
    }
  }, [isBiliSong, biliCid])

  // 弹幕层（重）挂载 / 开关重开 / 弹幕设置或层级变更 → 用缓存弹幕重载并
  // 对齐当前进度：样式/速度/密度等变更会清空已渲染弹幕与已发射集合，
  // 引擎若同时重建（层级切换等）则轨道也丢失——不重载会让当前窗口再也
  // 不补发，表现为"调完弹幕设置后弹幕永远出不来"
  useEffect(() => {
    if (!biliDanmakuActive) return
    const items = biliDanmakuItemsRef.current
    if (items.length > 0) {
      biliDanmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
      biliDanmakuLayerRef.current?.seek(biliDanmakuTimeRef.current)
    }
  }, [biliDanmakuActive, biliDanmakuAboveUi, danmakuStyle])

  // 时间轴驱动：interval 250ms 命令式读取 store 进度 → syncTime（绕开
  // React 渲染——positionSec 高频更新不再触发本组件重渲染；引擎内部对
  // >3s 跳变自动清已发射集合并补发当前窗口，拖进度条 seek 兼容）
  useEffect(() => {
    biliDanmakuTimeRef.current = getPositionSec()
    if (!biliDanmakuActive) return
    const timer = setInterval(() => {
      const t = getPositionSec()
      biliDanmakuTimeRef.current = t
      biliDanmakuLayerRef.current?.syncTime(t)
    }, 250)
    return () => clearInterval(timer)
  }, [biliDanmakuActive])

  const musicVideoBg = useMusicVideoBackground(
    isBiliSong ? null : (songId ?? null),
    musicVideoCli,
    isBiliSong ? (currentSong?.biliBvid ?? null) : null,
    currentSong?.biliCid ?? 0
  )
  const bgVideoRef = useRef<HTMLVideoElement | null>(null)

  // ===== 视频背景可见性门控：源就绪 ≠ 画面就绪——视频元素挂载后要等
  //       canplay/playing（首帧可播）才淡入，未就绪期间透出封面模糊背景
  //       （B站 视频解析/缓冲期间背景始终是封面）。可见性按「已就绪 URL =
  //       当前源 URL」派生：切歌/重解析瞬间自动回到未就绪态，无需清理
  //       effect（规避 set-state-in-effect） =====
  const bgSourceUrl = musicVideoBg.source?.url ?? null
  const [bgVideoReadyUrl, setBgVideoReadyUrl] = useState<string | null>(null)
  const bgVideoVisible = bgSourceUrl != null && bgVideoReadyUrl === bgSourceUrl
  // 进度同步辅助态：seek 去抖定时器 / 待 seek 目标 / seek 后倍速追赶模式
  const bgSeekDebounceRef = useRef<number | null>(null)
  const bgSeekPendingRef = useRef<number | null>(null)
  const bgCatchUpRef = useRef(false)
  const { attachSource: attachBgSource, cleanup: cleanupBgSource } =
    usePlayerSource({ videoRef: bgVideoRef })

  // 解析成功 → attach 到背景 video（引擎按 format 选 MSE/Direct；B站 CDN
  // 直链由引擎经后端代理注入 Referer，CLI 模式本身已是本地代理 URL）
  useEffect(() => {
    const video = bgVideoRef.current
    if (
      !video ||
      musicVideoBg.status !== 'ready' ||
      !musicVideoBg.source?.url
    ) {
      return
    }
    void attachBgSource(video, {
      url: musicVideoBg.source.url,
      audioUrl: musicVideoBg.source.audioUrl,
      format: musicVideoBg.source.format,
      videoCodec: musicVideoBg.source.videoCodec,
      audioCodec: musicVideoBg.source.audioCodec,
    })
  }, [musicVideoBg.status, musicVideoBg.source, attachBgSource])

  // 卸载时释放引擎资源（blobUrl / MSE）
  useEffect(() => cleanupBgSource, [cleanupBgSource])

  // 背景视频跟随音乐播放/暂停（Hydrogen videoIsPlaying 同语义；元素静音）
  useEffect(() => {
    const video = bgVideoRef.current
    if (!video || musicVideoBg.status !== 'ready') return
    if (isPlaying) {
      void video.play().catch(() => {
        // ignore：自动播放策略拒绝
      })
    } else if (!video.paused) {
      video.pause()
    }
  }, [isPlaying, musicVideoBg.status])

  // ===== 视频背景进度同步：视频画面跟随音频进度（音频播到哪里视频也到哪；
  // 音频长于视频时按视频时长取模循环）。
  // 大漂移（拖进度条/seek/卡顿）不立即跳转：先经去抖窗口（拖动期间只更新
  // 目标，停止后仅一次 seek），随后进入「倍速追赶」——seek 耗时内音频多走的
  // 残余漂移用 playbackRate 渐进吸收（顺序解码远比再次 seek 便宜，避免大
  // 视频反复 seek 引发的性能猛增与浏览器卡顿），对齐后恢复原速。
  // metadata 就绪（挂载/切歌/中途加入房间）时无视一切强制对齐一次
  // （见 video 的 onLoadedMetadata） =====
  const syncBgVideoTime = useCallback((force: boolean) => {
    const video = bgVideoRef.current
    if (!video || video.readyState < 1) return
    const dur = video.duration
    if (!Number.isFinite(dur) || dur <= 0) return
    const target = getPositionSec() % dur
    if (force) {
      // 强制对齐（metadata 就绪/切歌）：清追赶态后直接跳
      if (bgSeekDebounceRef.current != null) {
        clearTimeout(bgSeekDebounceRef.current)
        bgSeekDebounceRef.current = null
      }
      bgSeekPendingRef.current = null
      bgCatchUpRef.current = false
      if (video.playbackRate !== 1) video.playbackRate = 1
      try {
        video.currentTime = target
      } catch {
        // 引擎未就绪等 seek 失败静默忽略，等待下轮校正
      }
      return
    }
    const drift = target - video.currentTime // 正 = 视频落后于音频
    if (Math.abs(drift) > BG_VIDEO_SYNC_THRESHOLD_SEC) {
      // 大漂移：去抖 seek——窗口内重复触发只刷新目标，最终一次跳转
      bgSeekPendingRef.current = target
      if (bgSeekDebounceRef.current == null) {
        bgSeekDebounceRef.current = window.setTimeout(() => {
          bgSeekDebounceRef.current = null
          const pending = bgSeekPendingRef.current
          bgSeekPendingRef.current = null
          if (pending == null) return
          try {
            // 目标可能已随音频前移/换源，按当前时长取模保护
            video.currentTime = pending % (video.duration || 1)
            bgCatchUpRef.current = true // seek 后倍速吸收残余漂移
          } catch {
            // 引擎未就绪等 seek 失败静默忽略，等待下轮校正
          }
        }, BG_VIDEO_SEEK_DEBOUNCE_MS)
      }
      return
    }
    if (bgCatchUpRef.current) {
      // 追赶模式：漂移在阈值内但尚未对齐——倍速渐进吸收，避免二次 seek
      if (Math.abs(drift) <= BG_VIDEO_CATCHUP_EPSILON_SEC) {
        bgCatchUpRef.current = false
        if (video.playbackRate !== 1) video.playbackRate = 1
      } else {
        // 落后则略加速追上，超前则略减速让音频追上（无声背景，无感知）
        const rate = Math.min(
          BG_VIDEO_MAX_RATE,
          Math.max(BG_VIDEO_MIN_RATE, 1 + drift / BG_VIDEO_CATCHUP_GAIN_SEC)
        )
        if (Math.abs(video.playbackRate - rate) > 0.01) {
          try {
            video.playbackRate = rate
          } catch {
            // ignore
          }
        }
      }
    }
  }, [])

  // 卸载时清 seek 去抖定时器（追赶态随元素销毁失效，无需处理）
  useEffect(
    () => () => {
      if (bgSeekDebounceRef.current != null) {
        clearTimeout(bgSeekDebounceRef.current)
        bgSeekDebounceRef.current = null
      }
    },
    []
  )

  // ===== 纯净模式（背景视频沉浸）：隐藏面板全部 UI，背景视频经 fixed
  // 提升为全屏唯一图层；仅当背景视频就绪时可用 =====
  const [immersive, setImmersive] = useState(false)
  const bgVideoReady = !!musicVideoBg.source?.url
  // 背景视频消失（切歌到无视频背景的曲目）时自动退出，避免黑屏
  //（render 期调整，替代 effect 内同步 setState，与 prevSongId 同范式）
  const [prevBgVideoReady, setPrevBgVideoReady] = useState(bgVideoReady)
  if (prevBgVideoReady !== bgVideoReady) {
    setPrevBgVideoReady(bgVideoReady)
    if (!bgVideoReady && immersive) setImmersive(false)
  }
  // Esc 退出
  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImmersive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [immersive])
  // 双击退出：单击延迟 250ms 触发切播放暂停（为双击留判定窗口），
  // 双击取消未决单击并直接退出纯净模式（不再渲染右下角退出按钮）
  const immersiveTapTimerRef = useRef<number | null>(null)
  // 退出纯净模式 / 卸载时清理未决的单击定时器
  useEffect(() => {
    return () => {
      if (immersiveTapTimerRef.current != null) {
        window.clearTimeout(immersiveTapTimerRef.current)
        immersiveTapTimerRef.current = null
      }
    }
  }, [immersive])
  const handleImmersiveTap = useCallback(
    (e: React.MouseEvent) => {
      if (e.detail >= 2) {
        if (immersiveTapTimerRef.current != null) {
          window.clearTimeout(immersiveTapTimerRef.current)
          immersiveTapTimerRef.current = null
        }
        setImmersive(false)
        return
      }
      if (immersiveTapTimerRef.current != null) {
        window.clearTimeout(immersiveTapTimerRef.current)
      }
      immersiveTapTimerRef.current = window.setTimeout(() => {
        immersiveTapTimerRef.current = null
        togglePlay()
      }, 250)
    },
    [togglePlay]
  )

  // ===== 双击歌名 → 添加当前歌到播放队列（仅网易云歌；B站 视频不响应）。
  // notify 模式：未在队列时入队并弹顶部「已添加」提示；已在队列时先弹
  // 非模态确认提示（同普通提示窗口样式、不影响其他操作，hook 内实现）=====
  const { add: queueAdd } = useQueueAdd(socket, roomId, canManage ?? isHost)
  const handleSongNameDoubleClick = useCallback(() => {
    if (!currentSong || isBiliSong) return
    queueAdd(songToUpsertItem(currentSong), { notify: true })
  }, [currentSong, isBiliSong, queueAdd])

  // 视频背景漂移校正驱动：interval 1s 命令式读取进度（positionSec 高频
  // 更新不再经由 React effect 触发）；播放中正常 1x 漂移远小于阈值，
  // 仅卡顿/seek 后才安排校正。未就绪时不排程（sync 内部亦有护栏）
  useEffect(() => {
    if (!bgVideoReady) return
    const timer = setInterval(() => syncBgVideoTime(false), 1000)
    return () => clearInterval(timer)
  }, [bgVideoReady, syncBgVideoTime])

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
  const [biliCollectedMark, setBiliCollectedMark] = useState<{
    bvid: string
    folder: string
  } | null>(null)
  const biliCollected =
    biliBvid != null &&
    biliCollectedMark?.bvid === biliBvid &&
    biliCollectedMark.folder === biliLikeFavTitle
  /** 收藏/取消收藏开关：已收藏（同一视频 + 同一目标收藏夹）时点击即
   *  取消收藏（后端同端点 del_media_ids），否则一键收藏 */
  const handleBiliCollect = useCallback(async () => {
    if (!biliBvid || biliCollecting) return
    const collected =
      biliCollectedMark?.bvid === biliBvid &&
      biliCollectedMark.folder === biliLikeFavTitle
    setBiliCollecting(true)
    try {
      const { data, ok } = await apiPost<{
        success?: boolean
        message?: string
        folderTitle?: string
      }>('/api/stream/bilibili/fav/collect', {
        bvid: biliBvid,
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
        setBiliCollectedMark({ bvid: biliBvid, folder: biliLikeFavTitle })
        message.success(`已收藏到「${data?.folderTitle || biliLikeFavTitle}」`)
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBiliCollecting(false)
    }
  }, [biliBvid, biliCollecting, biliCollectedMark, biliLikeFavTitle])

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

  // ===== 进度条（Hydrogen 样式）：抽为独立组件 PlayerProgressBar——
  // 进度经 usePlaybackPosition(0.25) 量化订阅，positionSec 的高频更新只
  // 重渲染进度条本身（含拖动预览），不拖累整块播放面板 =====
  const durationSec = currentSong ? currentSong.durationMs / 1000 : 0

  // ===== seek 等位锁（修复松手后进度条「倒退再前进」反复横跳）：
  //       seek() 只同步设置 audio.currentTime，positionSec 要等下一次
  //       timeupdate 才更新——松手瞬间展示值会从拖动终点回退到旧进度
  //       再前进。进度条（拖动）与歌词行点击 seek 共用同一把锁；
  //       实际进度追上（容差 0.75s）、超时兜底（2s）或换曲后自动失效 =====
  const [seekLock, setSeekLock] = useState<{
    key: string | null
    sec: number
  } | null>(null)
  const performSeekWithLock = useCallback(
    (time: number) => {
      seek(time)
      setSeekLock({ key: currentKey, sec: time })
    },
    [seek, currentKey]
  )

  // 等位锁超时兜底：seek 失败（元数据未就绪等）时实际进度永远追不上，
  // 超时后强制回落实际进度（setState 在定时器回调内，非同步级联）
  useEffect(() => {
    if (seekLock == null) return
    const timer = setTimeout(() => setSeekLock(null), 2000)
    return () => clearTimeout(timer)
  }, [seekLock])

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

  /** 歌词行 seek（观众无控制权时不可用，与进度条一致；同样挂等位锁防回跳） */
  const handleLyricSeek = useCallback(
    (time: number) => {
      if (canControl) performSeekWithLock(time)
    },
    [canControl, performSeekWithLock]
  )

  /** 播放模式轮换（仅房主，切换后广播同步） */
  const handleTogglePlayMode = useCallback(() => {
    const idx = PLAY_MODE_ORDER.indexOf(playMode)
    const nextMode =
      PLAY_MODE_ORDER[(idx + 1) % PLAY_MODE_ORDER.length] ?? 'sequence'
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
  /** 封面背景模糊半径：毛玻璃关闭时 0（显示未模糊封面而非纯色底） */
  const coverBlurPx = coverBlur ? coverBlurLevel : 0
  const bgDim = useMusicSettingsStore((s) => s.bgDim)
  // ===== 工具栏颜色逐按钮自适应背景：每 300ms 采样背景画面（视频帧优先、
  // 封面兜底），对每个 [data-bg-tone] 按钮按其矩形后的画面亮度独立写
  // on-surface / on-surface-variant / --lt-tone-inverse（含压暗与滞后带）；
  // 未知（无源/采样失败）时移除覆盖回退主题色 =====
  useBackdropAwareTone({
    videoRef: bgVideoRef,
    videoFit: bgVideoFit,
    videoVisible: bgVideoVisible,
    coverImgRef: coverImgElRef,
    bgDimPercent: bgDim,
    scopeRef: panelRootRef,
  })
  const uiOpacity = useMusicSettingsStore((s) => s.uiOpacity)
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

  // ===== 歌词类型开关（Hydrogen lyricType：original / trans / roma）：
  // 翻译初值取自设置「显示歌曲翻译」；切换为播放器内即时态，不写回设置 =====
  const [lyricOriginal, setLyricOriginal] = useState(true)
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

  // 歌词类型可用性（song-control 三开关的显示条件：当前歌有对应歌词数据才显示）
  const hasOriginalLyric = lyricLines.some((l) => l.text.trim() !== '')
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
  /** 前景 UI 整体透明度（设置：UI 透明度 %，30-100；非法值回退不透明） */
  const uiFade =
    Number.isFinite(uiOpacity) && uiOpacity > 0
      ? Math.min(1, Math.max(0.3, uiOpacity / 100))
      : 1
  const songName = currentSong?.name ?? '一起听'
  const artist = currentSong?.artist ?? ''

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
      ref={panelRootRef}
      className="relative flex h-full min-w-0 flex-col overflow-hidden"
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
            ref={coverImgElRef}
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
            onLoadedMetadata={() => syncBgVideoTime(true)}
            onCanPlay={() => setBgVideoReadyUrl(bgSourceUrl)}
            onPlaying={() => setBgVideoReadyUrl(bgSourceUrl)}
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
            opacity={danmakuStyle.opacity}
            displayArea={danmakuStyle.displayArea}
            density={danmakuStyle.advanced.density}
            speed={danmakuStyle.speed}
            scaleWithScreen={danmakuStyle.scaleWithScreen}
            filters={danmakuStyle.filters}
            advancedStyle={danmakuStyle.advanced}
            fontSize={danmakuStyle.fontSize}
          />
        </div>
      )}

      {/* ===== 左上角提示区：房主离线提示 + syncNotice（含房主审批按钮） ===== */}
      <div
        className={cn(
          'pointer-events-none absolute left-4 top-4 z-30 flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 max-md:left-3 max-md:top-3',
          immersive && 'invisible'
        )}
        style={uiFade < 1 ? { opacity: uiFade } : undefined}
      >
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
          className={cn(
            'relative z-[1] flex h-full min-h-0 items-stretch justify-start',
            'pb-[60px] pt-[95px]',
            isWebFullscreen ? 'px-[60px]' : 'px-[45px]',
            isPortraitMobile &&
              'flex-col justify-start gap-2.5 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-16',
            immersive && 'invisible'
          )}
          style={
            {
              '--lt-card-w': 'clamp(280px, 42vh, 480px)',
              ...(uiFade < 1 ? { opacity: uiFade } : null),
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
                ? mobileLyricView
                  ? 'm-hidden'
                  : 'm-card'
                : 'd-card'
            }
            className={cn(
              'player-card-in group relative z-[1] shrink-0',
              isPortraitMobile
                ? cn(
                    'w-full max-w-[420px] self-center',
                    mobileLyricView ? 'hidden' : 'flex-1'
                  )
                : 'w-[var(--lt-card-w)] max-w-[calc(100%-2rem)]'
            )}
            style={{ padding: '16px 12px', paddingBottom: '4vh' }}
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

            {/* song-control 悬浮工具栏（Hydrogen .song-control：绝对定位悬出
                卡片右侧 50px，正好落在左卡与右卡的间隙内；显示模式同
                Hydrogen——基态 opacity:0 常隐，鼠标悬停卡片/工具栏区域时
                重播「信号灯」闪烁动画并以 both 定格在可见，移开即隐。
                挂在**外层**（内层 overflow-hidden 会裁掉悬出部分）。
                图标集为原版 SVG：歌词显隐 / 罗马音 / 翻译 / 原词开关
                （歌词三项有对应数据才显示）+ 纯净模式（背景视频就绪时）+
                喜欢 + 播放模式（房主）+ 播放队列 + 设置（背景/歌词调整
                弹窗）+ 收起。
                手机竖屏隐藏（卡片全宽后右侧 50px 悬出区会出屏），改为
                卡片下方的水平工具行（见下方 isPortraitMobile 分支） */}
            <div
              className={cn(
                'lt-icon-outline lt-touch-visible absolute bottom-[max(2vh,10px)] right-[-50px] z-[10] flex w-[50px] flex-col items-center gap-[max(3vh,14px)] opacity-0 focus-within:opacity-100 group-hover:animate-[song-control-in_0.3s_both]',
                isPortraitMobile && 'hidden'
              )}
              style={
                {
                  color: 'var(--md-sys-color-on-surface)',
                  // 容器级回退值；每个 [data-bg-tone] 按钮由
                  // useBackdropAwareTone 按其后方画面亮度独立覆盖变量
                  '--md-sys-color-on-surface': 'var(--md-sys-color-on-surface)',
                  '--md-sys-color-on-surface-variant':
                    'var(--md-sys-color-on-surface-variant)',
                } as React.CSSProperties
              }
            >
              {/* 隐藏/显示歌词（桌面）：隐藏右侧歌词面板、播放卡居中；
                  纯视图级开关，与手机竖屏的 mobileLyricView 相互独立。
                  图标沿用移动端 AlignLeft，显隐语义一致 */}
              <button
                type="button"
                data-bg-tone="d-lyric"
                onClick={() => setDesktopLyricView((v) => !v)}
                className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                style={{
                  color: desktopLyricView
                    ? 'var(--md-sys-color-on-surface)'
                    : 'var(--md-sys-color-on-surface-variant)',
                }}
                title={desktopLyricView ? '隐藏歌词' : '显示歌词'}
                aria-label="切换歌词显示"
                aria-pressed={desktopLyricView}
              >
                <AlignLeft className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
              </button>
              {hasRomaLyric && (
                <button
                  type="button"
                  data-bg-tone="d-roma"
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
                  data-bg-tone="d-trans"
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
              {hasOriginalLyric && (
                <button
                  type="button"
                  data-bg-tone="d-original"
                  onClick={() => setLyricOriginal((v) => !v)}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color: lyricOriginal
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricOriginal ? '隐藏原词' : '显示原词'}
                  aria-label="切换原词显示"
                >
                  <OriginalLyricIcon className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 纯净模式（背景视频就绪时可用）：隐藏全部界面，仅显示
                  背景视频；原右上角胶囊与收起按钮重叠，移入本工具栏。
                  immersive 时整个面板 invisible，无需额外隐藏本按钮 */}
              {bgVideoReady && (
                <button
                  type="button"
                  data-bg-tone="d-immersive"
                  onClick={() => setImmersive(true)}
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
                  data-bg-tone="d-like"
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
                  data-bg-tone="d-playmode"
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
                  data-bg-tone="d-comment"
                  className="relative flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
                  style={{
                    color:
                      rightPanelMode === 1
                        ? 'var(--md-sys-color-on-surface)'
                        : 'var(--md-sys-color-on-surface-variant)',
                  }}
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
                      opacity={rightPanelMode === 1 ? 1 : 0.5}
                    />
                    <line
                      x1="7.2"
                      y1="9.9"
                      x2="13.3"
                      y2="9.9"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      opacity={rightPanelMode === 1 ? 1 : 0.5}
                    />
                    <line
                      x1="7.2"
                      y1="12.6"
                      x2="11.4"
                      y2="12.6"
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      opacity={rightPanelMode === 1 ? 1 : 0.5}
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
                  data-bg-tone="d-addvideo"
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
                  data-bg-tone="d-bilisource"
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
                  data-bg-tone="d-danmaku"
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
                  <MessagesSquare className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 在网易云搜索（仅 B站 条目）：自动提取歌名在网易云搜索，
                  结果支持试听/收藏到歌单——快速收藏 B站 听到的好歌 */}
              {isBiliSong && (
                <button
                  type="button"
                  data-bg-tone="d-ncmsearch"
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
                  data-bg-tone="d-collect"
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
                      ? `已收藏到「${biliLikeFavTitle}」收藏夹；点击取消收藏`
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
                  data-bg-tone="d-favmodal"
                  onPointerEnter={() => void prefetchBiliFavFolders()}
                  onClick={() => setBiliFavModalOpen(true)}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                  title="添加到收藏夹"
                  aria-label="添加到收藏夹"
                >
                  <FolderPlus className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
              )}
              {/* 播放队列（弹窗侧挂到按钮右侧展开，避免左侧出屏被裁切） */}
              <div className="relative">
                <button
                  type="button"
                  data-bg-tone="d-queue"
                  onClick={() => setQueuePopupOpen(true)}
                  className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                  title="播放队列"
                  aria-label="播放队列"
                >
                  <ListMusic className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
                </button>
                {queuePopupOpen && (
                  <MusicQueuePopup
                    socket={socket}
                    roomId={roomId}
                    isHost={isHost}
                    canManage={canManage ?? isHost}
                    placement="side"
                  />
                )}
              </div>
              {/* 快捷设置（黑底 SETTING 弹窗：背景设置项汇总） */}
              <button
                type="button"
                data-bg-tone="d-settings"
                onClick={() => setShowSettings(true)}
                className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                title="设置"
                aria-label="打开设置"
              >
                <Settings className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
              </button>
              <button
                type="button"
                data-bg-tone="d-collapse"
                onClick={closePlayerOverlay}
                className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                title="收起播放器"
                aria-label="收起播放器"
              >
                <ChevronDown className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
              </button>
            </div>

            {/* 内层 .player：半透明白卡（Hydrogen rgba(255,255,255,0.35) 的 M3 主题
                适配）+ backdrop 模糊（移动端经 lt-blur-surface 降档）+ 内容裁剪
                （动画期间内容不外溢） */}
            <div
              className="lt-blur-surface relative flex h-full w-full flex-col overflow-hidden"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-surface) 45%, transparent)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
              }}
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
                  <div className={cn('min-w-0', songSwitching && 'opacity-0')}>
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
                    套 4px 中心点 rgb(105,105,105)；文本 10px 左距 10px） */}
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
                    onSeek={performSeekWithLock}
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
                    active 缩放 0.9；max(5vh,36px) 保底触屏可点） */}
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

                {/* 音量区（滑块与进度同款 + VOLUME 标签与百分比；
                    手机端保留——蓝牙/外放场景仍需软件音量） */}
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
                      boxShadow: '0 0 0 0.5px var(--md-sys-color-on-surface)',
                    }}
                    onPointerDown={handleVolumePointerDown}
                  >
                    <div
                      className="absolute left-0 top-0 h-full"
                      style={{
                        width: `${volume * 100}%`,
                        backgroundColor: 'var(--md-sys-color-on-surface)',
                        transition: volumeDragging ? 'none' : 'width 0.3s ease',
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
              style={
                {
                  color: 'var(--md-sys-color-on-surface)',
                  // 容器级回退值；每个 [data-bg-tone] 按钮由
                  // useBackdropAwareTone 按其后方画面亮度独立覆盖变量
                  '--md-sys-color-on-surface': 'var(--md-sys-color-on-surface)',
                  '--md-sys-color-on-surface-variant':
                    'var(--md-sys-color-on-surface-variant)',
                } as React.CSSProperties
              }
            >
              {/* 歌词视图开关：默认只显示播放卡，开启后歌词区独占整页 */}
              <button
                type="button"
                data-bg-tone="m-lyric"
                onClick={() => setMobileLyricView((v) => !v)}
                className="flex h-8 w-8 items-center justify-center transition-opacity active:scale-90"
                style={{
                  color: mobileLyricView
                    ? 'var(--md-sys-color-on-surface)'
                    : 'var(--md-sys-color-on-surface-variant)',
                }}
                title={mobileLyricView ? '隐藏歌词' : '显示歌词'}
                aria-label="切换歌词显示"
                aria-pressed={mobileLyricView}
              >
                <AlignLeft className="h-5 w-5" />
              </button>
              {hasRomaLyric && (
                <button
                  type="button"
                  data-bg-tone="m-roma"
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
                  data-bg-tone="m-trans"
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
              {hasOriginalLyric && (
                <button
                  type="button"
                  data-bg-tone="m-original"
                  onClick={() => setLyricOriginal((v) => !v)}
                  className="flex h-8 w-8 items-center justify-center transition-opacity active:scale-90"
                  style={{
                    color: lyricOriginal
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  title={lyricOriginal ? '隐藏原词' : '显示原词'}
                  aria-label="切换原词显示"
                >
                  <OriginalLyricIcon className="h-5 w-5" />
                </button>
              )}
              {/* 纯净模式（手机端）：与桌面 song-control 同一入口 */}
              {bgVideoReady && (
                <button
                  type="button"
                  data-bg-tone="m-immersive"
                  onClick={() => setImmersive(true)}
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
                  data-bg-tone="m-like"
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
                  data-bg-tone="m-playmode"
                  onClick={handleTogglePlayMode}
                  className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                  title={`${PLAY_MODE_META[playMode].label}（点击${PLAY_MODE_META[playMode].next}）`}
                  aria-label={`播放模式：${PLAY_MODE_META[playMode].label}`}
                >
                  <PlayModeIcon className="h-5 w-5" />
                </button>
              )}
              {/* 歌词/评论切换（评论数徽章以小圆点形式叠加） */}
              {canComment && (
                <button
                  type="button"
                  data-bg-tone="m-comment"
                  onClick={() => setRightPanelMode((v) => (v === 0 ? 1 : 0))}
                  className="relative flex h-8 w-8 items-center justify-center transition-opacity active:scale-90"
                  style={{
                    color:
                      rightPanelMode === 1
                        ? 'var(--md-sys-color-on-surface)'
                        : 'var(--md-sys-color-on-surface-variant)',
                  }}
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
                  data-bg-tone="m-addvideo"
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
                  data-bg-tone="m-bilisource"
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
              {/* 播放队列（弹窗固定底部居中弹出，避免侧挂出屏） */}
              <button
                type="button"
                data-bg-tone="m-queue"
                onClick={() => setQueuePopupOpen(true)}
                className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                title="播放队列"
                aria-label="播放队列"
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
                data-bg-tone="m-settings"
                onClick={() => setShowSettings(true)}
                className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
                title="设置"
                aria-label="打开设置"
              >
                <Settings className="h-5 w-5" />
              </button>
            </div>
          )}
          {/* ===== 右侧歌词面板（Hydrogen .right-panel：桌面宽度固定计算
              calc(100% - 卡宽 - 50px)，卡片入场动画展开时面板保持不动；
              手机竖屏改为单列下段（flex-1 占满剩余高度）。
              评论模式下整区替换为歌曲评论区，Hydrogen rightPanelMode=1；
              与左侧播放器卡同款半透明 surface + backdrop 模糊，
              避免无封面/未开封面模糊时被上层纯色背景盖住。
              手机竖屏由 mobileLyricView 控制、桌面由 song-control 的
              隐藏歌词开关（desktopLyricView）控制，关闭时不渲染 ===== */}
          {(isPortraitMobile ? mobileLyricView : desktopLyricView) && (
            <div
              className={cn(
                'lt-blur-surface flex min-h-0 min-w-0 flex-col',
                isPortraitMobile
                  ? 'lt-lyric-view-in w-full flex-1'
                  : 'ml-[50px] h-full w-[calc(100%-var(--lt-card-w)-50px)]'
              )}
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-surface) 45%, transparent)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
              }}
            >
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
        <PlayerSettingsModal
          onDismiss={() => setShowSettings(false)}
          roomId={roomId}
        />
      )}

      {/* 在网易云搜索弹窗（B站 条目：歌名提取搜索 + 试听/收藏到歌单） */}
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
