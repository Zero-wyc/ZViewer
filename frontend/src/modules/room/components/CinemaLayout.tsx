import { type ReactNode } from 'react'
import { Card } from '@/components/ui/Card'

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
}

export function CinemaLayout({
  children,
  roomInfoPanel,
  movieListPanel,
  moviePushPanel,
  statsPanel,
  chatPanel,
}: CinemaLayoutProps) {
  // 底部卡片容器统一样式
  const cardContainerClass = 'rounded-2xl border p-4'
  const cardContainerStyle = {
    backgroundColor: 'var(--md-sys-color-surface-container)',
    borderColor: 'var(--md-sys-color-outline-variant)',
  }

  // 底部内容：screen-share 模式下只渲染 statsPanel；
  // watch-together 模式渲染三列网格（roomInfo / movieList / moviePush）
  const bottomContent = statsPanel ? (
    <div className="rounded-2xl border p-4" style={cardContainerStyle}>
      {statsPanel}
    </div>
  ) : (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className={cardContainerClass} style={cardContainerStyle}>
        {roomInfoPanel}
      </div>
      <div className={cardContainerClass} style={cardContainerStyle}>
        {movieListPanel}
      </div>
      <div className={cardContainerClass} style={cardContainerStyle}>
        {moviePushPanel}
      </div>
    </div>
  )

  return (
    <div
      className="min-h-[calc(100vh-64px)] p-4 lg:p-6"
      style={{ backgroundColor: 'var(--md-sys-color-surface)' }}
    >
      <Card className="relative mx-auto flex w-full max-w-[1600px] flex-col overflow-hidden">
        <div className="flex flex-col gap-4 p-4 lg:flex-row">
          {/* 主区域 */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* 播放器区域 */}
            <div
              className="relative w-full overflow-hidden rounded-2xl"
              style={{
                aspectRatio: '16 / 9',
                backgroundColor: '#000',
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            >
              {children}
            </div>

            {/* 底部信息/控制/添加区（或投屏状态面板） */}
            {bottomContent}
          </div>

          {/* 右侧聊天区 */}
          <div
            className="w-full flex-shrink-0 rounded-2xl border lg:w-[340px]"
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container)',
              borderColor: 'var(--md-sys-color-outline-variant)',
            }}
          >
            <div className="p-4">{chatPanel}</div>
          </div>
        </div>
      </Card>
    </div>
  )
}
