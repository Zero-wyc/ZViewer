import { useState, useEffect } from 'react'
import {
  Users,
  Settings,
  Share2,
  Copy,
  MessageSquare,
  Pencil,
  Check,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'

interface RoomInfoPanelProps {
  roomId: string
  isHost: boolean
}

export function RoomInfoPanel({ roomId, isHost }: RoomInfoPanelProps) {
  const { connected, socket } = useSocket()
  const viewers = useRoomStore((state) => state.viewers)
  const roomName = useRoomStore((state) => state.roomName)
  const [showUsers, setShowUsers] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editingNameValue, setEditingNameValue] = useState(roomName)
  const [savingName, setSavingName] = useState(false)

  useEffect(() => {
    setEditingNameValue(roomName)
  }, [roomName])

  const shareUrl = `${window.location.origin}/room/${roomId}?mode=watch-together`

  const handleCopyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(roomId)
      message.success('房间 ID 已复制')
    } catch {
      message.error('复制失败')
    }
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      message.success('分享链接已复制')
    } catch {
      message.error('复制失败')
    }
  }

  const handleSaveName = async () => {
    const trimmed = editingNameValue.trim()
    if (!trimmed) {
      message.warning('房间名称不能为空')
      return
    }
    if (trimmed === roomName) {
      setIsEditingName(false)
      return
    }
    if (!socket) {
      message.error('未连接到房间')
      return
    }
    setSavingName(true)
    socket.emit(
      'update-room-name',
      { roomId, name: trimmed },
      (response: { success: boolean; message?: string }) => {
        setSavingName(false)
        if (response.success) {
          message.success('房间名称已更新')
          setIsEditingName(false)
        } else {
          message.error(response.message || '更新失败')
        }
      }
    )
  }

  const handleCancelEditName = () => {
    setEditingNameValue(roomName)
    setIsEditingName(false)
  }

  return (
    <>
      <Space direction="vertical" className="h-full w-full" size="sm">
        <div className="flex items-center gap-2">
          <div
            className="flex h-2 w-2 rounded-full"
            style={{
              backgroundColor: connected
                ? 'var(--md-sys-color-tertiary)'
                : 'var(--md-sys-color-error)',
            }}
          />
          <Text className="text-xs font-medium">
            {connected ? '已连接' : '未连接'}
          </Text>
          <Text type="secondary" className="text-xs">
            {connected ? 'OPEN' : 'CLOSED'}
          </Text>
        </div>

        <div className="flex items-center gap-2">
          <Text type="secondary" className="text-xs">
            房间名称
          </Text>
          {isEditingName ? (
            <div className="flex flex-1 items-center gap-1">
              <Input
                size="sm"
                value={editingNameValue}
                onChange={(e) => setEditingNameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleSaveName()
                  } else if (e.key === 'Escape') {
                    handleCancelEditName()
                  }
                }}
                disabled={savingName}
                className="min-w-0 flex-1"
              />
              <Button
                variant="primary"
                size="sm"
                className="h-7 w-7 shrink-0 p-0"
                loading={savingName}
                disabled={savingName}
                onClick={() => void handleSaveName()}
                icon={<Check className="h-3.5 w-3.5" />}
              />
              <Button
                variant="secondary"
                size="sm"
                className="h-7 w-7 shrink-0 p-0"
                disabled={savingName}
                onClick={handleCancelEditName}
                icon={<X className="h-3.5 w-3.5" />}
              />
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <span
                className="truncate text-xs font-medium"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
                title={roomName || roomId}
              >
                {roomName || '未命名房间'}
              </span>
              {isHost && (
                <button
                  onClick={() => setIsEditingName(true)}
                  className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                  title="修改房间名称"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Text type="secondary" className="text-xs">
            房间 ID
          </Text>
          <button
            onClick={handleCopyRoomId}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
            style={{ color: 'var(--md-sys-color-primary)' }}
            title="点击复制"
          >
            {roomId}
            <Copy className="h-3 w-3" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<Share2 className="h-3.5 w-3.5" />}
            onClick={handleCopyLink}
          >
            分享链接
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Users className="h-3.5 w-3.5" />}
            onClick={() => setShowUsers(true)}
          >
            在线 ({viewers.length})
          </Button>
          {isHost && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Settings className="h-3.5 w-3.5" />}
              onClick={() => setShowSettings(true)}
            >
              设置
            </Button>
          )}
        </div>
      </Space>

      <Modal
        open={showUsers}
        onClose={() => setShowUsers(false)}
        title="在线用户"
      >
        <Space direction="vertical" className="w-full" size="sm">
          {viewers.length === 0 ? (
            <Paragraph type="secondary" className="text-sm">
              暂无其他在线用户
            </Paragraph>
          ) : (
            viewers.map((viewer) => (
              <div
                key={viewer.socketId}
                className="flex items-center gap-2 rounded-lg px-3 py-2"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                }}
              >
                <MessageSquare
                  className="h-4 w-4"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                />
                <Text className="text-sm">
                  {viewer.username || viewer.socketId.slice(0, 8)}
                </Text>
              </div>
            ))
          )}
        </Space>
      </Modal>

      <Modal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        title="房间设置"
      >
        <Paragraph type="secondary" className="text-sm">
          房间设置功能待完善，当前仅作入口保留。
        </Paragraph>
      </Modal>
    </>
  )
}
