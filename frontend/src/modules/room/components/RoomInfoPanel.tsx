import { useState, useEffect, useMemo } from 'react'
import {
  Users,
  Settings,
  Share2,
  Copy,
  MessageSquare,
  Pencil,
  Check,
  X,
  UserX,
  VolumeX,
  Volume2,
  Crown,
  Shield,
  Lock,
  Unlock,
  UserCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { useAuthStore } from '@/store/authStore'

interface RoomInfoPanelProps {
  roomId: string
  isHost: boolean
}

type SettingsTab = 'info' | 'viewers' | 'permissions'

// 后端 socket.data.role 取值
type UserRole = 'root' | 'admin' | 'user' | 'guest'

const ROLE_LABELS: Record<UserRole, string> = {
  root: '超级管理员',
  admin: '管理员',
  user: '普通用户',
  guest: '游客',
}

const ROLE_COLORS: Record<UserRole, string> = {
  root: 'var(--md-sys-color-error)',
  admin: 'var(--md-sys-color-primary)',
  user: 'var(--md-sys-color-tertiary)',
  guest: 'var(--md-sys-color-outline)',
}

function RoleBadge({ role }: { role?: string }) {
  if (!role || !(role in ROLE_LABELS)) return null
  const label = ROLE_LABELS[role as UserRole]
  const color = ROLE_COLORS[role as UserRole]
  return (
    <span
      className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium"
      style={{
        backgroundColor: 'color-mix(in srgb, ' + color + ' 15%, transparent)',
        color,
      }}
    >
      {label}
    </span>
  )
}

export function RoomInfoPanel({
  roomId,
  isHost: isHostProp,
}: RoomInfoPanelProps) {
  const { connected, socket } = useSocket()
  const viewers = useRoomStore((state) => state.viewers)
  const roomName = useRoomStore((state) => state.roomName)
  const roomSettings = useRoomStore((state) => state.roomSettings)
  const addMutedViewer = useRoomStore((state) => state.addMutedViewer)
  const removeMutedViewer = useRoomStore((state) => state.removeMutedViewer)
  const setRoomSettings = useRoomStore((state) => state.setRoomSettings)
  const currentUserId = useAuthStore((state) => state.user?.id)

  const [showUsers, setShowUsers] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('info')
  const [isEditingName, setIsEditingName] = useState(false)
  const [editingNameValue, setEditingNameValue] = useState(roomName)
  const [savingName, setSavingName] = useState(false)

  // 房间设置表单
  const [passwordValue, setPasswordValue] = useState('')
  const [maxViewersValue, setMaxViewersValue] = useState(10)
  const [requireApprovalValue, setRequireApprovalValue] = useState(true)
  const [savingSettings, setSavingSettings] = useState(false)

  // 房主转交确认
  const [transferTarget, setTransferTarget] = useState<{
    socketId: string
    username?: string
  } | null>(null)
  const [transferring, setTransferring] = useState(false)

  // 内部维护 isHost 状态：监听 host-transferred 事件后即时切换
  // 转交房主后，原房主按钮立即隐藏；新房主按钮立即显示
  const [isHost, setIsHost] = useState(isHostProp)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 同步 isHostProp 到内部状态
    setIsHost(isHostProp)
  }, [isHostProp])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 同步 roomName 到编辑框
    setEditingNameValue(roomName)
  }, [roomName])

  // 打开设置 Modal 时同步当前房间设置到表单
  useEffect(() => {
    if (showSettings) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开设置时同步房间设置到表单
      setPasswordValue(roomSettings.password ?? '')
      setMaxViewersValue(roomSettings.maxViewers)
      setRequireApprovalValue(roomSettings.requireApproval)
    }
  }, [showSettings, roomSettings])

  const shareUrl = `${window.location.origin}/room/${roomId}`

  // 监听权限相关事件
  useEffect(() => {
    if (!socket) return

    const handleViewerMuted = (payload: { userId: number; muted: boolean }) => {
      if (!payload || typeof payload.userId !== 'number') return
      if (payload.muted) {
        addMutedViewer(payload.userId)
      } else {
        removeMutedViewer(payload.userId)
      }
      // 自己被禁言/解禁时给出提示
      const isSelf =
        currentUserId != null &&
        String(payload.userId) === String(currentUserId)
      if (isSelf) {
        if (payload.muted) {
          message.warning('您已被房主禁言')
        } else {
          message.success('您已被解除禁言')
        }
      }
    }

    const handleHostTransferred = (payload: {
      newHostSocketId: string
      oldHostSocketId: string
      newOwnerUserId: number | null
    }) => {
      if (!payload) return
      // 判断当前 socket 是否为新房主：通过比较 socket.id
      // socket.id 在 useSocket 内部维护，这里通过 socket?.id 获取
      const mySocketId = socket?.id
      if (payload.newHostSocketId === mySocketId) {
        setIsHost(true)
        message.success('您已成为新房主')
      } else if (payload.oldHostSocketId === mySocketId) {
        setIsHost(false)
        message.info('房主已转交，您已成为观众')
      } else {
        message.info('房主已变更')
      }
    }

    const handleRoomSettingsUpdated = (payload: {
      password: string | null
      maxViewers: number
      requireApproval: boolean
    }) => {
      if (!payload) return
      setRoomSettings({
        password: payload.password,
        maxViewers: payload.maxViewers,
        requireApproval: payload.requireApproval,
      })
    }

    const handleViewerKicked = (payload: { reason?: string }) => {
      message.error(payload?.reason || '您已被房主移出房间')
      // 退出房间由全局导航处理
    }

    socket.on('viewer-muted', handleViewerMuted)
    socket.on('host-transferred', handleHostTransferred)
    socket.on('room-settings-updated', handleRoomSettingsUpdated)
    socket.on('viewer-kicked', handleViewerKicked)

    return () => {
      socket.off('viewer-muted', handleViewerMuted)
      socket.off('host-transferred', handleHostTransferred)
      socket.off('room-settings-updated', handleRoomSettingsUpdated)
      socket.off('viewer-kicked', handleViewerKicked)
    }
  }, [
    socket,
    addMutedViewer,
    removeMutedViewer,
    setRoomSettings,
    currentUserId,
  ])

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

  // --- 房主管理操作 ---
  const handleKick = (viewerSocketId: string) => {
    if (!socket) return
    socket.emit(
      'kick-viewer',
      { roomId, viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.success('已将该观众移出房间')
        } else {
          message.error(response.message || '踢人失败')
        }
      }
    )
  }

  const handleToggleMute = (userId?: number, muted?: boolean) => {
    if (!socket || userId == null) return
    const event = muted ? 'unmute-viewer' : 'mute-viewer'
    socket.emit(
      event,
      { roomId, userId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.success(muted ? '已解除禁言' : '已禁言该观众')
        } else {
          message.error(response.message || '操作失败')
        }
      }
    )
  }

  const handleTransferHost = () => {
    if (!socket || !transferTarget) return
    setTransferring(true)
    socket.emit(
      'transfer-host',
      { roomId, viewerSocketId: transferTarget.socketId },
      (response: { success: boolean; message?: string }) => {
        setTransferring(false)
        if (response.success) {
          message.success(`已将房主转交给 ${transferTarget.username || '观众'}`)
          setTransferTarget(null)
        } else {
          message.error(response.message || '转交失败')
        }
      }
    )
  }

  const handleSaveSettings = () => {
    if (!socket) return
    const trimmedPwd = passwordValue.trim()
    if (maxViewersValue < 1 || maxViewersValue > 100) {
      message.warning('观众上限必须在 1-100 之间')
      return
    }
    setSavingSettings(true)
    socket.emit(
      'update-room-settings',
      {
        roomId,
        password: trimmedPwd,
        maxViewers: maxViewersValue,
        requireApproval: requireApprovalValue,
      },
      (response: { success: boolean; message?: string }) => {
        setSavingSettings(false)
        if (response.success) {
          message.success('房间设置已保存')
        } else {
          message.error(response.message || '保存失败')
        }
      }
    )
  }

  // 在线观众列表（带管理按钮）渲染
  const renderViewerItem = (
    viewer: (typeof viewers)[number],
    withActions: boolean
  ) => {
    const isMuted = !!viewer.muted
    // 后端 userId 为 number，前端 User.id 为 string，统一转 string 比较
    const isSelf =
      viewer.userId != null &&
      currentUserId != null &&
      String(viewer.userId) === String(currentUserId)
    const canManage =
      withActions &&
      isHost &&
      !isSelf && // 不能操作自己
      viewer.role !== 'root' // 不能对 root 操作
    return (
      <div
        key={viewer.socketId}
        className="flex items-center gap-2 rounded-lg px-3 py-2"
        style={{
          backgroundColor: 'var(--md-sys-color-surface-container-high)',
        }}
      >
        <MessageSquare
          className="h-4 w-4 shrink-0"
          style={{ color: 'var(--md-sys-color-primary)' }}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <Text className="truncate text-sm">
              {viewer.username || viewer.socketId.slice(0, 8)}
            </Text>
            <RoleBadge role={viewer.role} />
            {isMuted && (
              <span
                className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-error) 15%, transparent)',
                  color: 'var(--md-sys-color-error)',
                }}
              >
                已禁言
              </span>
            )}
          </div>
          {viewer.userId != null && (
            <Text type="secondary" className="text-[10px]">
              ID: {viewer.userId}
            </Text>
          )}
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => handleToggleMute(viewer.userId, isMuted)}
              className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container)]"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              title={isMuted ? '解除禁言' : '禁言'}
            >
              {isMuted ? (
                <Volume2 className="h-3.5 w-3.5" />
              ) : (
                <VolumeX className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              onClick={() =>
                setTransferTarget({
                  socketId: viewer.socketId,
                  username: viewer.username,
                })
              }
              className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container)]"
              style={{ color: 'var(--md-sys-color-tertiary)' }}
              title="转交房主"
            >
              <Crown className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => handleKick(viewer.socketId)}
              className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container)]"
              style={{ color: 'var(--md-sys-color-error)' }}
              title="移出房间"
            >
              <UserX className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    )
  }

  const tabItems = useMemo(
    () => [
      { key: 'info' as const, label: '房间信息', icon: Settings },
      { key: 'viewers' as const, label: '观众管理', icon: Users },
      { key: 'permissions' as const, label: '权限说明', icon: Shield },
    ],
    []
  )

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
          {isHost && (
            <span
              className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-primary) 15%, transparent)',
                color: 'var(--md-sys-color-primary)',
              }}
            >
              <Crown className="h-3 w-3" />
              房主
            </span>
          )}
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

        {isHost && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Users
                className="h-3.5 w-3.5"
                style={{ color: 'var(--md-sys-color-primary)' }}
              />
              <Text type="secondary" className="text-xs">
                在线观众（{viewers.length}）
              </Text>
            </div>
            {viewers.length === 0 ? (
              <Text type="secondary" className="text-xs">
                暂无在线观众
              </Text>
            ) : (
              <div className="flex flex-col gap-1">
                {viewers.map((viewer) => (
                  <div
                    key={viewer.socketId}
                    className="flex items-center gap-1.5 rounded px-2 py-1"
                    style={{
                      backgroundColor:
                        'var(--md-sys-color-surface-container-high)',
                    }}
                  >
                    <MessageSquare
                      className="h-3 w-3 shrink-0"
                      style={{ color: 'var(--md-sys-color-primary)' }}
                    />
                    <Text className="truncate text-xs">
                      {viewer.username || viewer.socketId.slice(0, 8)}
                    </Text>
                    <RoleBadge role={viewer.role} />
                    {viewer.muted && (
                      <VolumeX
                        className="ml-auto h-3 w-3 shrink-0"
                        style={{ color: 'var(--md-sys-color-error)' }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
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
            viewers.map((viewer) => renderViewerItem(viewer, true))
          )}
        </Space>
      </Modal>

      <Modal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        title="房间设置"
        className="max-w-lg"
      >
        <div className="flex flex-col gap-4">
          {/* Tab 切换 */}
          <div className="flex items-center gap-1 border-b border-[var(--md-sys-color-outline-variant)] pb-2">
            {tabItems.map((tab) => {
              const Icon = tab.icon
              const active = settingsTab === tab.key
              return (
                <button
                  key={tab.key}
                  onClick={() => setSettingsTab(tab.key)}
                  className="flex items-center gap-1.5 rounded-t px-3 py-1.5 text-xs font-medium transition-colors"
                  style={{
                    color: active
                      ? 'var(--md-sys-color-primary)'
                      : 'var(--md-sys-color-on-surface-variant)',
                    borderBottom: active
                      ? '2px solid var(--md-sys-color-primary)'
                      : '2px solid transparent',
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              )
            })}
          </div>

          {/* Tab 内容 */}
          {settingsTab === 'info' && (
            <Space direction="vertical" className="w-full" size="sm">
              <div className="flex flex-col gap-1">
                <Text className="text-xs font-medium">房间密码</Text>
                <Input
                  size="sm"
                  value={passwordValue}
                  onChange={(e) => setPasswordValue(e.target.value)}
                  placeholder="留空表示无密码"
                  disabled={!isHost || savingSettings}
                />
                <Text type="secondary" className="text-[10px]">
                  设置后，观众加入需输入密码。root 账户无需密码。
                </Text>
              </div>
              <div className="flex flex-col gap-1">
                <Text className="text-xs font-medium">观众上限</Text>
                <Input
                  size="sm"
                  type="number"
                  min={1}
                  max={100}
                  value={maxViewersValue}
                  onChange={(e) =>
                    setMaxViewersValue(parseInt(e.target.value, 10) || 1)
                  }
                  disabled={!isHost || savingSettings}
                />
              </div>
              <div
                className="flex items-center justify-between rounded px-2 py-1.5"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                }}
              >
                <div className="flex items-center gap-1.5">
                  {requireApprovalValue ? (
                    <Lock
                      className="h-3.5 w-3.5"
                      style={{ color: 'var(--md-sys-color-primary)' }}
                    />
                  ) : (
                    <Unlock
                      className="h-3.5 w-3.5"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    />
                  )}
                  <Text className="text-xs">需要房主审批</Text>
                </div>
                <button
                  onClick={() =>
                    isHost &&
                    !savingSettings &&
                    setRequireApprovalValue((prev) => !prev)
                  }
                  disabled={!isHost || savingSettings}
                  className="relative h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed"
                  style={{
                    backgroundColor: requireApprovalValue
                      ? 'var(--md-sys-color-primary)'
                      : 'var(--md-sys-color-surface-container-highest)',
                  }}
                >
                  <span
                    className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
                    style={{
                      left: requireApprovalValue ? '18px' : '2px',
                    }}
                  />
                </button>
              </div>
              {isHost && (
                <Button
                  variant="primary"
                  size="sm"
                  block
                  loading={savingSettings}
                  disabled={savingSettings}
                  onClick={handleSaveSettings}
                >
                  保存设置
                </Button>
              )}
            </Space>
          )}

          {settingsTab === 'viewers' && (
            <Space direction="vertical" className="w-full" size="sm">
              <div className="flex items-center justify-between">
                <Text className="text-xs font-medium">
                  在线观众（{viewers.length}）
                </Text>
                <Text type="secondary" className="text-[10px]">
                  {isHost ? '可踢出 / 禁言 / 转交房主' : '仅查看'}
                </Text>
              </div>
              {viewers.length === 0 ? (
                <Paragraph type="secondary" className="text-sm">
                  暂无在线观众
                </Paragraph>
              ) : (
                viewers.map((viewer) => renderViewerItem(viewer, true))
              )}
            </Space>
          )}

          {settingsTab === 'permissions' && (
            <Space direction="vertical" className="w-full" size="sm">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Crown
                    className="h-3.5 w-3.5"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                  <Text className="text-xs font-medium">房主（分享端）</Text>
                </div>
                <Text type="secondary" className="ml-5 text-[11px]">
                  创建房间或被转交房主身份的用户。可踢出 /
                  禁言观众、转交房主、修改房间设置与名称、控制播放。
                </Text>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <UserCheck
                    className="h-3.5 w-3.5"
                    style={{ color: 'var(--md-sys-color-tertiary)' }}
                  />
                  <Text className="text-xs font-medium">观众</Text>
                </div>
                <Text type="secondary" className="ml-5 text-[11px]">
                  加入房间的用户。可观看影片、发送评论与弹幕（未被禁言时）。无法管理房间或其他观众。
                </Text>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Shield
                    className="h-3.5 w-3.5"
                    style={{ color: 'var(--md-sys-color-error)' }}
                  />
                  <Text className="text-xs font-medium">角色权限层级</Text>
                </div>
                <div className="ml-5 flex flex-col gap-0.5 text-[11px]">
                  <Text type="secondary">
                    • <RoleBadge role="root" />{' '}
                    拥有最高权限，可创建房间、接管任意房间
                  </Text>
                  <Text type="secondary">
                    • <RoleBadge role="admin" /> 可创建房间、管理自己创建的房间
                  </Text>
                  <Text type="secondary">
                    • <RoleBadge role="user" /> 普通注册用户，可加入房间观看
                  </Text>
                  <Text type="secondary">
                    • <RoleBadge role="guest" />{' '}
                    游客，仅可观看，不能被转交为房主
                  </Text>
                </div>
              </div>
            </Space>
          )}
        </div>
      </Modal>

      {/* 房主转交确认 Modal */}
      <Modal
        open={!!transferTarget}
        onClose={() => {
          if (!transferring) setTransferTarget(null)
        }}
        title="转交房主确认"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={transferring}
              onClick={() => setTransferTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={transferring}
              disabled={transferring}
              onClick={handleTransferHost}
            >
              确认转交
            </Button>
          </>
        }
      >
        <Paragraph className="text-sm">
          确定要将房主转交给{' '}
          <span
            className="font-medium"
            style={{ color: 'var(--md-sys-color-primary)' }}
          >
            {transferTarget?.username || '该观众'}
          </span>{' '}
          吗？转交后您将变为观众身份，无法再管理房间。
        </Paragraph>
      </Modal>
    </>
  )
}
