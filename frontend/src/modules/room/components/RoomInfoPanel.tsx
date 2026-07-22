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
  UserX,
  VolumeX,
  Volume2,
  Crown,
  Shield,
  Lock,
  UserCheck,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
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
  const autoApproveRequests = useRoomStore((state) => state.autoApproveRequests)
  const toggleAutoApproveRequests = useRoomStore(
    (state) => state.toggleAutoApproveRequests
  )
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

  return (
    <>
      <div className="glass-card zen-card flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
        {/* 卡片头部：图标 + 标题 + 连接状态 */}
        <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              background:
                'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-tertiary) 18%, transparent))',
            }}
          >
            <Settings
              className="h-4 w-4"
              style={{ color: 'var(--md-sys-color-primary)' }}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <Text className="text-sm font-semibold leading-tight">
              房间状态
            </Text>
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor: connected
                    ? 'var(--md-sys-color-tertiary)'
                    : 'var(--md-sys-color-error)',
                  boxShadow: connected
                    ? '0 0 6px var(--md-sys-color-tertiary)'
                    : 'none',
                }}
              />
              <Text type="secondary" className="text-[10px] uppercase tracking-wide">
                {connected ? '已连接' : '未连接'}
              </Text>
            </div>
          </div>
          {isHost && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{
                background:
                  'linear-gradient(135deg, var(--md-sys-color-primary), color-mix(in srgb, var(--md-sys-color-primary) 70%, var(--md-sys-color-tertiary)))',
                color: 'var(--md-sys-color-on-primary)',
              }}
            >
              <Crown className="h-2.5 w-2.5" />
              房主
            </span>
          )}
        </div>

        {/* 卡片内容 */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
          {/* 房间名称 */}
          <div className="flex flex-col gap-1">
            <Text type="secondary" className="text-[10px] uppercase tracking-wide">
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
              <div className="flex min-w-0 items-center gap-1">
                <span
                  className="truncate text-sm font-medium"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  title={roomName || roomId}
                >
                  {roomName || '未命名房间'}
                </span>
                {isHost && (
                  <button
                    onClick={() => setIsEditingName(true)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                    title="修改房间名称"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 房间 ID */}
          <div className="flex flex-col gap-1">
            <Text type="secondary" className="text-[10px] uppercase tracking-wide">
              房间 ID
            </Text>
            <button
              onClick={handleCopyRoomId}
              className="flex items-center gap-1.5 self-start rounded-[var(--md-sys-shape-corner)] px-2 py-1 text-xs font-medium transition-all hover:translate-y-[-1px]"
              style={{
                color: 'var(--md-sys-color-primary)',
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-primary) 10%, transparent)',
              }}
              title="点击复制"
            >
              {roomId}
              <Copy className="h-3 w-3" />
            </button>
          </div>

          {/* 操作按钮组 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              icon={<Share2 className="h-3.5 w-3.5" />}
              onClick={handleCopyLink}
            >
              分享
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
            {isHost && (
              <Button
                variant={autoApproveRequests ? 'primary' : 'secondary'}
                size="sm"
                icon={<Zap className="h-3.5 w-3.5" />}
                onClick={() => {
                  toggleAutoApproveRequests()
                  message.info(
                    autoApproveRequests
                      ? '已关闭自动通过申请'
                      : '已开启自动通过申请'
                  )
                }}
                title="开启后，seek / 暂停 / 继续播放 申请将自动通过"
              >
                {autoApproveRequests ? '自动通过：开' : '自动通过：关'}
              </Button>
            )}
          </div>

          {/* 房主端在线观众列表 */}
          {isHost && (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <Users
                  className="h-3.5 w-3.5"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                />
                <Text type="secondary" className="text-[10px] uppercase tracking-wide">
                  在线观众（{viewers.length}）
                </Text>
              </div>
              {viewers.length === 0 ? (
                <div
                  className="flex items-center justify-center rounded-[var(--md-sys-shape-corner)] py-3"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                  }}
                >
                  <Text type="secondary" className="text-xs">
                    暂无在线观众
                  </Text>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
                  {viewers.map((viewer) => (
                    <div
                      key={viewer.socketId}
                      className="flex items-center gap-1.5 rounded-[var(--md-sys-shape-corner)] px-2 py-1.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
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
        </div>
      </div>

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
        className="max-w-2xl"
      >
        <div className="flex flex-col gap-4">
          {/* Tab 切换 */}
          <SegmentedToggle
            options={[
              { value: 'info', label: '房间信息' },
              { value: 'viewers', label: '观众管理' },
              { value: 'permissions', label: '权限说明' },
            ]}
            value={settingsTab}
            onChange={(v) => setSettingsTab(v as SettingsTab)}
          />

          {/* 房间信息 Tab */}
          {settingsTab === 'info' && (
            <div className="flex flex-col gap-3">
              {/* 房间密码 */}
              <div
                className="rounded-[var(--md-sys-shape-corner)] border p-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-tertiary) 18%, transparent))',
                    }}
                  >
                    <Lock
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-primary)' }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-medium">房间密码</Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      PASSWORD
                    </Text>
                  </div>
                </div>
                <div className="mt-2.5 flex flex-col gap-1">
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
              </div>

              {/* 观众上限 */}
              <div
                className="rounded-[var(--md-sys-shape-corner)] border p-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-tertiary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-secondary) 18%, transparent))',
                    }}
                  >
                    <Users
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-tertiary)' }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-medium">观众上限</Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      MAX VIEWERS
                    </Text>
                  </div>
                </div>
                <div className="mt-2.5">
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
              </div>

              {/* 审批开关 */}
              <div
                className="flex items-center justify-between rounded-[var(--md-sys-shape-corner)] border p-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-secondary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-primary) 18%, transparent))',
                    }}
                  >
                    <Shield
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-secondary)' }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-medium">需要房主审批</Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      APPROVAL REQUIRED
                    </Text>
                  </div>
                </div>
                <Switch
                  checked={requireApprovalValue}
                  onChange={(e) =>
                    isHost &&
                    !savingSettings &&
                    setRequireApprovalValue(e.target.checked)
                  }
                  disabled={!isHost || savingSettings}
                />
              </div>

              {/* 保存按钮 */}
              {isHost && (
                <Button
                  variant="primary"
                  block
                  loading={savingSettings}
                  disabled={savingSettings}
                  onClick={handleSaveSettings}
                >
                  保存设置
                </Button>
              )}
            </div>
          )}

          {/* 观众管理 Tab */}
          {settingsTab === 'viewers' && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  在线观众（{viewers.length}）
                </Text>
                <Text type="secondary" className="text-[10px]">
                  {isHost ? '可踢出 / 禁言 / 转交房主' : '仅查看'}
                </Text>
              </div>
              {viewers.length === 0 ? (
                <div
                  className="flex h-32 items-center justify-center rounded-[var(--md-sys-shape-corner)] border"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                    borderColor: 'var(--md-sys-color-outline-variant)',
                  }}
                >
                  <Text type="secondary" className="text-xs">
                    暂无在线观众
                  </Text>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {viewers.map((viewer) =>
                    renderViewerItem(viewer, true)
                  )}
                </div>
              )}
            </div>
          )}

          {/* 权限说明 Tab */}
          {settingsTab === 'permissions' && (
            <div className="flex flex-col gap-3">
              {/* 房主 */}
              <div
                className="rounded-[var(--md-sys-shape-corner)] border p-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-tertiary) 18%, transparent))',
                    }}
                  >
                    <Crown
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-primary)' }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-medium">房主（分享端）</Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      HOST
                    </Text>
                  </div>
                </div>
                <Text
                  type="secondary"
                  className="mt-2 text-[11px] leading-relaxed"
                >
                  创建房间或被转交房主身份的用户。可踢出 /
                  禁言观众、转交房主、修改房间设置与名称、控制播放。
                </Text>
              </div>

              {/* 观众 */}
              <div
                className="rounded-[var(--md-sys-shape-corner)] border p-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-tertiary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-secondary) 18%, transparent))',
                    }}
                  >
                    <UserCheck
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-tertiary)' }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-medium">观众</Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      VIEWER
                    </Text>
                  </div>
                </div>
                <Text
                  type="secondary"
                  className="mt-2 text-[11px] leading-relaxed"
                >
                  加入房间的用户。可观看影片、发送评论与弹幕（未被禁言时）。无法管理房间或其他观众。
                </Text>
              </div>

              {/* 角色权限层级 */}
              <div
                className="rounded-[var(--md-sys-shape-corner)] border p-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-error) 22%, transparent), color-mix(in srgb, var(--md-sys-color-primary) 18%, transparent))',
                    }}
                  >
                    <Shield
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-error)' }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-medium">角色权限层级</Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      ROLE HIERARCHY
                    </Text>
                  </div>
                </div>
                <div className="mt-2.5 flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-[11px]">
                    <RoleBadge role="root" />
                    <Text type="secondary">
                      拥有最高权限，可创建房间、接管任意房间
                    </Text>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <RoleBadge role="admin" />
                    <Text type="secondary">
                      可创建房间、管理自己创建的房间
                    </Text>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <RoleBadge role="user" />
                    <Text type="secondary">普通注册用户，可加入房间观看</Text>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <RoleBadge role="guest" />
                    <Text type="secondary">
                      游客，仅可观看，不能被转交为房主
                    </Text>
                  </div>
                </div>
              </div>
            </div>
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
