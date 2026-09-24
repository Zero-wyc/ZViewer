/**
 * 播放页背景层（ Hydrogen PlayerVideo / .music-player 的底层三重奏）。
 *
 * 从 ListenTogetherPanel 抽出的一整段「纯背景」渲染：由上而下覆盖
 *
 * 1. **封面毛玻璃**：有封面即渲染，模糊半径随「封面模糊」设置注入
 *    `--cover-blur`（关闭时 0 = 显示未模糊封面，而非纯色底）
 * 2. **上一首封面快照**：切歌瞬间交叉溶解，盖住「视频未就绪」的空档避免黑屏
 * 3. **自定义视频背景**：B站 视频关联曲目；`contain` 模式额外铺一层放大模糊
 *    封面填充黑边；`fixed` 提升用于纯净模式，元素不重挂、播放流不断
 * 4. **背景压暗**：黑色遮罩盖在背景之上、内容之下
 * 5. **纯净模式点按层**：单击切播放暂停、双击退出（Esc 亦可退出）
 *
 * 交叉溶解的快照状态自持：父组件只需传 cover，换曲判定在本组件 render 期
 * 完成（React 官方 props 变化调 state 模式，规避 effect 内同步 setState）。
 */
import { useState } from 'react'
import type { CSSProperties, MouseEvent, RefObject } from 'react'
import { cn } from '@/lib/utils'

export interface PlayerBackgroundLayerProps {
  /** 当前曲目封面（无封面时不渲染封面层） */
  cover?: string
  /** 当前曲目 ID（封面层 key：切歌重挂触发 zen-cover-fade 淡入） */
  songId?: number
  /** 封面模糊半径（px；毛玻璃关闭时为 0） */
  coverBlurPx: number
  /** 背景视频源 URL（null = 当前曲目无关联视频） */
  videoUrl: string | null
  /** 视频画面适配方式 */
  videoFit: 'contain' | 'cover' | 'fill'
  /** 视频背景模糊半径（px） */
  videoBlurLevel: number
  /** 背景 video 元素 ref（由 useBackgroundVideoSync 持有） */
  videoRef: RefObject<HTMLVideoElement | null>
  /** 背景 video 事件接线（门控升级 / 强制对齐） */
  videoHandlers: {
    onLoadedMetadata: () => void
    onCanPlay: () => void
    onPlaying: () => void
  }
  /** 视频画面是否已可显现（首帧可播） */
  videoVisible: boolean
  /** 背景压暗百分比（0-100） */
  bgDim: number
  /** 纯净模式（背景视频沉浸） */
  immersive: boolean
  /** 纯净模式点按层回调（单击播放/暂停，双击退出） */
  onImmersiveTap: (e: MouseEvent) => void
}

export function PlayerBackgroundLayer({
  cover,
  songId,
  coverBlurPx,
  videoUrl,
  videoFit,
  videoBlurLevel,
  videoRef,
  videoHandlers,
  videoVisible,
  bgDim,
  immersive,
  onImmersiveTap,
}: PlayerBackgroundLayerProps) {
  // ===== 切歌封面交叉溶解：换曲瞬间快照上一首封面为独立背景层（0.9s
  //       淡出，动画结束即卸载），与新封面 zen-cover-fade 淡入交叠——
  //       当前背景（封面或视频消失后的空档）优雅溶解为下一首封面，
  //       视频就绪后再淡入视频 =====
  const [coverFade, setCoverFade] = useState<string | null>(null)
  const [lastRenderCover, setLastRenderCover] = useState<string | null>(
    cover ?? null
  )
  if ((cover ?? null) !== lastRenderCover) {
    setLastRenderCover(cover ?? null)
    if (lastRenderCover) {
      setCoverFade(lastRenderCover)
    }
  }

  return (
    <>
      {/* ===== 封面背景（Hydrogen 复刻 + 模糊度可调）：有封面即渲染——
          切歌时淡入淡出 ===== */}
      {cover && (
        <div
          key={songId}
          className="lt-cover-backdrop zen-cover-fade pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[120%] w-[120%] overflow-hidden"
          style={
            {
              '--cover-blur': `${coverBlurPx}px`,
            } as CSSProperties
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
      {coverFade && (
        <div
          key={coverFade}
          className="lt-cover-backdrop zen-cover-fade-out pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[120%] w-[120%] overflow-hidden"
          style={
            {
              '--cover-blur': `${coverBlurPx}px`,
            } as CSSProperties
          }
          aria-hidden="true"
          onAnimationEnd={() => setCoverFade(null)}
        >
          <img
            src={coverFade}
            alt=""
            className="h-full w-full object-cover"
            style={{ transform: 'scale(1.08)' }}
          />
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--md-sys-color-surface)_30%,transparent)]" />
        </div>
      )}

      {/* ===== 自定义视频背景：静音铺满 + 跟随音乐播放/暂停，盖在封面模糊
          背景之上；解析未就绪时自然露出封面模糊兜底。纯净模式时提升为
          fixed 全屏唯一图层（元素不重挂，播放流不断） ===== */}
      {videoUrl && (
        <>
          {/* ===== contain 黑边填充：放大模糊的封面铺满底层（视频网站
              同款手法），视频 object-contain 完整显示不裁剪，"黑边"
              区域由画面感填充，视觉无黑边 ===== */}
          {videoFit === 'contain' && (
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
          {/* 视频本体：可见性门控——首帧可播（canplay/playing）前保持透明，
              视频解析/缓冲期间优雅显示封面背景，就绪后 0.9s ease 淡入；
              视频自身永不接收指针事件（纯净模式点击穿透到点按层） */}
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            loop
            onLoadedMetadata={videoHandlers.onLoadedMetadata}
            onCanPlay={videoHandlers.onCanPlay}
            onPlaying={videoHandlers.onPlaying}
            className={cn(
              'pointer-events-none h-full w-full',
              videoFit === 'cover'
                ? 'object-cover'
                : videoFit === 'fill'
                  ? 'object-fill'
                  : 'object-contain',
              immersive ? 'fixed inset-0 z-[70]' : 'absolute inset-0 z-0'
            )}
            style={{
              opacity: videoVisible ? 1 : 0,
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
            onClick={onImmersiveTap}
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
    </>
  )
}
