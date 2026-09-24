/**
 * song-control 悬浮工具栏（Hydrogen .song-control）：绝对定位悬出播放卡
 * 右侧 50px，落进播放卡恒定 mr-[50px] 预留的专列内——该列无论工具栏显隐
 * 都结构化保留空置，歌词面板永不与其重叠。
 *
 * 显示模式同 Hydrogen——基态 opacity:0 常隐（列空置），鼠标悬停卡片/
 * 工具栏区域时重播「信号灯」闪烁动画并以 both 定格在可见，移开即隐
 * （列恢复空置）。挂载点在播放卡**外层**（内层 overflow-hidden 会裁掉
 * 悬出部分），由 ListenTogetherPanel 的播放卡 JSX 挂载。
 *
 * 图标集为原版 SVG：歌词显隐 / 罗马音 / 翻译开关（歌词三项有对应数据才
 * 显示）+ 纯净模式（背景视频就绪时）+ 喜欢 + 播放模式（房主）+ 播放队列 +
 * 设置 + 播放页 UI 深浅色 + 全屏 + 收起，以及 B站 条目专属的弹幕开关 /
 * 网易云搜索 / 收藏红心 / 添加到收藏夹。
 *
 * 手机竖屏隐藏（卡片全宽后右侧 50px 悬出区会出屏），改为卡片下方的水平
 * 工具行（PlayerMobileToolbarRow）；手机横屏默认隐藏、触摸亮起 3s
 * （useLandscapeToolbarFlash）。
 */
import type { RefObject } from 'react'
import type { Socket } from 'socket.io-client'
import {
  AlignLeft,
  ChevronDown,
  Contrast,
  ExternalLink,
  Film,
  FolderPlus,
  Heart,
  ListMusic,
  Maximize,
  Minimize,
  MonitorPlay,
  Search,
  Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { prefetchBiliFavFolders } from '@/modules/bilibili/bilibiliApi'
import { MusicQueuePopup } from './MusicQueuePopup'
import {
  DanmakuTvIcon,
  LikeFilledIcon,
  LikeOutlineIcon,
  PlayModeIcon,
  RomanLyricIcon,
  TransLyricIcon,
} from './PlayerControlIcons'
import { TOOLBAR_TONE_VARS, type PlayerUiTone } from '../utils/playerTone'
import { PLAY_MODE_META } from '../constants'
import { badgeWidth } from '../utils/commentBadge'
import type { PlayMode } from '../types'

/** B站 收藏标记（与 useSongFavorite 的会话回显同形） */
export interface BiliCollectedMark {
  bvid: string
  folder: string
  folderId?: number
}

export interface PlayerSongControlProps {
  /** 容器 ref（useToolbarScrollable 的限高滚动测量目标） */
  toolbarRef: RefObject<HTMLDivElement | null>
  /** 指针按下时亮起横屏工具栏（手机横屏触摸 3s 显隐） */
  flashLandscapeToolbar: () => void
  isLandscapeShort: boolean
  landscapeToolbarVisible: boolean
  /** 限高滚动激活（overflow-y-auto；队列弹窗随之切 fixed sheet） */
  toolbarScrollable: boolean
  /** 手机竖屏整列隐藏（卡片全宽后 50px 悬出区会出屏） */
  isPortraitMobile: boolean
  /** 工具栏色调（跟随主题深浅，不跟播放页 UI 开关） */
  toolbarTone: PlayerUiTone

  // ===== 歌词三开关（原词恒显示无开关） =====
  desktopLyricView: boolean
  lyricPanelVisible: boolean
  onToggleDesktopLyricView: () => void
  hasRomaLyric: boolean
  lyricRoma: boolean
  onToggleLyricRoma: () => void
  hasTransLyric: boolean
  lyricTrans: boolean
  onToggleLyricTrans: () => void

  // ===== 纯净模式（背景视频就绪时可用） =====
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

  // ===== 歌词/评论切换（Hydrogen comment-icon：气泡 + 数量胶囊徽章） =====
  canComment: boolean
  rightPanelMode: 0 | 1
  commentBadge: string
  onToggleCommentPanel: () => void

  // ===== 添加视频（Hydrogen Player.vue toAddMusicVideo 入口） =====
  songId?: number
  onAddMusicVideo: () => void

  /** B站 原视频链接：命令式读取当前播放进度（?t= 续看），渲染期仅判空 */
  getBiliSourceUrl: () => string | null

  // ===== 弹幕开关（B站 条目） =====
  isBiliSong: boolean
  biliDanmakuEnabled: boolean
  onToggleDanmaku: () => void

  // ===== 在网易云搜索（B站 条目） =====
  onOpenNcmSearch: () => void

  // ===== B站 收藏红心 / 添加到收藏夹 =====
  biliBvid: string | null
  biliCollected: boolean
  biliCollectedMark: BiliCollectedMark | null
  biliLikeFavTitle: string
  biliCollecting: boolean
  onBiliCollect: () => void
  onOpenBiliFavModal: () => void

  // ===== 播放队列（弹窗侧挂按钮右侧展开 / 限高滚动时切底部 sheet） =====
  queuePopupOpen: boolean
  onToggleQueuePopup: () => void
  queuePlacement: 'side' | 'sheet'
  socket: Socket | null
  roomId: string
  /** 队列管理权限（父级已按 canManage ?? isHost 归一） */
  canManage: boolean

  // ===== 设置 / UI 深浅色 / 全屏 / 收起 =====
  onOpenSettings: () => void
  uiTone: PlayerUiTone
  onToggleUiTone: () => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
  onClose: () => void
}

export function PlayerSongControl({
  toolbarRef,
  flashLandscapeToolbar,
  isLandscapeShort,
  landscapeToolbarVisible,
  toolbarScrollable,
  isPortraitMobile,
  toolbarTone,
  desktopLyricView,
  lyricPanelVisible,
  onToggleDesktopLyricView,
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
  isBiliSong,
  biliDanmakuEnabled,
  onToggleDanmaku,
  onOpenNcmSearch,
  biliBvid,
  biliCollected,
  biliCollectedMark,
  biliLikeFavTitle,
  biliCollecting,
  onBiliCollect,
  onOpenBiliFavModal,
  queuePopupOpen,
  onToggleQueuePopup,
  queuePlacement,
  socket,
  roomId,
  canManage,
  onOpenSettings,
  uiTone,
  onToggleUiTone,
  isFullscreen,
  onToggleFullscreen,
  onClose,
}: PlayerSongControlProps) {
  return (
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
        onClick={onToggleDesktopLyricView}
        className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
        style={{
          color:
            desktopLyricView && lyricPanelVisible
              ? 'var(--md-sys-color-on-surface)'
              : 'var(--md-sys-color-on-surface-variant)',
        }}
        title={desktopLyricView && lyricPanelVisible ? '隐藏歌词' : '显示歌词'}
        aria-label="切换歌词显示"
        aria-pressed={desktopLyricView && lyricPanelVisible}
      >
        <AlignLeft className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
      </button>
      {hasRomaLyric && (
        <button
          type="button"
          onClick={onToggleLyricRoma}
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
          onClick={onToggleLyricTrans}
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
          onClick={onEnterImmersive}
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
          onClick={() => void onLike()}
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
          onClick={onTogglePlayMode}
          className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center transition-opacity hover:opacity-70 active:scale-90"
          style={{ color: 'var(--md-sys-color-on-surface)' }}
          title={`${PLAY_MODE_META[playMode].label}（点击${PLAY_MODE_META[playMode].next}）`}
          aria-label={`播放模式：${PLAY_MODE_META[playMode].label}`}
        >
          <PlayModeIcon
            mode={playMode}
            className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]"
          />
        </button>
      )}
      {/* 歌词/评论切换（Hydrogen comment-icon：气泡 + 数量胶囊徽章） */}
      {canComment && (
        <button
          type="button"
          onClick={onToggleCommentPanel}
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
          onClick={onAddMusicVideo}
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
      {getBiliSourceUrl() && (
        <button
          type="button"
          onClick={() =>
            window.open(getBiliSourceUrl(), '_blank', 'noopener,noreferrer')
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
          onClick={onToggleDanmaku}
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
          onClick={onOpenNcmSearch}
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
          onClick={() => void onBiliCollect()}
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
              ? `已收藏到「${biliCollectedMark?.folder ?? biliLikeFavTitle}」收藏夹；点击取消收藏`
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
          onClick={onOpenBiliFavModal}
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
          onClick={onToggleQueuePopup}
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
            canManage={canManage}
            // 工具栏滚动激活后 overflow 会裁剪侧挂弹窗，
            // 改走 fixed 底部 sheet（见 toolbarScrollable 注释）
            placement={queuePlacement}
          />
        )}
      </div>
      {/* 快捷设置（黑底 SETTING 弹窗：背景设置项汇总） */}
      <button
        type="button"
        onClick={onOpenSettings}
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
        onClick={onToggleUiTone}
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
        onClick={onToggleFullscreen}
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
        onClick={onClose}
        className="flex h-[max(2.5vh,20px)] w-[max(2.5vh,20px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
        title="收起播放器"
        aria-label="收起播放器"
      >
        <ChevronDown className="h-[max(2.5vh,20px)] w-[max(2.5vh,20px)]" />
      </button>
    </div>
  )
}
