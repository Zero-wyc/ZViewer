import { Lock, Power, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Text } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/utils'
import { formatRecentTime } from '@/lib/formatTime'
import type { AdminRoom } from './shared'
import { formatDate } from './shared'
import { t } from '@/i18n'

interface RoomsTabProps {
  rooms: AdminRoom[]
  roomViewMode: 'list' | 'tile'
  selectedRoomIds: Set<string>
  /** 整体替换选中集合（全选 / 清空 / 单个勾选后的新集合） */
  onChangeSelectedRoomIds: (next: Set<string>) => void
  /** 重新开启已关闭的房间 */
  onReopenRoom: (roomId: string) => void
  /** 正在重新开启的房间 id */
  roomReopeningId: string | null
  /** 请求强制关闭房间（打开确认弹窗） */
  onRequestCloseRoom: (room: AdminRoom) => void
  /** 点击卡片：active 房间进入 host 视角，closed 房间弹警告 */
  onEnterRoom: (room: AdminRoom) => void
}

/** 房间管理 Tab（纯搬迁自 AdminPage，无行为变更） */
export function RoomsTab({
  rooms,
  roomViewMode,
  selectedRoomIds,
  onChangeSelectedRoomIds,
  onReopenRoom,
  roomReopeningId,
  onRequestCloseRoom,
  onEnterRoom,
}: RoomsTabProps) {
  /** 房间创建时间：<24h 相对时间，≥24h 精确时间 */
  const formatRoomCreatedAt = formatRecentTime
  return (
    <div
      className={
        roomViewMode === 'tile'
          ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'
          : 'grid gap-3'
      }
    >
      {rooms.length === 0 ? (
        <EmptyState text={t('暂无房间')} className="col-span-full py-12" />
      ) : (
        <>
          <div
            className={
              roomViewMode === 'tile'
                ? 'col-span-full flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] border px-3 py-2 sm:px-4'
                : 'flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] border px-3 py-2 sm:px-4'
            }
            style={{
              borderColor: 'var(--md-sys-color-outline)',
              backgroundColor: 'var(--glass-bg)',
            }}
          >
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--md-sys-color-primary)]"
              checked={
                rooms.length > 0 &&
                rooms.every((r) => selectedRoomIds.has(r.roomId))
              }
              onChange={(e) => {
                if (e.target.checked) {
                  onChangeSelectedRoomIds(new Set(rooms.map((r) => r.roomId)))
                } else {
                  onChangeSelectedRoomIds(new Set())
                }
              }}
            />
            <Text type="secondary" className="text-sm">
              全选 ({selectedRoomIds.size} / {rooms.length})
            </Text>
          </div>
          {rooms.map((room) => (
            <div
              key={room.id}
              className={cn(
                roomViewMode === 'tile'
                  ? 'flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors cursor-pointer'
                  : 'flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between cursor-pointer',
                selectedRoomIds.has(room.roomId)
                  ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)]'
                  : 'glass border-[var(--md-sys-color-outline)]'
              )}
              onClick={() => onEnterRoom(room)}
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--md-sys-color-primary)]"
                  checked={selectedRoomIds.has(room.roomId)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const next = new Set(selectedRoomIds)
                    if (e.target.checked) {
                      next.add(room.roomId)
                    } else {
                      next.delete(room.roomId)
                    }
                    onChangeSelectedRoomIds(next)
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="truncate font-medium text-[var(--md-sys-color-on-surface)]"
                      title={room.name || room.roomId}
                    >
                      {room.name || room.roomId}
                    </span>
                    <Text
                      type="secondary"
                      className="text-xs sm:hidden"
                      title={room.roomId}
                    >
                      {room.roomId.length > 8
                        ? `${room.roomId.slice(0, 8)}…`
                        : room.roomId}
                    </Text>
                    <Text type="secondary" className="hidden text-xs sm:inline">
                      {room.roomId}
                    </Text>
                    {room.status === 'active' ? (
                      <Tag color="success">{t('进行中')}</Tag>
                    ) : (
                      <Tag color="default">{t('已关闭')}</Tag>
                    )}
                    {room.requireApproval ? (
                      <Tag color="warning">{t('需确认')}</Tag>
                    ) : (
                      <Tag color="cyan">{t('直接加入')}</Tag>
                    )}
                    {room.hasPassword && (
                      <Tag color="purple">
                        <Lock className="mr-1 inline h-3 w-3" />
                        有密码
                      </Tag>
                    )}
                  </div>
                  <Text
                    type="secondary"
                    className="mt-1 text-xs leading-relaxed sm:mt-0"
                  >
                    观众 {room.viewerCount} / {room.maxViewers}
                    {roomViewMode === 'tile' ? <br /> : ' · '}
                    分享端{room.sharerOnline ? t('在线') : t('离线')}
                    {roomViewMode === 'tile' ? <br /> : ' · '}
                    创建于 {formatRoomCreatedAt(room.createdAt)}
                    {roomViewMode === 'tile' ? <br /> : ' · '}
                    最后访问 {formatDate(room.lastAccessedAt)}
                  </Text>
                </div>
              </div>
              <div
                className={cn(
                  'flex w-full flex-col gap-2',
                  roomViewMode === 'tile'
                    ? 'mt-auto'
                    : 'sm:w-auto sm:flex-row sm:items-center sm:justify-end'
                )}
              >
                {room.status === 'closed' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className={
                      roomViewMode === 'tile' ? 'w-full' : 'w-full sm:w-auto'
                    }
                    icon={<RotateCcw className="h-4 w-4" />}
                    loading={roomReopeningId === room.roomId}
                    onClick={(e) => {
                      e.stopPropagation()
                      onReopenRoom(room.roomId)
                    }}
                    title={t('重新开启已关闭的房间')}
                  >
                    {t('重新开启')}
                  </Button>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  className={
                    roomViewMode === 'tile' ? 'w-full' : 'w-full sm:w-auto'
                  }
                  icon={<Power className="h-4 w-4" />}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRequestCloseRoom(room)
                  }}
                  disabled={room.status !== 'active'}
                >
                  {t('关闭房间')}
                </Button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
