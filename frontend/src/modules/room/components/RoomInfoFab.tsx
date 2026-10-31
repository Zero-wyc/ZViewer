/**
 * 房间状态悬浮按钮（一起听模式）。
 *
 * 一起听模式没有下方控制卡片行，房间状态面板改为页面左下角的悬浮
 * 小按钮：默认仅显示圆形按钮，点击展开房间状态面板。挂载于
 * TrafficPanel 的 topSlot 插槽（位于流量统计按钮上方，同列堆叠）。
 */
import { useState } from 'react'
import { ChevronDown, Settings } from 'lucide-react'
import { RoomInfoPanel } from './RoomInfoPanel'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

interface RoomInfoFabProps {
  roomId?: string
  isHost: boolean
}

export function RoomInfoFab({ roomId, isHost }: RoomInfoFabProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex flex-col items-start gap-3 transition-all duration-300">
      {/* 展开的房间状态面板 */}
      {expanded && (
        <div
          className={cn(
            'glass-card flex max-h-[min(70vh,560px)] w-80 flex-col overflow-hidden p-3',
            'zen-modal-content-enter'
          )}
        >
          {/* 标题栏 */}
          <SectionHeader
            icon={<Settings className="h-4 w-4" />}
            title={t('房间状态')}
            subtitle="ROOM INFO"
            className="mb-2"
            extra={
              <button
                onClick={() => setExpanded(false)}
                className="rounded-full p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            }
          />

          {/* 房间状态内容（自身可滚动，避免超出视口） */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <RoomInfoPanel roomId={roomId} isHost={isHost} />
          </div>
        </div>
      )}

      {/* 悬浮触发按钮 */}
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          className={cn(
            'glass-card flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all duration-200',
            'hover:scale-105 hover:shadow-xl active:scale-95'
          )}
          style={{
            backgroundColor: 'var(--glass-bg)',
            color: 'var(--md-sys-color-on-surface)',
          }}
          title={t('房间状态')}
        >
          <Settings className="h-5 w-5" />
        </button>
      )}
    </div>
  )
}
