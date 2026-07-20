import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users,
  Shield,
  Trash2,
  Power,
  RefreshCw,
  Lock,
  LayoutDashboard,
  LayoutGrid,
  List,
  Settings,
  Download,
  UserCheck,
} from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Text } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Spinner } from '@/components/ui/Spinner'
import { ConfirmModal } from '@/components/ui/Modal'
import { Switch } from '@/components/ui/Switch'
import { InputNumber } from '@/components/ui/InputNumber'
import { Select } from '@/components/ui/Select'
import { AniSubsGithubBrowser } from '@/modules/admin/components/AniSubsGithubBrowser'
import { message } from '@/components/ui/message'
import { useAuthStore } from '@/store/authStore'

interface AdminUser {
  id: number
  username: string
  role: 'root' | 'admin' | 'user' | 'guest'
  status: 'active' | 'pending'
  createdAt: string
}

interface AdminRoom {
  id: number
  roomId: string
  name: string | null
  status: 'active' | 'closed'
  requireApproval: boolean
  maxViewers: number
  hasPassword: boolean
  viewerCount: number
  sharerOnline: boolean
  createdAt: string
  lastAccessedAt: string
}

interface UpdateInfo {
  currentVersion: string
  remoteVersion: string
  hasUpdate: boolean
  commitMessage: string
  commitUrl: string
  publishedAt: string
}

interface AdminSettings {
  autoDeleteInactiveRooms: boolean
  autoDeleteAfterHours: number
  dataSourceConfig?: {
    aniSubsSubscriptions?: string[]
    kazumiRules?: string[]
    rssSources?: Array<{ id: string; name?: string; url: string }>
    thirdPartySources?: Array<{
      id: string
      name?: string
      baseUrl?: string
      endpoints?: Record<string, unknown>
    }>
  }
}

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

export default function AdminPage() {
  const navigate = useNavigate()
  const { accessToken, user } = useAuthStore()
  const [activeTab, setActiveTab] = useState<'users' | 'rooms' | 'settings'>(
    'users'
  )
  const [users, setUsers] = useState<AdminUser[]>([])
  const [rooms, setRooms] = useState<AdminRoom[]>([])
  const [settings, setSettings] = useState<AdminSettings>({
    autoDeleteInactiveRooms: true,
    autoDeleteAfterHours: 24,
  })
  const [loading, setLoading] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [userDelete, setUserDelete] = useState<AdminUser | null>(null)
  const [userApprove, setUserApprove] = useState<AdminUser | null>(null)
  const [roomClose, setRoomClose] = useState<AdminRoom | null>(null)
  const [cleanupConfirm, setCleanupConfirm] = useState(false)
  const [selectedRoomIds, setSelectedRoomIds] = useState<Set<string>>(new Set())
  const [batchDeleteLoading, setBatchDeleteLoading] = useState(false)
  const [deleteAllLoading, setDeleteAllLoading] = useState(false)
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false)
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false)
  const [roomViewMode, setRoomViewMode] = useState<'list' | 'tile'>(() => {
    const saved = localStorage.getItem('admin-rooms-view-mode')
    return saved === 'tile' ? 'tile' : 'list'
  })
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateLoading, setUpdateLoading] = useState(false)
  const [applyLoading, setApplyLoading] = useState(false)

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  const fetchUsers = async () => {
    const res = await fetch(`${API_URL}/api/admin/users`, {
      headers: authHeaders,
    })
    const data = (await res.json()) as {
      success: boolean
      users?: AdminUser[]
      message?: string
    }
    if (data.success && data.users) {
      setUsers(data.users)
    } else {
      message.error(data.message ?? '获取用户列表失败')
    }
  }

  const fetchRooms = async () => {
    const res = await fetch(`${API_URL}/api/admin/rooms`, {
      headers: authHeaders,
    })
    const data = (await res.json()) as {
      success: boolean
      rooms?: AdminRoom[]
      message?: string
    }
    if (data.success && data.rooms) {
      setRooms(data.rooms)
      setSelectedRoomIds(new Set())
    } else {
      message.error(data.message ?? '获取房间列表失败')
    }
  }

  const fetchSettings = async () => {
    const res = await fetch(`${API_URL}/api/admin/settings`, {
      headers: authHeaders,
    })
    const data = (await res.json()) as {
      success: boolean
      settings?: AdminSettings
      message?: string
    }
    if (data.success && data.settings) {
      setSettings(data.settings)
    } else {
      message.error(data.message ?? '获取设置失败')
    }
  }

  const loadData = async () => {
    setLoading(true)
    try {
      if (activeTab === 'users') {
        await fetchUsers()
      } else if (activeTab === 'rooms') {
        await fetchRooms()
      }
    } catch (err) {
      console.error('[AdminPage] load data error:', err)
      message.error('加载数据失败')
    } finally {
      setLoading(false)
    }
  }

  const loadSettings = async () => {
    setSettingsLoading(true)
    try {
      await fetchSettings()
    } catch (err) {
      console.error('[AdminPage] load settings error:', err)
      message.error('加载设置失败')
    } finally {
      setSettingsLoading(false)
    }
  }

  const checkUpdate = async () => {
    setUpdateLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/system/update/check`, {
        headers: authHeaders,
      })
      const data = (await res.json()) as {
        success: boolean
        info?: UpdateInfo
        message?: string
      }
      if (data.success && data.info) {
        setUpdateInfo(data.info)
        if (data.info.hasUpdate) {
          message.info('发现新版本')
        } else {
          message.success('当前已是最新版本')
        }
      } else {
        message.error(data.message ?? '检查更新失败')
      }
    } catch (err) {
      console.error('[AdminPage] check update error:', err)
      message.error('检查更新失败')
    } finally {
      setUpdateLoading(false)
    }
  }

  const handleApplyUpdate = async () => {
    setApplyLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/system/update/apply`, {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as {
        success: boolean
        message?: string
      }
      if (data.success) {
        message.success(data.message ?? '更新已触发')
      } else {
        message.error(data.message ?? '更新失败')
      }
    } catch (err) {
      console.error('[AdminPage] apply update error:', err)
      message.error('更新失败')
    } finally {
      setApplyLoading(false)
    }
  }

  useEffect(() => {
    if (!accessToken) return
    /* eslint-disable react-hooks/set-state-in-effect -- tab 切换时加载对应数据 */
    if (activeTab === 'settings') {
      void loadSettings()
      void checkUpdate()
    } else {
      void loadData()
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, accessToken])

  const handleChangeRole = async (
    targetUser: AdminUser,
    nextRole: AdminUser['role']
  ) => {
    if (targetUser.role === nextRole) return
    try {
      const res = await fetch(
        `${API_URL}/api/admin/users/${targetUser.id}/role`,
        {
          method: 'PATCH',
          headers: authHeaders,
          body: JSON.stringify({ role: nextRole }),
        }
      )
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        const roleLabelMap: Record<AdminUser['role'], string> = {
          root: '超级管理员',
          admin: '管理员',
          user: '普通用户',
          guest: '游客',
        }
        message.success(
          `已将 ${targetUser.username} 设为 ${roleLabelMap[nextRole]}`
        )
        await fetchUsers()
      } else {
        message.error(data.message ?? '操作失败')
      }
    } catch (err) {
      console.error('[AdminPage] change role error:', err)
      message.error('修改角色失败')
    }
  }

  const handleApproveUser = async () => {
    if (!userApprove) return
    try {
      const res = await fetch(
        `${API_URL}/api/admin/users/${userApprove.id}/approve`,
        {
          method: 'POST',
          headers: authHeaders,
        }
      )
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success('已审核通过该用户')
        setUserApprove(null)
        await fetchUsers()
      } else {
        message.error(data.message ?? '审核失败')
      }
    } catch (err) {
      console.error('[AdminPage] approve user error:', err)
      message.error('审核用户失败')
    }
  }

  const handleDeleteUser = async () => {
    if (!userDelete) return
    try {
      const res = await fetch(`${API_URL}/api/admin/users/${userDelete.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success('已删除用户')
        setUserDelete(null)
        await fetchUsers()
      } else {
        message.error(data.message ?? '删除失败')
      }
    } catch (err) {
      console.error('[AdminPage] delete user error:', err)
      message.error('删除用户失败')
    }
  }

  const handleCloseRoom = async () => {
    if (!roomClose) return
    try {
      const res = await fetch(
        `${API_URL}/api/admin/rooms/${roomClose.roomId}`,
        {
          method: 'DELETE',
          headers: authHeaders,
        }
      )
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success('已关闭房间')
        setRoomClose(null)
        await fetchRooms()
      } else {
        message.error(data.message ?? '关闭失败')
      }
    } catch (err) {
      console.error('[AdminPage] close room error:', err)
      message.error('关闭房间失败')
    }
  }

  const handleBatchDeleteRooms = async () => {
    if (selectedRoomIds.size === 0) return
    setBatchDeleteLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/admin/rooms/batch-delete`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ roomIds: Array.from(selectedRoomIds) }),
      })
      const data = (await res.json()) as {
        success: boolean
        count?: number
        message?: string
      }
      if (data.success) {
        message.success(`已删除 ${data.count ?? selectedRoomIds.size} 个房间`)
        setSelectedRoomIds(new Set())
        setBatchDeleteConfirm(false)
        await fetchRooms()
      } else {
        message.error(data.message ?? '批量删除失败')
      }
    } catch (err) {
      console.error('[AdminPage] batch delete rooms error:', err)
      message.error('批量删除房间失败')
    } finally {
      setBatchDeleteLoading(false)
    }
  }

  const handleDeleteAllRooms = async () => {
    setDeleteAllLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/admin/rooms/delete-all`, {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as {
        success: boolean
        count?: number
        message?: string
      }
      if (data.success) {
        message.success(`已删除 ${data.count ?? 0} 个房间`)
        setSelectedRoomIds(new Set())
        setDeleteAllConfirm(false)
        await fetchRooms()
      } else {
        message.error(data.message ?? '删除所有房间失败')
      }
    } catch (err) {
      console.error('[AdminPage] delete all rooms error:', err)
      message.error('删除所有房间失败')
    } finally {
      setDeleteAllLoading(false)
    }
  }

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    try {
      const res = await fetch(`${API_URL}/api/admin/settings`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          autoDeleteInactiveRooms: settings.autoDeleteInactiveRooms,
          autoDeleteAfterHours: settings.autoDeleteAfterHours,
          dataSourceConfig: settings.dataSourceConfig,
        }),
      })
      const data = (await res.json()) as {
        success: boolean
        settings?: AdminSettings
        message?: string
      }
      if (data.success) {
        message.success('设置已保存')
        if (data.settings) {
          setSettings(data.settings)
        }
      } else {
        message.error(data.message ?? '保存失败')
      }
    } catch (err) {
      console.error('[AdminPage] save settings error:', err)
      message.error('保存设置失败')
    } finally {
      setSavingSettings(false)
    }
  }

  const handleCleanupUnusedRooms = async () => {
    setCleanupLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/admin/rooms/cleanup-unused`, {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as {
        success: boolean
        count?: number
        message?: string
      }
      if (data.success) {
        if (data.count && data.count > 0) {
          message.success(`已清理 ${data.count} 个无人使用的房间`)
        } else {
          message.info('暂无可清理的房间')
        }
        setCleanupConfirm(false)
        await fetchRooms()
      } else {
        message.error(data.message ?? '清理失败')
      }
    } catch (err) {
      console.error('[AdminPage] cleanup unused rooms error:', err)
      message.error('清理房间失败')
    } finally {
      setCleanupLoading(false)
    }
  }

  const isSelf = (targetUser: AdminUser) => user?.id === String(targetUser.id)

  const formatDate = (iso: string) => new Date(iso).toLocaleString('zh-CN')

  return (
    <div className="flex-1 p-4 sm:p-6">
      <Card className="relative mx-auto w-full max-w-6xl">
        <PageBackButton to="/" />

        <div className="mb-6 pt-8 text-center">
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
          >
            <Shield className="h-6 w-6" />
          </div>
          <Title level={3} className="m-0">
            权限管理
          </Title>
          <Text type="secondary">管理用户角色与房间状态</Text>
        </div>

        <div className="mb-6 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => setActiveTab('users')}
            className="relative flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-4 py-2 text-sm font-medium transition-all"
            style={{
              backgroundColor:
                activeTab === 'users'
                  ? 'var(--md-sys-color-primary-container)'
                  : 'var(--md-sys-color-surface-container-high)',
              color:
                activeTab === 'users'
                  ? 'var(--md-sys-color-on-primary-container)'
                  : 'var(--md-sys-color-on-surface)',
              border: '1px solid var(--md-sys-color-outline)',
            }}
          >
            <Users className="h-4 w-4" />
            用户管理
          </button>
          <button
            onClick={() => setActiveTab('rooms')}
            className="relative flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-4 py-2 text-sm font-medium transition-all"
            style={{
              backgroundColor:
                activeTab === 'rooms'
                  ? 'var(--md-sys-color-primary-container)'
                  : 'var(--md-sys-color-surface-container-high)',
              color:
                activeTab === 'rooms'
                  ? 'var(--md-sys-color-on-primary-container)'
                  : 'var(--md-sys-color-on-surface)',
              border: '1px solid var(--md-sys-color-outline)',
            }}
          >
            <LayoutDashboard className="h-4 w-4" />
            房间管理
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className="relative flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-4 py-2 text-sm font-medium transition-all"
            style={{
              backgroundColor:
                activeTab === 'settings'
                  ? 'var(--md-sys-color-primary-container)'
                  : 'var(--md-sys-color-surface-container-high)',
              color:
                activeTab === 'settings'
                  ? 'var(--md-sys-color-on-primary-container)'
                  : 'var(--md-sys-color-on-surface)',
              border: '1px solid var(--md-sys-color-outline)',
            }}
          >
            <Settings className="h-4 w-4" />
            基础设置
          </button>
        </div>

        <Space justify="between" align="center" className="mb-4">
          <Text type="secondary">
            {activeTab === 'users'
              ? `共 ${users.length} 位用户`
              : activeTab === 'rooms'
                ? `共 ${rooms.length} 个房间`
                : ''}
          </Text>
          {activeTab !== 'settings' && (
            <Space>
              {activeTab === 'rooms' && (
                <>
                  <div
                    className="inline-flex rounded-[var(--md-sys-shape-corner)] border p-0.5"
                    style={{ borderColor: 'var(--md-sys-color-outline)' }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setRoomViewMode('list')
                        localStorage.setItem('admin-rooms-view-mode', 'list')
                      }}
                      className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1.5 text-sm font-medium transition-all"
                      style={{
                        backgroundColor:
                          roomViewMode === 'list'
                            ? 'var(--md-sys-color-primary-container)'
                            : 'transparent',
                        color:
                          roomViewMode === 'list'
                            ? 'var(--md-sys-color-on-primary-container)'
                            : 'var(--md-sys-color-on-surface)',
                      }}
                      aria-label="列表视图"
                      title="列表视图"
                    >
                      <List className="h-4 w-4" />
                      <span className="hidden sm:inline">列表</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRoomViewMode('tile')
                        localStorage.setItem('admin-rooms-view-mode', 'tile')
                      }}
                      className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1.5 text-sm font-medium transition-all"
                      style={{
                        backgroundColor:
                          roomViewMode === 'tile'
                            ? 'var(--md-sys-color-primary-container)'
                            : 'transparent',
                        color:
                          roomViewMode === 'tile'
                            ? 'var(--md-sys-color-on-primary-container)'
                            : 'var(--md-sys-color-on-surface)',
                      }}
                      aria-label="平铺视图"
                      title="平铺视图"
                    >
                      <LayoutGrid className="h-4 w-4" />
                      <span className="hidden sm:inline">平铺</span>
                    </button>
                  </div>
                  {selectedRoomIds.size > 0 && (
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setBatchDeleteConfirm(true)}
                      disabled={batchDeleteLoading}
                    >
                      删除已选 ({selectedRoomIds.size})
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setDeleteAllConfirm(true)}
                    disabled={deleteAllLoading}
                  >
                    删除所有房间
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setCleanupConfirm(true)}
                    disabled={cleanupLoading}
                  >
                    一键移除无人使用的房间
                  </Button>
                </>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={loadData}
                disabled={loading}
              >
                刷新
              </Button>
            </Space>
          )}
        </Space>

        {loading ? (
          <div className="py-12">
            <Spinner tip="加载中..." size={32} />
          </div>
        ) : activeTab === 'users' ? (
          <div className="grid gap-3">
            {users.length === 0 ? (
              <div className="py-12 text-center">
                <Text type="secondary">暂无用户</Text>
              </div>
            ) : (
              users.map((u) => {
                const isRootUser = u.role === 'root' || u.username === 'root'
                const roleLabelMap: Record<AdminUser['role'], string> = {
                  root: '超级管理员',
                  admin: '管理员',
                  user: '普通用户',
                  guest: '游客',
                }
                const roleColorMap: Record<
                  AdminUser['role'],
                  | 'default'
                  | 'primary'
                  | 'success'
                  | 'warning'
                  | 'danger'
                  | 'cyan'
                  | 'purple'
                > = {
                  root: 'primary',
                  admin: 'cyan',
                  user: 'default',
                  guest: 'default',
                }
                return (
                  <div
                    key={u.id}
                    className="flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between"
                    style={{
                      borderColor: 'var(--md-sys-color-outline)',
                      backgroundColor:
                        'var(--md-sys-color-surface-container-high)',
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-[var(--md-sys-color-on-surface)]">
                          {u.username}
                        </span>
                        <Tag color={roleColorMap[u.role]}>
                          {u.role === 'root' || u.role === 'admin' ? (
                            <Shield className="mr-1 inline h-3 w-3" />
                          ) : null}
                          {roleLabelMap[u.role]}
                        </Tag>
                        {u.status === 'pending' ? (
                          <Tag color="warning">待审核</Tag>
                        ) : (
                          <Tag color="success">正常</Tag>
                        )}
                      </div>
                      <Text type="secondary" className="text-xs">
                        创建于 {formatDate(u.createdAt)}
                      </Text>
                    </div>
                    <Space className="shrink-0">
                      {u.status === 'pending' && (
                        <Button
                          variant="primary"
                          size="sm"
                          icon={<UserCheck className="h-4 w-4" />}
                          onClick={() => setUserApprove(u)}
                          disabled={isRootUser}
                        >
                          审核
                        </Button>
                      )}
                      {isRootUser ? (
                        <div
                          className="flex w-32 items-center justify-center rounded-[var(--md-sys-shape-corner)] border px-3 py-2 text-sm"
                          style={{
                            borderColor: 'var(--md-sys-color-outline)',
                            backgroundColor:
                              'var(--md-sys-color-surface-container-highest)',
                            color: 'var(--md-sys-color-on-surface-variant)',
                          }}
                        >
                          超级管理员
                        </div>
                      ) : (
                        <Select
                          className="w-32"
                          value={u.role}
                          disabled={isSelf(u)}
                          options={[
                            { label: '管理员', value: 'admin' },
                            { label: '普通用户', value: 'user' },
                          ]}
                          onChange={(value) =>
                            handleChangeRole(u, value as AdminUser['role'])
                          }
                        />
                      )}
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 className="h-4 w-4" />}
                        onClick={() => setUserDelete(u)}
                        disabled={isRootUser || isSelf(u)}
                      >
                        删除
                      </Button>
                    </Space>
                  </div>
                )
              })
            )}
          </div>
        ) : activeTab === 'rooms' ? (
          <div
            className={
              roomViewMode === 'tile'
                ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'
                : 'grid gap-3'
            }
          >
            {rooms.length === 0 ? (
              <div className="col-span-full py-12 text-center">
                <Text type="secondary">暂无房间</Text>
              </div>
            ) : (
              <>
                <div
                  className={
                    roomViewMode === 'tile'
                      ? 'col-span-full flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] border px-4 py-2'
                      : 'flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] border px-4 py-2'
                  }
                  style={{
                    borderColor: 'var(--md-sys-color-outline)',
                    backgroundColor:
                      'var(--md-sys-color-surface-container-low)',
                  }}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 cursor-pointer accent-[var(--md-sys-color-primary)]"
                    checked={
                      rooms.length > 0 &&
                      rooms.every((r) => selectedRoomIds.has(r.roomId))
                    }
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedRoomIds(new Set(rooms.map((r) => r.roomId)))
                      } else {
                        setSelectedRoomIds(new Set())
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
                    className={
                      roomViewMode === 'tile'
                        ? 'flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors cursor-pointer'
                        : 'flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between cursor-pointer'
                    }
                    style={{
                      borderColor: selectedRoomIds.has(room.roomId)
                        ? 'var(--md-sys-color-primary)'
                        : 'var(--md-sys-color-outline)',
                      backgroundColor: selectedRoomIds.has(room.roomId)
                        ? 'var(--md-sys-color-primary-container)'
                        : 'var(--md-sys-color-surface-container-high)',
                    }}
                    onClick={() => {
                      if (room.status === 'active') {
                        navigate(`/room/${room.roomId}?role=host`)
                      } else {
                        message.warning('房间已关闭，无法进入', {
                          duration: 5000,
                        })
                      }
                    }}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 cursor-pointer accent-[var(--md-sys-color-primary)]"
                        checked={selectedRoomIds.has(room.roomId)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          setSelectedRoomIds((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) {
                              next.add(room.roomId)
                            } else {
                              next.delete(room.roomId)
                            }
                            return next
                          })
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
                          <Text type="secondary" className="text-xs">
                            {room.roomId}
                          </Text>
                          {room.status === 'active' ? (
                            <Tag color="success">进行中</Tag>
                          ) : (
                            <Tag color="default">已关闭</Tag>
                          )}
                          {room.requireApproval ? (
                            <Tag color="warning">需确认</Tag>
                          ) : (
                            <Tag color="cyan">直接加入</Tag>
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
                          className={
                            roomViewMode === 'tile'
                              ? 'mt-2 text-xs leading-relaxed'
                              : 'text-xs'
                          }
                        >
                          观众 {room.viewerCount} / {room.maxViewers}
                          {roomViewMode === 'tile' ? <br /> : ' · '}分享端
                          {room.sharerOnline ? '在线' : '离线'}
                          {roomViewMode === 'tile' ? <br /> : ' · '}创建于{' '}
                          {formatDate(room.createdAt)}
                          {roomViewMode === 'tile' ? (
                            <br />
                          ) : (
                            ' · '
                          )}最后访问 {formatDate(room.lastAccessedAt)}
                        </Text>
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      className={
                        roomViewMode === 'tile' ? 'mt-auto w-full' : ''
                      }
                      icon={<Power className="h-4 w-4" />}
                      onClick={(e) => {
                        e.stopPropagation()
                        setRoomClose(room)
                      }}
                      disabled={room.status !== 'active'}
                    >
                      关闭房间
                    </Button>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <div
            className="rounded-[var(--md-sys-shape-corner)] border p-4"
            style={{
              borderColor: 'var(--md-sys-color-outline)',
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
            }}
          >
            {settingsLoading ? (
              <div className="py-12">
                <Spinner tip="加载中..." size={32} />
              </div>
            ) : (
              <>
                <Title level={5} className="mb-4">
                  房间自动清理设置
                </Title>
                <div className="mb-4">
                  <Switch
                    label="自动删除无人访问的房间"
                    checked={settings.autoDeleteInactiveRooms}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        autoDeleteInactiveRooms: e.target.checked,
                      }))
                    }
                  />
                </div>
                <div className="mb-6 max-w-xs">
                  <InputNumber
                    label="超过小时数未访问则自动删除"
                    min={1}
                    max={720}
                    step={1}
                    value={settings.autoDeleteAfterHours}
                    disabled={!settings.autoDeleteInactiveRooms}
                    onChange={(value) =>
                      setSettings((prev) => ({
                        ...prev,
                        autoDeleteAfterHours: value ?? 1,
                      }))
                    }
                  />
                </div>

                <Title level={5} className="mb-4 mt-6">
                  番剧数据源订阅
                </Title>
                <div className="mb-4">
                  <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
                    ani-subs 订阅地址（每行一个，留空使用默认）
                  </label>
                  <textarea
                    rows={4}
                    className="w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
                    placeholder="https://sub.creamycake.org/v1/css1.json\nhttps://sub.creamycake.org/v1/bt1.json"
                    value={(
                      settings.dataSourceConfig?.aniSubsSubscriptions || []
                    ).join('\n')}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        dataSourceConfig: {
                          ...prev.dataSourceConfig,
                          aniSubsSubscriptions: e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        },
                      }))
                    }
                  />
                  <p className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    修改后保存即可自动加载 ani-subs 的 web-selector 与 RSS 源
                  </p>
                </div>

                <div className="mb-6">
                  <AniSubsGithubBrowser
                    existingUrls={
                      settings.dataSourceConfig?.aniSubsSubscriptions || []
                    }
                    onAddUrls={(urls) =>
                      setSettings((prev) => ({
                        ...prev,
                        dataSourceConfig: {
                          ...prev.dataSourceConfig,
                          aniSubsSubscriptions: [
                            ...(prev.dataSourceConfig?.aniSubsSubscriptions ||
                              []),
                            ...urls,
                          ],
                        },
                      }))
                    }
                  />
                </div>

                <Title level={5} className="mb-4 mt-6">
                  Kazumi 规则源
                </Title>
                <div className="mb-4">
                  <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
                    Kazumi 规则地址（每行一个，留空使用默认）
                  </label>
                  <textarea
                    rows={4}
                    className="w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
                    placeholder="https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/DM84.json"
                    value={(settings.dataSourceConfig?.kazumiRules || []).join(
                      '\n'
                    )}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        dataSourceConfig: {
                          ...prev.dataSourceConfig,
                          kazumiRules: e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        },
                      }))
                    }
                  />
                  <p className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    修改后保存即可自动加载 Kazumi XPath 规则源；规则中
                    useWebview 的源可能无法直接解析播放
                  </p>
                </div>

                <div className="mb-6">
                  <AniSubsGithubBrowser
                    repoUrl="https://github.com/Predidit/Kazumi"
                    defaultPath="assets/plugins"
                    existingUrls={settings.dataSourceConfig?.kazumiRules || []}
                    onAddUrls={(urls) =>
                      setSettings((prev) => ({
                        ...prev,
                        dataSourceConfig: {
                          ...prev.dataSourceConfig,
                          kazumiRules: [
                            ...(prev.dataSourceConfig?.kazumiRules || []),
                            ...urls,
                          ],
                        },
                      }))
                    }
                  />
                </div>

                <Title level={5} className="mb-4 mt-6">
                  版本更新
                </Title>
                <div
                  className="mb-6 rounded-[var(--md-sys-shape-corner)] border p-4"
                  style={{
                    borderColor: 'var(--md-sys-color-outline)',
                    backgroundColor: 'var(--md-sys-color-surface-container)',
                  }}
                >
                  {updateLoading ? (
                    <div className="py-4">
                      <Spinner tip="检查更新中..." size={24} />
                    </div>
                  ) : updateInfo ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Text className="text-sm">
                          当前版本：
                          <span className="font-mono text-[var(--md-sys-color-on-surface-variant)]">
                            {updateInfo.currentVersion.slice(0, 7)}
                          </span>
                        </Text>
                        <Text className="text-sm">
                          远程版本：
                          <span className="font-mono text-[var(--md-sys-color-on-surface-variant)]">
                            {updateInfo.remoteVersion.slice(0, 7)}
                          </span>
                        </Text>
                      </div>
                      {updateInfo.publishedAt && (
                        <Text type="secondary" className="text-xs">
                          提交时间：
                          {new Date(updateInfo.publishedAt).toLocaleString(
                            'zh-CN'
                          )}
                        </Text>
                      )}
                      {updateInfo.commitMessage && (
                        <Text className="text-xs leading-relaxed">
                          {updateInfo.commitMessage.split('\n')[0]}
                        </Text>
                      )}
                      <div className="flex items-center gap-2 pt-2">
                        <Button
                          variant="primary"
                          size="sm"
                          icon={<Download className="h-4 w-4" />}
                          onClick={handleApplyUpdate}
                          loading={applyLoading}
                          disabled={applyLoading || !updateInfo.hasUpdate}
                        >
                          {updateInfo.hasUpdate ? '一键更新' : '已是最新'}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={checkUpdate}
                          disabled={updateLoading}
                        >
                          重新检测
                        </Button>
                        {updateInfo.commitUrl && (
                          <a
                            href={updateInfo.commitUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-[var(--md-sys-color-primary)] hover:underline"
                          >
                            查看提交
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between py-2">
                      <Text type="secondary" className="text-sm">
                        未获取版本信息
                      </Text>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={checkUpdate}
                        disabled={updateLoading}
                      >
                        检查更新
                      </Button>
                    </div>
                  )}
                </div>

                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveSettings}
                  loading={savingSettings}
                  disabled={savingSettings}
                >
                  保存
                </Button>
              </>
            )}
          </div>
        )}
      </Card>

      <ConfirmModal
        open={!!userDelete}
        onClose={() => setUserDelete(null)}
        title="删除用户"
        onOk={handleDeleteUser}
        onCancel={() => setUserDelete(null)}
        okText="删除"
        cancelText="取消"
      >
        确定要删除用户 <strong>{userDelete?.username}</strong>{' '}
        吗？此操作不可撤销。
      </ConfirmModal>

      <ConfirmModal
        open={!!userApprove}
        onClose={() => setUserApprove(null)}
        title="审核用户"
        onOk={handleApproveUser}
        onCancel={() => setUserApprove(null)}
        okText="通过审核"
        cancelText="取消"
      >
        确定通过 <strong>{userApprove?.username}</strong>{' '}
        的注册申请吗？审核后该用户将变为普通用户并可正常使用。
      </ConfirmModal>

      <ConfirmModal
        open={!!roomClose}
        onClose={() => setRoomClose(null)}
        title="强制关闭房间"
        onOk={handleCloseRoom}
        onCancel={() => setRoomClose(null)}
        okText="关闭"
        cancelText="取消"
      >
        确定要强制关闭房间 <strong>{roomClose?.roomId}</strong>{' '}
        吗？所有连接将断开。
      </ConfirmModal>

      <ConfirmModal
        open={cleanupConfirm}
        onClose={() => setCleanupConfirm(false)}
        title="移除无人使用的房间"
        onOk={handleCleanupUnusedRooms}
        onCancel={() => setCleanupConfirm(false)}
        okText="确认"
        cancelText="取消"
      >
        确定要移除所有当前无人使用的房间吗？此操作不可撤销。
      </ConfirmModal>

      <ConfirmModal
        open={batchDeleteConfirm}
        onClose={() => setBatchDeleteConfirm(false)}
        title="批量删除房间"
        onOk={handleBatchDeleteRooms}
        onCancel={() => setBatchDeleteConfirm(false)}
        okText="删除"
        cancelText="取消"
        confirmLoading={batchDeleteLoading}
      >
        确定要删除选中的 <strong>{selectedRoomIds.size}</strong>{' '}
        个房间吗？此操作不可撤销。
      </ConfirmModal>

      <ConfirmModal
        open={deleteAllConfirm}
        onClose={() => setDeleteAllConfirm(false)}
        title="删除所有房间"
        onOk={handleDeleteAllRooms}
        onCancel={() => setDeleteAllConfirm(false)}
        okText="全部删除"
        cancelText="取消"
        confirmLoading={deleteAllLoading}
      >
        确定要删除所有房间吗？此操作不可撤销，所有房间数据将被清除。
      </ConfirmModal>
    </div>
  )
}
