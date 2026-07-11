import { type ReactNode } from 'react'
import { Card } from '@/components/ui/Card'

interface CinemaLayoutProps {
  children: ReactNode
  roomInfoPanel: ReactNode
  movieListPanel: ReactNode
  moviePushPanel: ReactNode
  chatPanel: ReactNode
}

export function CinemaLayout({
  children,
  roomInfoPanel,
  movieListPanel,
  moviePushPanel,
  chatPanel,
}: CinemaLayoutProps) {
  return (
    <div
      className="flex-1 flex items-center justify-center p-4 lg:p-6"
      style={{ backgroundColor: 'var(--md-sys-color-surface)' }}
    >
      <Card className="relative flex h-full w-full max-w-[1600px] flex-col overflow-hidden">
        <div className="flex flex-1 gap-4 overflow-hidden p-4">
          {/* 主区域 */}
          <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden">
            {/* 播放器区域 */}
            <div
              className="relative min-h-[50vh] flex-1 overflow-hidden rounded-2xl lg:min-h-[60vh]"
              style={{
                backgroundColor: '#000',
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            >
              {children}
            </div>

            {/* 底部信息/控制/添加区 */}
            <div className="grid flex-shrink-0 grid-cols-1 gap-4 lg:grid-cols-3">
              <div
                className="rounded-2xl border p-4"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                {roomInfoPanel}
              </div>
              <div
                className="rounded-2xl border p-4"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                {movieListPanel}
              </div>
              <div
                className="rounded-2xl border p-4"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                {moviePushPanel}
              </div>
            </div>
          </div>

          {/* 右侧聊天区 */}
          <div
            className="hidden w-[340px] flex-col overflow-hidden rounded-2xl border lg:flex"
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container)',
              borderColor: 'var(--md-sys-color-outline-variant)',
            }}
          >
            <div className="flex-1 overflow-hidden p-4">{chatPanel}</div>
          </div>
        </div>
      </Card>
    </div>
  )
}
