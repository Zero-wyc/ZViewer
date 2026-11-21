import { type ReactNode } from 'react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/useMediaQuery'
import { useListenLyricsSlot } from '@/modules/music/hooks/useListenLyricsSlot'

interface CinemaLayoutProps {
  children: ReactNode
  /** 房间信息面板（watch-together 模式使用） */
  roomInfoPanel?: ReactNode
  /** 影片列表面板（watch-together 模式使用） */
  movieListPanel?: ReactNode
  /** 添加影片面板（watch-together 模式使用） */
  moviePushPanel?: ReactNode
  /**
   * 投屏状态面板（screen-share 模式使用）。
   * 提供时替代三列网格，底部仅渲染此面板（与房主端布局一致）。
   */
  statsPanel?: ReactNode
  chatPanel: ReactNode
  /**
   * CSS 模拟的网页全屏状态。
   * 为 true 时整个布局变为 fixed 铺满视口，隐藏底部面板和聊天区，
   * 并移除 Card 的 backdrop-filter 以避免成为 fixed 定位的包含块。
   */
  webFullscreen?: boolean
}

export function CinemaLayout({
  children,
  roomInfoPanel,
  movieListPanel,
  moviePushPanel,
  statsPanel,
  chatPanel,
  webFullscreen = false,
}: CinemaLayoutProps) {
  // 手机竖屏：聊天区（评论区）排在播放器正下方，而不是落到所有底部卡片之后。
  // 桌面端维持「右侧 340px 固定列」的影院布局。
  const isMobile = useIsMobile()
  const chatInline = isMobile && !webFullscreen
  // 一起听歌词插槽：非全屏时贴在播放器下方
  const lyricsSlotRef = useListenLyricsSlot()
  // 底部卡片容器统一样式
  const cardContainerClass = 'glass-card rounded-2xl p-4'

  // 底部内容：screen-share 模式下渲染 statsPanel + roomInfoPanel；
  // watch-together 模式渲染三列网格（roomInfo / movieList / moviePush）
  const bottomContent = statsPanel ? (
    <div className="flex flex-col gap-4">
      {roomInfoPanel && (
        <div className={cardContainerClass}>{roomInfoPanel}</div>
      )}
      <div className={cardContainerClass}>{statsPanel}</div>
    </div>
  ) : (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className={cardContainerClass}>{roomInfoPanel}</div>
      <div className={cardContainerClass}>{movieListPanel}</div>
      <div className={cardContainerClass}>{moviePushPanel}</div>
    </div>
  )

  return (
    <div
      className={cn(
        'p-4 lg:p-6',
        webFullscreen
          ? 'fixed inset-0 z-[100] h-screen overflow-hidden p-0'
          : 'min-h-[calc(100vh-64px)]'
      )}
      style={{ backgroundColor: 'transparent' }}
    >
      <Card
        disableAnimation={webFullscreen}
        className={cn(
          'relative mx-auto flex w-full flex-col overflow-hidden bg-transparent',
          webFullscreen
            ? 'h-full w-full max-w-none !rounded-none !border-0 !bg-black !p-0 !shadow-none !backdrop-filter-none'
            : 'max-w-[1600px]'
        )}
      >
        <div
          className={cn(
            'gap-4 p-4 lg:flex-row',
            webFullscreen ? 'flex h-full flex-col p-0' : 'flex flex-col'
          )}
        >
          {/* 主区域 */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* 播放器区域 */}
            <div
              className={cn(
                'relative w-full overflow-hidden rounded-2xl',
                !webFullscreen && 'rounded-2xl'
              )}
              style={
                webFullscreen
                  ? { height: '100%', backgroundColor: '#000' }
                  : {
                      aspectRatio: '16 / 9',
                      backgroundColor: '#000',
                      borderColor: 'var(--md-sys-color-outline-variant)',
                    }
              }
            >
              {children}
            </div>

            {/* 一起听歌词：非全屏时贴在播放器下方 */}
            {!webFullscreen && <div ref={lyricsSlotRef} className="w-full" />}

            {/* 手机端：评论区紧贴播放器（底部信息卡之前），高度受限可滚动 */}
            {chatInline && (
              <div
                className="flex w-full flex-col overflow-hidden"
                style={{ height: 'min(420px, 55dvh)' }}
              >
                {chatPanel}
              </div>
            )}

            {/* 底部信息/控制/添加区（或投屏状态面板）—— 网页全屏时隐藏 */}
            {!webFullscreen && bottomContent}
          </div>

          {/* 右侧聊天区 —— 网页全屏和手机端（已内嵌到播放器下方）时隐藏 */}
          {!webFullscreen && !chatInline && (
            <div className="glass-card w-full flex-shrink-0 rounded-2xl lg:w-[340px]">
              <div className="p-4">{chatPanel}</div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
