/**
 * 播放卡玻璃内层（Hydrogen .player）：两层结构（毛玻璃 + 透明度解耦）。
 *
 * ① 冰霜层——常驻满强度 backdrop 模糊（不随 UI 透明度淡出），负责把页面
 *    背景模糊成不透明的「磨砂底」；
 * ② UI 图层——面板底色 + 全部内容作为一个整体图层，随 UI 透明度整体淡出。
 *    图层背后是冰霜层（已模糊画面），淡出永远不会露出锐利背景 → 模糊与
 *    透明度同时成立。
 *    冰霜层/底色 tint 均 pointer-events-none：定位元素绘制在非定位内容
 *    之上，不禁用指针会盖住 UI 图层里未加 relative 的交互元素（38d19ec
 *    回归：三键播放控制按钮无法点击——进度条/音量条因 track 有 relative
 *    幸免）。
 *
 * 卡底 tint 层（**在 uiFade 图层之外**）：卡底毛玻璃采样内容亮度不定
 * （亮封面→亮底、暗视频→暗底），信息层文字色恒与卡底同源（见卡容器
 * CARD_TONE_VARS 变量覆盖注释），故 tint 与文字同组随 UI 深浅色开关切换：
 * 浅色 UI = 恒定亮白底（黑字全场景确定对比度），深色 UI = 恒定暗黑底
 * （白字同理）。刻意不放进 uiFade 图层——UI 透明度调低时若连 tint 一起
 * 淡出，文字会被稀释成灰、且露出更暗的模糊背景，反而更糊；tint 常驻才能
 * 托住文字对比度。竖屏 0.55 / 桌面横屏 0.45（桌面卡面更大，稍低不压背景）。
 *
 * 内容自上而下：封面（max-height 38vh + L 形角标内缩动画）/ 歌名（黑块
 * 滑入遮字 + 跑马灯，双击加入播放队列）/ 歌手（小方点 + 名，横屏矮窗口
 * 时行尾收纳迷你三键）/ 进度条 + 音频可视化 / 三键控制 / 音量横条。
 * vh 尺寸全部 max() 保底，保证横屏矮窗口下仍可读可点；滑条挂 touch-slider
 * 禁触屏滚动。
 */
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { Music } from 'lucide-react'
import { cn } from '@/lib/utils'
import { OverflowMarquee } from './OverflowMarquee'
import { AudioVisualizer } from './AudioVisualizer'
import { PlayerProgressBar } from './PlayerProgressBar'
import {
  ControlNextIcon,
  ControlPauseIcon,
  ControlPlayIcon,
  ControlPrevIcon,
} from './PlayerControlIcons'
import { CARD_TINT, type PlayerUiTone } from '../utils/playerTone'

export interface PlayerCardFaceProps {
  /** 播放页 UI 深浅色（卡底 tint 与文字同组切换） */
  uiTone: PlayerUiTone
  /** UI 整体透明度（设置 uiOpacity 换算，1 = 不透明；只作用于 UI 图层） */
  uiFade: number
  isPortraitMobile: boolean
  /** 横屏矮窗口：迷你三键收纳到歌手行尾，独立三键/音量区隐藏 */
  isLandscapeShort: boolean
  cover?: string
  coverAlt: string
  isBiliSong: boolean
  /** B站 歌封面显示形状（square = 居中裁剪正方形） */
  biliCoverShape: 'original' | 'square'
  songName: string
  artist: string
  /** 切歌黑块滑入（true = 黑块遮住歌名行） */
  songSwitching: boolean
  /** 双击歌名 → 添加当前歌到播放队列 */
  onSongNameDoubleClick: () => void
  onPrev: () => void
  onPlayPause: () => void
  onNext: () => void
  canControl: boolean
  isPlaying: boolean
  durationSec: number
  currentKey: string | null
  seekLock: { key: string | null; sec: number } | null
  /** 本地 seek（已挂等位锁） */
  onSeek: (time: number) => void
  /** 观众 seek 申请（本地只挂等位锁，实际跳转由房主端执行） */
  onRequestSeek: (time: number) => void
  audioVisualizer: boolean
  getAudio: () => HTMLAudioElement | null
  volume: number
  volumeDragging: boolean
  volumeTrackRef: RefObject<HTMLDivElement | null>
  onVolumePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
}

export function PlayerCardFace({
  uiTone,
  uiFade,
  isPortraitMobile,
  isLandscapeShort,
  cover,
  coverAlt,
  isBiliSong,
  biliCoverShape,
  songName,
  artist,
  songSwitching,
  onSongNameDoubleClick,
  onPrev,
  onPlayPause,
  onNext,
  canControl,
  isPlaying,
  durationSec,
  currentKey,
  seekLock,
  onSeek,
  onRequestSeek,
  audioVisualizer,
  getAudio,
  volume,
  volumeDragging,
  volumeTrackRef,
  onVolumePointerDown,
}: PlayerCardFaceProps) {
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="lt-blur-surface pointer-events-none absolute inset-0"
        style={{
          backdropFilter: 'blur(var(--lt-ui-blur, 12px))',
          WebkitBackdropFilter: 'blur(var(--lt-ui-blur, 12px))',
        }}
      />
      {/* 卡底 tint 层（**在 uiFade 图层之外**）：tint 常驻托住文字对比度
          （分层原理见组件头注释）；浅色 UI = 白玻璃、深色 UI = 黑玻璃 */}
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
                alt={coverAlt}
                className={cn(
                  'block w-full object-cover',
                  // B站歌 + 正方形设置：封面居中裁剪呈正方形显示
                  //（网易云封面本就是正方形，不受此项影响）
                  isBiliSong && biliCoverShape === 'square' && 'aspect-square'
                )}
                style={{
                  maxHeight: isPortraitMobile ? 'min(36dvh, 320px)' : '38vh',
                }}
              />
            ) : (
              <div
                className="flex aspect-square w-full items-center justify-center"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
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
            onDoubleClick={onSongNameDoubleClick}
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
                  onClick={onPrev}
                  title={canControl ? '上一首' : '向房主申请切换上一首'}
                  aria-label="上一首"
                >
                  <ControlPrevIcon className="h-[max(3.6vh,28px)] w-[max(3.6vh,28px)]" />
                </button>
                <button
                  type="button"
                  className="flex h-[max(3.6vh,28px)] w-[max(3.6vh,28px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                  onClick={onPlayPause}
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
                  onClick={onNext}
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
              onSeek={onSeek}
              onRequestSeek={onRequestSeek}
            />

            {/* 音频可视化（设置：音频可视化 → 真实频谱于进度条下方；
              captureStream 旁路 WebAudio analyser，Hydrogen 同思路） */}
            {audioVisualizer && (
              <div
                className="flex shrink-0 items-center justify-center pt-[max(0.6vh,4px)]"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
              >
                <AudioVisualizer getAudio={getAudio} playing={isPlaying} />
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
                onClick={onPrev}
                title={canControl ? '上一首' : '向房主申请切换上一首'}
                aria-label="上一首"
              >
                <ControlPrevIcon className="h-[max(5vh,36px)] w-[max(5vh,36px)]" />
              </button>
              <button
                type="button"
                className="flex h-[max(5vh,36px)] w-[max(5vh,36px)] items-center justify-center text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
                onClick={onPlayPause}
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
                onClick={onNext}
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
                  boxShadow: '0 0 0 0.5px var(--md-sys-color-on-surface)',
                }}
                onPointerDown={onVolumePointerDown}
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
                <span className="tabular-nums">{Math.round(volume * 100)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
