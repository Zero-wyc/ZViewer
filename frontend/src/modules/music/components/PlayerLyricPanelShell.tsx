/**
 * 歌词面板外壳（Hydrogen .right-panel）：flex-1 占据播放卡（含右侧 50px
 * 工具栏专列）之外的剩余宽度——专列由卡片恒定 mr-[50px] 结构化预留，面板
 * 宽度与工具栏显隐无关，永不重叠；卡片入场动画展开时面板保持不动。
 * 手机竖屏改为单列下段（flex-1 占满剩余高度）。
 *
 * 面板仅在「尚未就绪」时隐藏（visibility 而非 opacity/transform：
 * 容器一旦带 opacity<1 或 transform 就成为 Backdrop Root，后代冰霜层的
 * backdrop-filter 采样不到面板外背景，玻璃底会渲染成不透明白壳——本项目
 * 反复踩中的陷阱）。就绪后（含无歌词被上层条件整块卸载的分支）由冰霜层/
 * 内容层各自淡入。
 *
 * 时序：冰霜层先淡入（面板玻璃面展开，lt-lyric-panel-in）→ UI 图层延迟
 * 0.25s 后淡入（lt-lyric-content-in，歌词浮现），形成「面板先张开、歌词
 * 再显现」的两段式，避免旧版「半展开空壳僵住 → 歌词突然弹出」的突兀演出。
 * 展开动画必须挂 UI 图层而不能挂面板容器（同 Backdrop Root 陷阱）。
 *
 * 评论模式下整区替换为歌曲评论区（Hydrogen rightPanelMode=1：B站 条目走
 * BiliCommentsPanel、网易云走 SongCommentsPanel）；原词开关关闭时渲染空
 * 占位（仅隐藏原词行会残留翻译/罗马音与高亮条，歌词并未真正消失——历史
 * 结论：完全隐藏 = 不渲染任何歌词行）。
 */
import { cn } from '@/lib/utils'
import type { LyricLine } from '../utils/lrc'
import { PlayerLyricPanel } from './PlayerLyricPanel'
import { SongCommentsPanel } from './SongCommentsPanel'
import { BiliCommentsPanel } from './BiliCommentsPanel'
import { LYRIC_PANEL_TONE_VARS, type PlayerUiTone } from '../utils/playerTone'

export interface PlayerLyricPanelShellProps {
  /** 手机竖屏：单列下段 w-full flex-1；桌面/横屏：h-full flex-1 */
  isPortraitMobile: boolean
  /** 歌词就绪闸门（false 时整面板 visibility hidden，防半展开空壳） */
  lyricRevealed: boolean
  /** 播放页 UI 深浅色（容器级覆盖歌词文字与面板底色令牌） */
  uiTone: PlayerUiTone
  /** UI 整体透明度（只作用于 UI 图层，冰霜层不参与） */
  uiFade: number
  /** 0 歌词 / 1 评论区（Hydrogen rightPanelMode） */
  rightPanelMode: 0 | 1
  /** B站 评论区目标（null = 网易云条目走 SongCommentsPanel） */
  currentBiliBvid: string | null
  lyricOriginal: boolean
  lyricRoma: boolean
  showTranslation: boolean
  lines: LyricLine[]
  activeIndex: number
  emptyMode: 'none' | 'pure' | null
  lyricSize: number
  tlyricSize: number
  rlyricSize: number
  interludeThresholdSec: number
  lyricBlur: boolean
  lyricBlurPx: number
  /** 当前行高亮遮罩不透明度（0-100 百分数，组件内换算 0-1） */
  lyricMaskOpacityPct: number
  lyricMaskBlur: number
  onSeek: (time: number) => void
  onUpdateLineOffset: (line: LyricLine, deltaSec: number) => void
  qualityLabel: string
}

export function PlayerLyricPanelShell({
  isPortraitMobile,
  lyricRevealed,
  uiTone,
  uiFade,
  rightPanelMode,
  currentBiliBvid,
  lyricOriginal,
  lyricRoma,
  showTranslation,
  lines,
  activeIndex,
  emptyMode,
  lyricSize,
  tlyricSize,
  rlyricSize,
  interludeThresholdSec,
  lyricBlur,
  lyricBlurPx,
  lyricMaskOpacityPct,
  lyricMaskBlur,
  onSeek,
  onUpdateLineOffset,
  qualityLabel,
}: PlayerLyricPanelShellProps) {
  return (
    <div
      className={cn(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden',
        isPortraitMobile ? 'w-full flex-1' : 'h-full flex-1'
      )}
      // 面板仅在「尚未就绪」时隐藏（visibility 而非 opacity/transform：
      // 容器一旦带 opacity<1 或 transform 就成为 Backdrop Root，后代
      // 冰霜层的 backdrop-filter 采样不到面板外背景，玻璃底会渲染成
      // 不透明白壳——本项目反复踩中的陷阱）。就绪后由冰霜层/内容层
      // 各自淡入，见组件头注释
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
        结束后突然变回毛玻璃（突兀闪变） */}
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
            lines={lines}
            activeIndex={activeIndex}
            emptyMode={emptyMode}
            revealed={lyricRevealed}
            showTranslation={showTranslation}
            showOriginal={lyricOriginal}
            showRoman={lyricRoma}
            lyricSize={lyricSize}
            tlyricSize={tlyricSize}
            rlyricSize={rlyricSize}
            interludeThresholdSec={interludeThresholdSec}
            lyricBlur={lyricBlur}
            lyricBlurPx={lyricBlurPx}
            lyricMaskOpacity={lyricMaskOpacityPct / 100}
            lyricMaskBlur={lyricMaskBlur}
            onSeek={onSeek}
            onUpdateLineOffset={onUpdateLineOffset}
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
  )
}
