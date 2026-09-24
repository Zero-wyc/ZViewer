/**
 * 手机竖屏水平工具行（替代右侧竖排 song-control）：竖屏下卡片全宽，
 * 右侧 50px 悬出区会出屏，改为卡片下方水平排列；收起走右上角常显按钮，
 * 此处不再重复。触屏尺寸 32px 保证可点。
 *
 * 与桌面 PlayerSongControl 同语义的入口：歌词视图开关 / 罗马音 / 翻译 /
 * 纯净模式 / 喜欢 / 播放模式（房主）/ 歌词-评论切换 / 添加视频 /
 * B站 原视频跳转 / 播放队列（弹窗固定底部 sheet）/ 设置 / UI 深浅色 /
 * 全屏。B站 条目专属的弹幕开关、网易云搜索、收藏红心仅桌面 song-control
 * 提供（竖屏行宽有限，保留高频入口）。
 */
import type { Socket } from 'socket.io-client'
import {
  AlignLeft,
  Contrast,
  ExternalLink,
  Film,
  ListMusic,
  Maximize,
  Minimize,
  MonitorPlay,
  MessageCircle,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MusicQueuePopup } from './MusicQueuePopup'
import {
  LikeFilledIcon,
  LikeOutlineIcon,
  PlayModeIcon,
  RomanLyricIcon,
  TransLyricIcon,
} from './PlayerControlIcons'
import { TOOLBAR_TONE_VARS, type PlayerUiTone } from '../utils/playerTone'
import { PLAY_MODE_META } from '../constants'
import type { PlayMode } from '../types'

export interface PlayerMobileToolbarRowProps {
  /** 工具行色调（跟随主题深浅，不跟播放页 UI 开关） */
  toolbarTone: PlayerUiTone

  // ===== 歌词视图开关（竖屏独占整页）与歌词三开关 =====
  mobileLyricViewActive: boolean
  onToggleMobileLyricView: () => void
  hasRomaLyric: boolean
  lyricRoma: boolean
  onToggleLyricRoma: () => void
  hasTransLyric: boolean
  lyricTrans: boolean
  onToggleLyricTrans: () => void

  // ===== 纯净模式 =====
  bgVideoReady: boolean
  onEnterImmersive: () => void

  // ===== 喜欢（网易云） =====
  canLike: boolean
  liked: boolean
  onLike: () => void

  // ===== 播放模式（房主） =====
  isHost: boolean
  playMode: PlayMode
  onTogglePlayMode: () => void

  // ===== 歌词/评论切换（评论数徽章以小圆点形式叠加） =====
  canComment: boolean
  rightPanelMode: 0 | 1
  commentBadge: string
  onToggleCommentPanel: () => void

  // ===== 添加视频 =====
  songId?: number
  onAddMusicVideo: () => void

  /** B站 原视频链接：命令式读取当前播放进度（?t= 续看），渲染期仅判空 */
  getBiliSourceUrl: () => string | null

  // ===== 播放队列（弹窗固定底部居中弹出） =====
  queuePopupOpen: boolean
  onToggleQueuePopup: () => void
  socket: Socket | null
  roomId: string
  /** 队列管理权限（父级已按 canManage ?? isHost 归一） */
  canManage: boolean

  // ===== 设置 / UI 深浅色 / 全屏 =====
  onOpenSettings: () => void
  uiTone: PlayerUiTone
  onToggleUiTone: () => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
}

export function PlayerMobileToolbarRow({
  toolbarTone,
  mobileLyricViewActive,
  onToggleMobileLyricView,
  hasRomaLyric,
  lyricRoma,
  onToggleLyricRoma,
  hasTransLyric,
  lyricTrans,
  onToggleLyricTrans,
  bgVideoReady,
  onEnterImmersive,
  canLike,
  liked,
  onLike,
  isHost,
  playMode,
  onTogglePlayMode,
  canComment,
  rightPanelMode,
  commentBadge,
  onToggleCommentPanel,
  songId,
  onAddMusicVideo,
  getBiliSourceUrl,
  queuePopupOpen,
  onToggleQueuePopup,
  socket,
  roomId,
  canManage,
  onOpenSettings,
  uiTone,
  onToggleUiTone,
  isFullscreen,
  onToggleFullscreen,
}: PlayerMobileToolbarRowProps) {
  return (
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
        onClick={onToggleMobileLyricView}
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
          onClick={onToggleLyricRoma}
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
          onClick={onToggleLyricTrans}
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
          onClick={onEnterImmersive}
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
          onClick={() => void onLike()}
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
          onClick={onTogglePlayMode}
          className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
          title={`${PLAY_MODE_META[playMode].label}（点击${PLAY_MODE_META[playMode].next}）`}
          aria-label={`播放模式：${PLAY_MODE_META[playMode].label}`}
        >
          <PlayModeIcon mode={playMode} className="h-5 w-5" />
        </button>
      )}
      {/* 歌词/评论切换（评论数徽章以小圆点形式叠加）：
          与桌面端同语义——歌词视图收起时，查看评论/歌词的意图
          即带出面板，否则 mobileLyricView=false 时面板不渲染，
          手机端永远看不到评论区 */}
      {canComment && (
        <button
          type="button"
          onClick={onToggleCommentPanel}
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
          onClick={onAddMusicVideo}
          className="flex h-8 w-8 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity active:scale-90"
          title="添加视频"
          aria-label="添加视频"
        >
          <Film className="h-5 w-5" />
        </button>
      )}
      {/* 前往 B站 原视频（仅 B站 条目，与桌面 song-control 同语义） */}
      {getBiliSourceUrl() && (
        <button
          type="button"
          onClick={() =>
            window.open(getBiliSourceUrl(), '_blank', 'noopener,noreferrer')
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
        onClick={onToggleQueuePopup}
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
          canManage={canManage}
          placement="sheet"
        />
      )}
      {/* 快捷设置（与桌面 song-control 同一弹窗） */}
      <button
        type="button"
        onClick={onOpenSettings}
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
        onClick={onToggleUiTone}
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
        onClick={onToggleFullscreen}
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
  )
}
