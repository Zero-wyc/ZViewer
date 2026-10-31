import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users,
  Shield,
  Trash2,
  RefreshCw,
  LayoutDashboard,
  LayoutGrid,
  List,
  Settings,
} from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title, Text } from '@/components/ui/Typography'
import { Spinner } from '@/components/ui/Spinner'
import { ConfirmModal } from '@/components/ui/Modal'
import { userRoleLabel } from '@/lib/roles'
import { t } from '@/i18n'
import { message } from '@/components/ui/message'
import { useHideBodyScrollbar } from '@/hooks/useHideBodyScrollbar'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { apiFetch } from '@/lib/api'
import type { AdminSettings, AdminRoom, AdminUser } from './admin/shared'
import { useSystemUpdate } from './admin/useSystemUpdate'
import { Trans } from 'react-i18next'
import { UsersTab } from './admin/UsersTab'
import { RoomsTab } from './admin/RoomsTab'
import { SettingsTab } from './admin/SettingsTab'

export default function AdminPage() {
  useHideBodyScrollbar()
  const navigate = useNavigate()
  const { isAuthenticated, user } = useAuthStore()
  const {
    invalidate: invalidateSystemSettings,
    // 重命名为避免与下方本地 fetchSettings（拉管理员完整设置）混淆：
    // 这是 systemSettingsStore 的公开设置拉取，供 RoomPanel/WatchPage
    // 等消费方读取 betaFeaturesEnabled
    fetchSettings: fetchPublicSettings,
  } = useSystemSettingsStore()
  const [activeTab, setActiveTab] = useState<'users' | 'rooms' | 'settings'>(
    'users'
  )
  const [users, setUsers] = useState<AdminUser[]>([])
  const [rooms, setRooms] = useState<AdminRoom[]>([])
  const [settings, setSettings] = useState<AdminSettings>({
    autoDeleteInactiveRooms: true,
    autoDeleteAfterHours: 24,
    roomDefaultMusicVolume: 50,
    registrationMode: 'approval',
    roomCreationMode: 'admin-only',
    roomPermissionMatrix: null,
    betaFeaturesEnabled: false,
    dashDisabled: false,
    bilibiliDefaultParseMode: 'mp4',
    bilibiliPgcDefaultMode: 'mp4',
    playsvideoEnabled: true,
    cdnAccelerate: false,
    cdnProxyUrl: 'https://gh-proxy.com',
    updateUseGitCode: true,
    roomMultiInstanceLogin: false,
    livekitExternalUrl: '',
    announceAutoPopupOnUpdate: true,
    showVoiceChatButton: true,
    showTrafficPanel: true,
  })
  const [loading, setLoading] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [cmsInspectUrl, setCmsInspectUrl] = useState('')
  const [cmsInspecting, setCmsInspecting] = useState(false)
  /** 最近一次已持久化的 cmsSources JSON（避免失焦保存重复 PUT） */
  const cmsSavedJsonRef = useRef<string | null>(null)
  const [editingMusicVolume, setEditingMusicVolume] = useState(false)
  const [musicVolumeDraft, setMusicVolumeDraft] = useState('50')
  const commitMusicVolume = () => {
    if (/^\d{1,3}$/.test(musicVolumeDraft)) {
      const value = Number(musicVolumeDraft)
      if (value <= 100) {
        setSettings((prev) => ({ ...prev, roomDefaultMusicVolume: value }))
        setEditingMusicVolume(false)
        return
      }
    }
    message.error(t('请输入 0～100 的整数'))
  }
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
  const authHeaders = {
    'Content-Type': 'application/json',
  }
  // 系统更新状态与动作（含 SSE 进度解析，原样抽出于 useSystemUpdate hook）
  const update = useSystemUpdate({ authHeaders })
  const { checkUpdate } = update

  const fetchUsers = async () => {
    const res = await apiFetch('/api/admin/users', {
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
      message.error(data.message ?? t('获取用户列表失败'))
    }
  }

  const fetchRooms = async () => {
    const res = await apiFetch('/api/admin/rooms', {
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
      message.error(data.message ?? t('获取房间列表失败'))
    }
  }

  const fetchSettings = async () => {
    const res = await apiFetch('/api/admin/settings', {
      headers: authHeaders,
    })
    const data = (await res.json()) as {
      success: boolean
      settings?: AdminSettings
      message?: string
    }
    if (data.success && data.settings) {
      setSettings(data.settings)
      // 同步更新 systemSettingsStore，避免 HomePage 等公开页面拿到过期值
      invalidateSystemSettings()
    } else {
      message.error(data.message ?? t('获取设置失败'))
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
      message.error(t('加载数据失败'))
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
      message.error(t('加载设置失败'))
    } finally {
      setSettingsLoading(false)
    }
  }

  useEffect(() => {
    if (!isAuthenticated) return
    /* eslint-disable react-hooks/set-state-in-effect -- tab 切换时加载对应数据 */
    if (activeTab === 'settings') {
      void loadSettings()
      void checkUpdate()
    } else if (activeTab === 'users') {
      void loadData()
      void loadSettings()
    } else {
      void loadData()
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isAuthenticated])

  const handleChangeRole = async (
    targetUser: AdminUser,
    nextRole: AdminUser['role']
  ) => {
    if (targetUser.role === nextRole) return
    try {
      const res = await apiFetch(`/api/admin/users/${targetUser.id}/role`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ role: nextRole }),
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success(
          t('已将 {{username}} 设为 {{role}}', {
            username: targetUser.username,
            role: userRoleLabel(nextRole),
          })
        )
        await fetchUsers()
      } else {
        message.error(data.message ?? t('操作失败'))
      }
    } catch (err) {
      console.error('[AdminPage] change role error:', err)
      message.error(t('修改角色失败'))
    }
  }

  const handleApproveUser = async () => {
    if (!userApprove) return
    try {
      const res = await apiFetch(`/api/admin/users/${userApprove.id}/approve`, {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success(t('已审核通过该用户'))
        setUserApprove(null)
        await fetchUsers()
      } else {
        message.error(data.message ?? t('审核失败'))
      }
    } catch (err) {
      console.error('[AdminPage] approve user error:', err)
      message.error(t('审核用户失败'))
    }
  }

  const handleDeleteUser = async () => {
    if (!userDelete) return
    try {
      const res = await apiFetch(`/api/admin/users/${userDelete.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success(t('已删除用户'))
        setUserDelete(null)
        await fetchUsers()
      } else {
        message.error(data.message ?? t('删除失败'))
      }
    } catch (err) {
      console.error('[AdminPage] delete user error:', err)
      message.error(t('删除用户失败'))
    }
  }

  const handleCloseRoom = async () => {
    if (!roomClose) return
    try {
      const res = await apiFetch(`/api/admin/rooms/${roomClose.roomId}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success(t('已关闭房间'))
        setRoomClose(null)
        await fetchRooms()
      } else {
        message.error(data.message ?? t('关闭失败'))
      }
    } catch (err) {
      console.error('[AdminPage] close room error:', err)
      message.error(t('关闭房间失败'))
    }
  }

  const [roomReopeningId, setRoomReopeningId] = useState<string | null>(null)
  const handleReopenRoom = async (roomId: string) => {
    setRoomReopeningId(roomId)
    try {
      const res = await apiFetch(`/api/admin/rooms/${roomId}/reopen`, {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success(t('房间已重新开启'))
        await fetchRooms()
      } else {
        message.error(data.message ?? t('重新开启失败'))
      }
    } catch (err) {
      console.error('[AdminPage] reopen room error:', err)
      message.error(t('重新开启房间失败'))
    } finally {
      setRoomReopeningId(null)
    }
  }

  const handleBatchDeleteRooms = async () => {
    if (selectedRoomIds.size === 0) return
    setBatchDeleteLoading(true)
    try {
      const res = await apiFetch('/api/admin/rooms/batch-delete', {
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
        message.success(
          t('已删除 {{value}} 个房间', {
            value: data.count ?? selectedRoomIds.size,
          })
        )
        setSelectedRoomIds(new Set())
        setBatchDeleteConfirm(false)
        await fetchRooms()
      } else {
        message.error(data.message ?? t('批量删除失败'))
      }
    } catch (err) {
      console.error('[AdminPage] batch delete rooms error:', err)
      message.error(t('批量删除房间失败'))
    } finally {
      setBatchDeleteLoading(false)
    }
  }

  const handleDeleteAllRooms = async () => {
    setDeleteAllLoading(true)
    try {
      const res = await apiFetch('/api/admin/rooms/delete-all', {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as {
        success: boolean
        count?: number
        message?: string
      }
      if (data.success) {
        message.success(
          t('已删除 {{value}} 个房间', { value: data.count ?? 0 })
        )
        setSelectedRoomIds(new Set())
        setDeleteAllConfirm(false)
        await fetchRooms()
      } else {
        message.error(data.message ?? t('删除所有房间失败'))
      }
    } catch (err) {
      console.error('[AdminPage] delete all rooms error:', err)
      message.error(t('删除所有房间失败'))
    } finally {
      setDeleteAllLoading(false)
    }
  }

  /**
   * 仅持久化 dataSourceConfig（CMS 采集源等数据源配置的独立保存通道）。
   * payload 必须携带后端硬校验的 autoDelete* 字段，其余字段传 undefined
   * 即可跳过（后端按 !== undefined 条件更新），不会提交页面上其他未保存的编辑。
   */
  const persistDataSourceConfig = useCallback(
    async (nextConfig: NonNullable<AdminSettings['dataSourceConfig']>) => {
      const res = await apiFetch('/api/admin/settings', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          autoDeleteInactiveRooms: settings.autoDeleteInactiveRooms,
          autoDeleteAfterHours: settings.autoDeleteAfterHours,
          dataSourceConfig: nextConfig,
        }),
      })
      const data = (await res.json()) as {
        success: boolean
        settings?: AdminSettings
        message?: string
      }
      if (!data.success) {
        throw new Error(data.message ?? t('保存失败'))
      }
      if (data.settings) {
        setSettings(data.settings)
      }
      cmsSavedJsonRef.current = JSON.stringify(
        data.settings?.dataSourceConfig ?? nextConfig
      )
      invalidateSystemSettings()
      void fetchPublicSettings()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      authHeaders,
      settings.autoDeleteInactiveRooms,
      settings.autoDeleteAfterHours,
    ]
  )

  /** textarea 手动编辑 cmsSources 失焦时自动保存（有变更才 PUT） */
  const handleCmsSourcesBlur = async () => {
    const cfg = settings.dataSourceConfig
    if (!cfg) return
    const json = JSON.stringify(cfg)
    if (json === cmsSavedJsonRef.current) return
    try {
      await persistDataSourceConfig(cfg)
      message.success(t('采集源配置已保存并生效'))
    } catch (err) {
      console.error('[AdminPage] save cms sources error:', err)
      message.error(
        err instanceof Error ? err.message : t('采集源配置保存失败')
      )
    }
  }

  const handleInspectCmsSource = async () => {
    const url = cmsInspectUrl.trim()
    if (!url) {
      message.error(t('请输入 TVBox 配置接口地址'))
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      message.error(t('配置地址必须是 http(s) URL'))
      return
    }
    setCmsInspecting(true)
    try {
      const res = await apiFetch(
        `/api/stream/cms/inspect?url=${encodeURIComponent(url)}&refresh=1`,
        { headers: authHeaders }
      )
      const data = (await res.json()) as {
        success: boolean
        sites?: Array<{ key: string; name: string }>
        message?: string
      }
      if (data.success && data.sites) {
        if (data.sites.length === 0) {
          message.warning(
            t('配置拉取成功，但没有识别到 CMS 采集源（type 1），未保存')
          )
        } else {
          // 检测成功后立即合并并持久化（去重）——不依赖「保存设置」按钮，
          // 否则配置只存在于本地 state，刷新/漏点保存即丢失导致搜索空结果
          const existing = settings.dataSourceConfig?.cmsSources || []
          const nextConfig = {
            ...settings.dataSourceConfig,
            cmsSources: existing.includes(url) ? existing : [...existing, url],
          }
          await persistDataSourceConfig(nextConfig)
          const preview = data.sites
            .slice(0, 5)
            .map((s) => s.name)
            .join('、')
          message.success(
            t(
              '识别到 {{length}} 个 CMS 采集源：{{preview}}{{value}}（已保存，即刻生效）',
              {
                length: data.sites.length,
                preview,
                value: data.sites.length > 5 ? t(' 等') : '',
              }
            )
          )
          setCmsInspectUrl('')
        }
      } else {
        message.error(data.message ?? t('拉取配置失败'))
      }
    } catch (err) {
      console.error('[AdminPage] inspect cms source error:', err)
      message.error(err instanceof Error ? err.message : t('拉取配置失败'))
    } finally {
      setCmsInspecting(false)
    }
  }

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    try {
      // 仅在 dataSourceConfig 有值时传递，避免 null 覆盖已有配置；
      // dataSourceConfig 的编辑入口在"数据源设置"卡片，不在管理页面。
      const payload: Record<string, unknown> = {
        autoDeleteInactiveRooms: settings.autoDeleteInactiveRooms,
        autoDeleteAfterHours: settings.autoDeleteAfterHours,
        roomDefaultMusicVolume: settings.roomDefaultMusicVolume,
        registrationMode: settings.registrationMode,
        roomCreationMode: settings.roomCreationMode,
        betaFeaturesEnabled: settings.betaFeaturesEnabled,
        dashDisabled: settings.dashDisabled,
        bilibiliDefaultParseMode: settings.bilibiliDefaultParseMode,
        bilibiliPgcDefaultMode: settings.bilibiliPgcDefaultMode,
        playsvideoEnabled: settings.playsvideoEnabled,
        cdnAccelerate: settings.cdnAccelerate,
        cdnProxyUrl: settings.cdnProxyUrl,
        updateUseGitCode: settings.updateUseGitCode,
        roomMultiInstanceLogin: settings.roomMultiInstanceLogin,
        livekitExternalUrl: settings.livekitExternalUrl,
        announceAutoPopupOnUpdate: settings.announceAutoPopupOnUpdate,
        // 房间悬浮入口显隐（后端落 config/ui-prefs.json，不写库）
        showVoiceChatButton: settings.showVoiceChatButton,
        showTrafficPanel: settings.showTrafficPanel,
      }
      if (settings.dataSourceConfig) {
        payload.dataSourceConfig = settings.dataSourceConfig
      }
      // 权限矩阵：始终传递（编辑即产生当前矩阵；null 表示全部走缺省默认）
      if (settings.roomPermissionMatrix) {
        payload.roomPermissionMatrix = settings.roomPermissionMatrix
      }
      const res = await apiFetch('/api/admin/settings', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as {
        success: boolean
        settings?: AdminSettings
        message?: string
      }
      if (data.success) {
        message.success(t('设置已保存'))
        if (data.settings) {
          setSettings(data.settings)
        }
        // invalidate 仅清除缓存标记，store 里仍是旧值——必须立即重拉，
        // 否则保存后导航到房间页时 RoomPanel/WatchPage 读到的
        // betaFeaturesEnabled 等字段还是开启前的值（App 启动只拉一次）
        invalidateSystemSettings()
        void fetchPublicSettings()
      } else {
        message.error(data.message ?? t('保存失败'))
      }
    } catch (err) {
      console.error('[AdminPage] save settings error:', err)
      message.error(t('保存设置失败'))
    } finally {
      setSavingSettings(false)
    }
  }

  const handleCleanupUnusedRooms = async () => {
    setCleanupLoading(true)
    try {
      const res = await apiFetch('/api/admin/rooms/cleanup-unused', {
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
          message.success(
            t('已清理 {{count}} 个无人使用的房间', { count: data.count })
          )
        } else {
          message.info(t('暂无可清理的房间'))
        }
        setCleanupConfirm(false)
        await fetchRooms()
      } else {
        message.error(data.message ?? t('清理失败'))
      }
    } catch (err) {
      console.error('[AdminPage] cleanup unused rooms error:', err)
      message.error(t('清理房间失败'))
    } finally {
      setCleanupLoading(false)
    }
  }

  const isSelf = (targetUser: AdminUser) => user?.id === String(targetUser.id)

  /** 点击房间卡片：active 进入 host 视角，closed 弹警告（原行为保持） */
  const handleEnterRoom = (room: AdminRoom) => {
    if (room.status === 'active') {
      navigate(`/room/${room.roomId}?role=host`)
    } else {
      message.warning(t('房间已关闭，无法进入'), {
        duration: 5000,
      })
    }
  }

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
            {t('管理页面')}
          </Title>
          <Text type="secondary">
            {t('管理用户账号、房间运行与服务器基础设置')}
          </Text>
        </div>

        <div className="mb-6 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => setActiveTab('users')}
            className="relative flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-sm font-medium transition-all sm:px-4"
            style={{
              backgroundColor:
                activeTab === 'users'
                  ? 'var(--md-sys-color-primary-container)'
                  : 'var(--glass-bg)',
              color:
                activeTab === 'users'
                  ? 'var(--md-sys-color-on-primary-container)'
                  : 'var(--md-sys-color-on-surface)',
              border: '1px solid var(--md-sys-color-outline)',
            }}
          >
            <Users className="h-4 w-4" />
            <span className="hidden sm:inline">{t('用户管理')}</span>
          </button>
          <button
            onClick={() => setActiveTab('rooms')}
            className="relative flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-sm font-medium transition-all sm:px-4"
            style={{
              backgroundColor:
                activeTab === 'rooms'
                  ? 'var(--md-sys-color-primary-container)'
                  : 'var(--glass-bg)',
              color:
                activeTab === 'rooms'
                  ? 'var(--md-sys-color-on-primary-container)'
                  : 'var(--md-sys-color-on-surface)',
              border: '1px solid var(--md-sys-color-outline)',
            }}
          >
            <LayoutDashboard className="h-4 w-4" />
            <span className="hidden sm:inline">{t('房间管理')}</span>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className="relative flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-sm font-medium transition-all sm:px-4"
            style={{
              backgroundColor:
                activeTab === 'settings'
                  ? 'var(--md-sys-color-primary-container)'
                  : 'var(--glass-bg)',
              color:
                activeTab === 'settings'
                  ? 'var(--md-sys-color-on-primary-container)'
                  : 'var(--md-sys-color-on-surface)',
              border: '1px solid var(--md-sys-color-outline)',
            }}
          >
            <Settings className="h-4 w-4" />
            <span className="hidden sm:inline">{t('基础设置')}</span>
          </button>
        </div>

        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Text type="secondary" className="shrink-0">
            {activeTab === 'users'
              ? t('共 {{length}} 位用户', { length: users.length })
              : activeTab === 'rooms'
                ? t('共 {{length}} 个房间', { length: rooms.length })
                : ''}
          </Text>
          {activeTab !== 'settings' && (
            <div className="flex flex-wrap items-center gap-2">
              {activeTab === 'rooms' && (
                <>
                  <div
                    className="inline-flex shrink-0 rounded-[var(--md-sys-shape-corner)] border p-0.5"
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
                      aria-label={t('列表视图')}
                      title={t('列表视图')}
                    >
                      <List className="h-4 w-4" />
                      <span className="hidden sm:inline">{t('列表')}</span>
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
                      aria-label={t('平铺视图')}
                      title={t('平铺视图')}
                    >
                      <LayoutGrid className="h-4 w-4" />
                      <span className="hidden sm:inline">{t('平铺')}</span>
                    </button>
                  </div>
                  {selectedRoomIds.size > 0 && (
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setBatchDeleteConfirm(true)}
                      disabled={batchDeleteLoading}
                      title={t('删除已选 {{size}} 个房间', {
                        size: selectedRoomIds.size,
                      })}
                    >
                      <span className="sm:hidden">
                        {t('已选 {{size}}', { size: selectedRoomIds.size })}
                      </span>
                      <span className="hidden sm:inline">
                        {t('删除已选 ({{size}})', {
                          size: selectedRoomIds.size,
                        })}
                      </span>
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setDeleteAllConfirm(true)}
                    disabled={deleteAllLoading}
                    title={t('删除所有房间')}
                  >
                    <span className="sm:hidden">{t('全部')}</span>
                    <span className="hidden sm:inline">
                      {t('删除所有房间')}
                    </span>
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setCleanupConfirm(true)}
                    disabled={cleanupLoading}
                    title={t('移除无人的房间')}
                  >
                    <span className="sm:hidden">{t('清理')}</span>
                    <span className="hidden sm:inline">
                      {t('移除无人的房间')}
                    </span>
                  </Button>
                </>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={loadData}
                disabled={loading}
                title={t('刷新')}
              >
                <span className="sm:hidden">{t('刷新')}</span>
                <span className="hidden sm:inline">{t('刷新')}</span>
              </Button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="py-12">
            <Spinner tip={t('加载中...')} size={32} />
          </div>
        ) : activeTab === 'users' ? (
          <UsersTab
            users={users}
            registrationMode={settings.registrationMode}
            onRegistrationModeChange={(mode) =>
              setSettings((prev) => ({ ...prev, registrationMode: mode }))
            }
            onSaveSettings={handleSaveSettings}
            savingSettings={savingSettings}
            editingMusicVolume={editingMusicVolume}
            isSelf={isSelf}
            onChangeRole={handleChangeRole}
            onRequestApprove={setUserApprove}
            onRequestDelete={setUserDelete}
          />
        ) : activeTab === 'rooms' ? (
          <RoomsTab
            rooms={rooms}
            roomViewMode={roomViewMode}
            selectedRoomIds={selectedRoomIds}
            onChangeSelectedRoomIds={setSelectedRoomIds}
            onReopenRoom={handleReopenRoom}
            roomReopeningId={roomReopeningId}
            onRequestCloseRoom={setRoomClose}
            onEnterRoom={handleEnterRoom}
          />
        ) : (
          <SettingsTab
            settings={settings}
            onSettingsChange={setSettings}
            settingsLoading={settingsLoading}
            savingSettings={savingSettings}
            editingMusicVolume={editingMusicVolume}
            musicVolumeDraft={musicVolumeDraft}
            onMusicVolumeDraftChange={setMusicVolumeDraft}
            onCommitMusicVolume={commitMusicVolume}
            onEditingMusicVolumeChange={setEditingMusicVolume}
            onSaveSettings={handleSaveSettings}
            cmsInspectUrl={cmsInspectUrl}
            onCmsInspectUrlChange={setCmsInspectUrl}
            cmsInspecting={cmsInspecting}
            onInspectCmsSource={handleInspectCmsSource}
            onCmsSourcesBlur={handleCmsSourcesBlur}
            update={update}
          />
        )}
      </Card>

      <ConfirmModal
        open={!!userDelete}
        onClose={() => setUserDelete(null)}
        title={t('删除用户')}
        onOk={handleDeleteUser}
        onCancel={() => setUserDelete(null)}
        okText={t('删除')}
        cancelText={t('取消')}
      >
        <Trans
          i18nKey="确定要删除用户 <strong>{{name}}</strong> 吗？此操作不可撤销。"
          values={{ name: userDelete?.username }}
          components={{ strong: <strong /> }}
        />
      </ConfirmModal>

      <ConfirmModal
        open={!!userApprove}
        onClose={() => setUserApprove(null)}
        title={t('审核用户')}
        onOk={handleApproveUser}
        onCancel={() => setUserApprove(null)}
        okText={t('通过审核')}
        cancelText={t('取消')}
      >
        <Trans
          i18nKey="确定通过 <strong>{{name}}</strong> 的注册申请吗？审核后该用户将变为普通用户并可正常使用。"
          values={{ name: userApprove?.username }}
          components={{ strong: <strong /> }}
        />
      </ConfirmModal>

      <ConfirmModal
        open={!!roomClose}
        onClose={() => setRoomClose(null)}
        title={t('强制关闭房间')}
        onOk={handleCloseRoom}
        onCancel={() => setRoomClose(null)}
        okText={t('关闭')}
        cancelText={t('取消')}
      >
        <Trans
          i18nKey="确定要强制关闭房间 <strong>{{room}}</strong> 吗？所有连接将断开。"
          values={{ room: roomClose?.roomId }}
          components={{ strong: <strong /> }}
        />
      </ConfirmModal>

      <ConfirmModal
        open={cleanupConfirm}
        onClose={() => {
          if (!cleanupLoading) setCleanupConfirm(false)
        }}
        title={t('移除无人的房间')}
        onOk={handleCleanupUnusedRooms}
        onCancel={() => setCleanupConfirm(false)}
        okText={t('确认')}
        cancelText={t('取消')}
        confirmLoading={cleanupLoading}
      >
        {t('确定要移除所有无人的房间（含已关闭的房间）吗？此操作不可撤销。')}
      </ConfirmModal>

      <ConfirmModal
        open={batchDeleteConfirm}
        onClose={() => setBatchDeleteConfirm(false)}
        title={t('批量删除房间')}
        onOk={handleBatchDeleteRooms}
        onCancel={() => setBatchDeleteConfirm(false)}
        okText={t('删除')}
        cancelText={t('取消')}
        confirmLoading={batchDeleteLoading}
      >
        <Trans
          i18nKey="确定要删除选中的 <strong>{{count}}</strong> 个房间吗？此操作不可撤销。"
          values={{ count: selectedRoomIds.size }}
          components={{ strong: <strong /> }}
        />
      </ConfirmModal>

      <ConfirmModal
        open={deleteAllConfirm}
        onClose={() => setDeleteAllConfirm(false)}
        title={t('删除所有房间')}
        onOk={handleDeleteAllRooms}
        onCancel={() => setDeleteAllConfirm(false)}
        okText={t('全部删除')}
        cancelText={t('取消')}
        confirmLoading={deleteAllLoading}
      >
        {t('确定要删除所有房间吗？此操作不可撤销，所有房间数据将被清除。')}
      </ConfirmModal>
    </div>
  )
}
