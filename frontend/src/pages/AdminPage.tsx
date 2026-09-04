import { useEffect, useRef, useState, type ChangeEvent } from 'react'
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
  Upload,
} from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Text } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Spinner } from '@/components/ui/Spinner'
import { ConfirmModal } from '@/components/ui/Modal'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/Switch'
import { Input } from '@/components/ui/Input'
import { InputNumber } from '@/components/ui/InputNumber'
import { Select } from '@/components/ui/Select'
import { AniSubsGithubBrowser } from '@/modules/admin/components/AniSubsGithubBrowser'
import { message } from '@/components/ui/message'
import { useHideBodyScrollbar } from '@/hooks/useHideBodyScrollbar'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { apiFetch, getApiUrl } from '@/lib/api'

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
  releaseNotes: string
  releaseUrl: string
  publishedAt: string
  downloadUrl: string
  isPrerelease: boolean
  assetName: string
  assetSize: number
}

/** 更新进度状态：由 SSE 流式接口推送 */
interface UpdateProgress {
  /** 当前阶段 */
  stage: 'downloading' | 'extracting' | 'starting' | 'done' | 'error'
  /** 下载已接收字节数（仅 downloading 阶段） */
  received: number
  /** 下载总字节数（仅 downloading 阶段，可能为 0） */
  total: number
  /** 完成或错误消息 */
  message: string
}

/** SSE 事件结构，与后端 UpdateStageEvent 对齐 */
interface UpdateStageEventPayload {
  stage: 'downloading' | 'extracting' | 'starting' | 'done' | 'error'
  received?: number
  total?: number
  message?: string
}

/** 将字节数格式化为人类可读的文件大小 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type RegistrationMode = 'open' | 'approval' | 'closed'
type RoomCreationMode = 'admin-only' | 'all-users'

interface AdminSettings {
  autoDeleteInactiveRooms: boolean
  autoDeleteAfterHours: number
  registrationMode: RegistrationMode
  roomCreationMode: RoomCreationMode
  betaFeaturesEnabled: boolean
  dashDisabled: boolean
  cdnAccelerate: boolean
  cdnProxyUrl: string
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

export default function AdminPage() {
  useHideBodyScrollbar()
  const navigate = useNavigate()
  const { isAuthenticated, user } = useAuthStore()
  const { invalidate: invalidateSystemSettings } = useSystemSettingsStore()
  const [activeTab, setActiveTab] = useState<'users' | 'rooms' | 'settings'>(
    'users'
  )
  const [users, setUsers] = useState<AdminUser[]>([])
  const [rooms, setRooms] = useState<AdminRoom[]>([])
  const [settings, setSettings] = useState<AdminSettings>({
    autoDeleteInactiveRooms: true,
    autoDeleteAfterHours: 24,
    registrationMode: 'approval',
    roomCreationMode: 'admin-only',
    betaFeaturesEnabled: false,
    dashDisabled: false,
    cdnAccelerate: false,
    cdnProxyUrl: 'https://gh-proxy.com',
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
  const [uploadLoading, setUploadLoading] = useState(false)
  // 更新进度：应用更新时由 SSE 流式接口实时推送
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(
    null
  )
  const [includePrerelease, setIncludePrerelease] = useState(
    () => localStorage.getItem('update-include-prerelease') === 'true'
  )
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const authHeaders = {
    'Content-Type': 'application/json',
  }

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
      message.error(data.message ?? '获取用户列表失败')
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
      message.error(data.message ?? '获取房间列表失败')
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
      const res = await apiFetch(
        `/api/system/update/check?includePrerelease=${includePrerelease}`,
        {
          headers: authHeaders,
        }
      )
      const data = (await res.json()) as {
        success: boolean
        info?: UpdateInfo
        message?: string
      }
      if (data.success && data.info) {
        setUpdateInfo(data.info)
        if (data.info.hasUpdate) {
          message.info(
            data.info.isPrerelease ? '发现新预发布版本' : '发现新版本'
          )
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
    setUpdateProgress({
      stage: 'downloading',
      received: 0,
      total: 0,
      message: '',
    })
    try {
      // 使用 SSE 流式接口，实时推送下载/解压/启动进度
      const res = await apiFetch(
        `/api/system/update/apply-stream?includePrerelease=${includePrerelease}`,
        {
          method: 'POST',
          headers: authHeaders,
        }
      )

      if (!res.ok || !res.body) {
        // 非流式错误响应（如 401/403/500）
        const errData = (await res.json().catch(() => ({}))) as {
          message?: string
        }
        message.error(errData.message ?? '更新失败')
        setUpdateProgress(null)
        return
      }

      // 读取 SSE 流：按 `\n\n` 分割事件，每条事件 `data: <json>`
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastStage: UpdateProgress['stage'] | null = null
      let doneMessage = ''
      let errorMessage = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const evt of events) {
          const line = evt.trim()
          if (!line.startsWith('data: ')) continue
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue
          try {
            const data = JSON.parse(jsonStr) as UpdateStageEventPayload
            if (data.stage === 'downloading') {
              setUpdateProgress({
                stage: 'downloading',
                received: data.received ?? 0,
                total: data.total ?? 0,
                message: '',
              })
            } else if (data.stage === 'extracting') {
              setUpdateProgress({
                stage: 'extracting',
                received: 0,
                total: 0,
                message: '正在解压更新包…',
              })
            } else if (data.stage === 'starting') {
              setUpdateProgress({
                stage: 'starting',
                received: 0,
                total: 0,
                message: '正在启动更新脚本…',
              })
            } else if (data.stage === 'done') {
              doneMessage = data.message ?? '更新已触发'
              setUpdateProgress({
                stage: 'done',
                received: 0,
                total: 0,
                message: doneMessage,
              })
            } else if (data.stage === 'error') {
              errorMessage = data.message ?? '更新失败'
              setUpdateProgress({
                stage: 'error',
                received: 0,
                total: 0,
                message: errorMessage,
              })
            }
            lastStage = data.stage
          } catch {
            // 忽略解析错误
          }
        }
      }

      if (lastStage === 'done') {
        message.success(doneMessage || '更新已触发')
      } else if (lastStage === 'error') {
        message.error(errorMessage || '更新失败')
      } else {
        // 流意外中断，未收到 done/error
        message.error('更新中断，请重试')
      }
    } catch (err) {
      console.error('[AdminPage] apply update error:', err)
      message.error('更新失败')
    } finally {
      setApplyLoading(false)
      // 保留进度状态显示最终结果，3 秒后清除
      setTimeout(() => setUpdateProgress(null), 3000)
    }
  }

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    // 验证文件类型
    const lowerName = file.name.toLowerCase()
    if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.tar.gz')) {
      message.error('仅支持 .zip 或 .tar.gz 格式的压缩包')
      event.target.value = ''
      return
    }

    setUploadLoading(true)
    setUpdateProgress({
      stage: 'downloading',
      received: 0,
      total: file.size,
      message: '正在上传更新包…',
    })

    try {
      // 使用 XHR 上传：可跟踪上传进度，响应体为 SSE 流
      const apiUrl = getApiUrl()
      const uploadUrl = `${apiUrl}/api/system/update/upload-stream?filename=${encodeURIComponent(file.name)}`

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', uploadUrl)
        xhr.withCredentials = true
        xhr.responseType = 'text'
        xhr.setRequestHeader(
          'Content-Type',
          lowerName.endsWith('.tar.gz') ? 'application/gzip' : 'application/zip'
        )

        // 上传进度跟踪
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUpdateProgress({
              stage: 'downloading',
              received: e.loaded,
              total: e.total,
              message: '正在上传更新包…',
            })
          }
        }

        // 上传完成 → 开始接收 SSE 响应流
        // xhr.onprogress 在响应数据到达时触发，可读取增量 responseText
        let lastProcessedLen = 0
        let buffer = ''
        let lastStage: UpdateProgress['stage'] | null = null
        let doneMessage = ''
        let errorMessage = ''

        const processSSEChunk = () => {
          const fullText = xhr.responseText || ''
          const chunk = fullText.slice(lastProcessedLen)
          lastProcessedLen = fullText.length
          buffer += chunk
          const events = buffer.split('\n\n')
          buffer = events.pop() ?? ''
          for (const evt of events) {
            const line = evt.trim()
            if (!line.startsWith('data: ')) continue
            const jsonStr = line.slice(6).trim()
            if (!jsonStr) continue
            try {
              const data = JSON.parse(jsonStr) as UpdateStageEventPayload
              if (data.stage === 'extracting') {
                setUpdateProgress({
                  stage: 'extracting',
                  received: 0,
                  total: 0,
                  message: '正在解压更新包…',
                })
              } else if (data.stage === 'starting') {
                setUpdateProgress({
                  stage: 'starting',
                  received: 0,
                  total: 0,
                  message: '正在启动更新脚本…',
                })
              } else if (data.stage === 'done') {
                doneMessage = data.message ?? '更新已触发'
                setUpdateProgress({
                  stage: 'done',
                  received: 0,
                  total: 0,
                  message: doneMessage,
                })
              } else if (data.stage === 'error') {
                errorMessage = data.message ?? '更新失败'
                setUpdateProgress({
                  stage: 'error',
                  received: 0,
                  total: 0,
                  message: errorMessage,
                })
              }
              lastStage = data.stage
            } catch {
              // 忽略解析错误
            }
          }
        }

        xhr.onprogress = processSSEChunk

        xhr.onload = () => {
          // 处理流中剩余数据
          processSSEChunk()
          if (xhr.status >= 200 && xhr.status < 300) {
            if (lastStage === 'done') {
              message.success(doneMessage || '更新已触发')
            } else if (lastStage === 'error') {
              message.error(errorMessage || '上传更新失败')
            } else if (lastStage === null) {
              // 未收到 SSE 事件，可能是普通 JSON 响应（错误场景）
              try {
                const data = JSON.parse(xhr.responseText) as {
                  success?: boolean
                  message?: string
                }
                if (data.success) {
                  message.success(data.message ?? '更新已触发')
                } else {
                  message.error(data.message ?? '上传更新失败')
                }
              } catch {
                message.error('上传更新失败')
              }
            }
            resolve()
          } else if (xhr.status === 401 || xhr.status === 403) {
            message.error('登录已过期，请重新登录后再试')
            reject(new Error('auth expired'))
          } else {
            // 非 SSE 错误响应
            try {
              const data = JSON.parse(xhr.responseText) as {
                message?: string
              }
              message.error(data.message ?? '上传更新失败')
            } catch {
              message.error('上传更新失败')
            }
            reject(new Error(`HTTP ${xhr.status}`))
          }
        }

        xhr.onerror = () => {
          message.error('网络错误，上传更新失败')
          reject(new Error('network error'))
        }

        xhr.send(file)
      })
    } catch (err) {
      console.error('[AdminPage] upload update error:', err)
      if (
        err instanceof Error &&
        err.message !== 'network error' &&
        err.message !== 'auth expired' &&
        !err.message.startsWith('HTTP')
      ) {
        message.error('上传更新失败')
      }
    } finally {
      setUploadLoading(false)
      event.target.value = ''
      // 保留进度状态显示最终结果，3 秒后清除
      setTimeout(() => setUpdateProgress(null), 3000)
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
      const res = await apiFetch(`/api/admin/users/${userApprove.id}/approve`, {
        method: 'POST',
        headers: authHeaders,
      })
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
      const res = await apiFetch(`/api/admin/users/${userDelete.id}`, {
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
      const res = await apiFetch(`/api/admin/rooms/${roomClose.roomId}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
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
      // 仅在 dataSourceConfig 有值时传递，避免 null 覆盖已有配置；
      // dataSourceConfig 的编辑入口在"数据源设置"卡片，不在权限管理页面。
      const payload: Record<string, unknown> = {
        autoDeleteInactiveRooms: settings.autoDeleteInactiveRooms,
        autoDeleteAfterHours: settings.autoDeleteAfterHours,
        registrationMode: settings.registrationMode,
        roomCreationMode: settings.roomCreationMode,
        betaFeaturesEnabled: settings.betaFeaturesEnabled,
        dashDisabled: settings.dashDisabled,
        cdnAccelerate: settings.cdnAccelerate,
        cdnProxyUrl: settings.cdnProxyUrl,
      }
      if (settings.dataSourceConfig) {
        payload.dataSourceConfig = settings.dataSourceConfig
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
        message.success('设置已保存')
        if (data.settings) {
          setSettings(data.settings)
        }
        invalidateSystemSettings()
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
            <span className="hidden sm:inline">用户管理</span>
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
            <span className="hidden sm:inline">房间管理</span>
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
            <span className="hidden sm:inline">基础设置</span>
          </button>
        </div>

        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Text type="secondary" className="shrink-0">
            {activeTab === 'users'
              ? `共 ${users.length} 位用户`
              : activeTab === 'rooms'
                ? `共 ${rooms.length} 个房间`
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
                      title={`删除已选 ${selectedRoomIds.size} 个房间`}
                    >
                      <span className="sm:hidden">
                        已选 {selectedRoomIds.size}
                      </span>
                      <span className="hidden sm:inline">
                        删除已选 ({selectedRoomIds.size})
                      </span>
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setDeleteAllConfirm(true)}
                    disabled={deleteAllLoading}
                    title="删除所有房间"
                  >
                    <span className="sm:hidden">全部</span>
                    <span className="hidden sm:inline">删除所有房间</span>
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setCleanupConfirm(true)}
                    disabled={cleanupLoading}
                    title="一键移除无人使用的房间"
                  >
                    <span className="sm:hidden">清理</span>
                    <span className="hidden sm:inline">
                      一键移除无人使用的房间
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
                title="刷新"
              >
                <span className="sm:hidden">刷新</span>
                <span className="hidden sm:inline">刷新</span>
              </Button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="py-12">
            <Spinner tip="加载中..." size={32} />
          </div>
        ) : activeTab === 'users' ? (
          <div className="grid gap-3">
            <div className="glass-card p-4">
              <Title level={5} className="mb-3">
                用户注册设置
              </Title>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="max-w-xs flex-1">
                  <Select
                    label="注册方式"
                    value={settings.registrationMode}
                    options={[
                      { label: '直接注册', value: 'open' },
                      { label: '审批注册', value: 'approval' },
                      { label: '禁止注册', value: 'closed' },
                    ]}
                    onChange={(value) =>
                      setSettings((prev) => ({
                        ...prev,
                        registrationMode: value as RegistrationMode,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    直接注册：新用户注册后立即可用；审批注册：新用户需 root
                    审核通过后方可登录；禁止注册：关闭注册入口。
                  </p>
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
              </div>
            </div>
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
                    className={cn(
                      'glass-card flex flex-col gap-3 p-4 transition-colors sm:flex-row sm:items-center sm:justify-between'
                    )}
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
                            backgroundColor: 'var(--glass-bg)',
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
                    className={cn(
                      roomViewMode === 'tile'
                        ? 'flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors cursor-pointer'
                        : 'flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between cursor-pointer',
                      selectedRoomIds.has(room.roomId)
                        ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)]'
                        : 'glass border-[var(--md-sys-color-outline)]'
                    )}
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
                        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--md-sys-color-primary)]"
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
                          <Text
                            type="secondary"
                            className="text-xs sm:hidden"
                            title={room.roomId}
                          >
                            {room.roomId.length > 8
                              ? `${room.roomId.slice(0, 8)}…`
                              : room.roomId}
                          </Text>
                          <Text
                            type="secondary"
                            className="hidden text-xs sm:inline"
                          >
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
                          className="mt-1 text-xs leading-relaxed sm:mt-0"
                        >
                          观众 {room.viewerCount} / {room.maxViewers}
                          {roomViewMode === 'tile' ? <br /> : ' · '}
                          分享端{room.sharerOnline ? '在线' : '离线'}
                          {roomViewMode === 'tile' ? <br /> : ' · '}
                          创建于 {formatDate(room.createdAt)}
                          {roomViewMode === 'tile' ? <br /> : ' · '}
                          最后访问 {formatDate(room.lastAccessedAt)}
                        </Text>
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      className={
                        roomViewMode === 'tile'
                          ? 'mt-auto w-full'
                          : 'w-full sm:w-auto'
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
          <div className="glass-card p-4">
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
                  房间创建权限
                </Title>
                <div className="mb-6 max-w-md">
                  <Select
                    label="允许创建房间的用户范围"
                    value={settings.roomCreationMode}
                    options={[
                      {
                        label: '仅管理员（root / admin）',
                        value: 'admin-only',
                      },
                      {
                        label: '所有登录用户（user / admin / root）',
                        value: 'all-users',
                      },
                    ]}
                    onChange={(value) =>
                      setSettings((prev) => ({
                        ...prev,
                        roomCreationMode: value as RoomCreationMode,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    切换为「所有登录用户」后，普通用户也可在主页点击「开始共享」创建房间；游客始终不能创建房间。
                  </p>
                </div>

                <Title level={5} className="mb-4 mt-6">
                  Beta 功能
                </Title>
                <div className="mb-6">
                  <Switch
                    label="启用 Beta 功能（Kazumi / AniSubs 番剧源 / B站视频下载）"
                    checked={settings.betaFeaturesEnabled}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        betaFeaturesEnabled: e.target.checked,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    关闭时，房间内的 Kazumi 与 AniSubs 番剧添加入口、个人中心的
                    B站视频下载按钮及其相关设置将被隐藏。
                  </p>
                </div>

                {settings.betaFeaturesEnabled && (
                  <>
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
                        value={(
                          settings.dataSourceConfig?.kazumiRules || []
                        ).join('\n')}
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
                        existingUrls={
                          settings.dataSourceConfig?.kazumiRules || []
                        }
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
                  </>
                )}

                <Title level={5} className="mb-4 mt-6">
                  服务器 DASH 流
                  <span className="ml-2 text-xs font-normal text-[var(--md-sys-color-on-surface-variant)]">
                    （已废弃，不建议关闭）
                  </span>
                </Title>
                <div className="mb-6">
                  <Switch
                    label="禁用服务器端 DASH 模式"
                    checked={settings.dashDisabled}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        dashDisabled: e.target.checked,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    开启后，服务器端 B站 解析将强制使用 MP4 模式，不再返回 DASH
                    流。仅影响服务器端解析，不影响 CLI 代理的 DASH 模式。
                  </p>
                </div>

                <Title level={5} className="mb-4 mt-6">
                  版本更新
                </Title>
                <div className="glass-card mb-6 p-4">
                  <div className="flex items-center justify-between pb-3 mb-3 border-b border-[var(--md-sys-color-outline-variant)]">
                    <div className="flex-1 min-w-0 pr-3">
                      <Text className="text-sm font-medium">
                        接收预发布版本更新
                      </Text>
                      <Text type="secondary" className="block text-xs mt-0.5">
                        开启后可更新到预发布版本，关闭则仅在正式版之间更新
                      </Text>
                    </div>
                    <Switch
                      checked={includePrerelease}
                      onChange={(e) => {
                        setIncludePrerelease(e.target.checked)
                        localStorage.setItem(
                          'update-include-prerelease',
                          String(e.target.checked)
                        )
                      }}
                    />
                  </div>
                  {/* CDN 加速配置 */}
                  <div className="pb-3 mb-3 border-b border-[var(--md-sys-color-outline-variant)]">
                    <div className="flex items-center justify-between pb-3">
                      <div className="flex-1 min-w-0 pr-3">
                        <Text className="text-sm font-medium">
                          更新 CDN 加速
                        </Text>
                        <Text type="secondary" className="block text-xs mt-0.5">
                          开启后，更新检测和 Release 下载将走 CDN 代理加速
                        </Text>
                      </div>
                      <Switch
                        checked={settings.cdnAccelerate}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            cdnAccelerate: e.target.checked,
                          }))
                        }
                      />
                    </div>
                    {settings.cdnAccelerate && (
                      <div className="space-y-3">
                        <div>
                          <Text className="mb-1.5 block text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                            CDN 代理地址
                          </Text>
                          <Input
                            value={settings.cdnProxyUrl}
                            onChange={(e) =>
                              setSettings((prev) => ({
                                ...prev,
                                cdnProxyUrl: e.target.value.trim(),
                              }))
                            }
                            placeholder="https://gh-proxy.com"
                          />
                          <Text
                            type="secondary"
                            className="block text-xs mt-1.5"
                          >
                            使用 GitHub 代理前缀方式加速，默认
                            https://gh-proxy.com，可替换为自建代理。
                          </Text>
                        </div>
                      </div>
                    )}
                  </div>
                  {/* 更新进度条：下载/上传/解压/启动各阶段实时显示 */}
                  {updateProgress && (
                    <div className="mb-3 rounded-[var(--md-sys-radius-small)] bg-[var(--md-sys-color-surface-container-high)] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                          {updateProgress.stage === 'downloading' &&
                            (updateProgress.message || '正在下载更新包…')}
                          {updateProgress.stage === 'extracting' &&
                            '正在解压更新包…'}
                          {updateProgress.stage === 'starting' &&
                            '正在启动更新脚本…'}
                          {updateProgress.stage === 'done' &&
                            (updateProgress.message || '更新已触发')}
                          {updateProgress.stage === 'error' &&
                            (updateProgress.message || '更新失败')}
                        </Text>
                        {updateProgress.stage === 'downloading' &&
                          updateProgress.total > 0 && (
                            <Text className="shrink-0 text-[10px] font-mono text-[var(--md-sys-color-on-surface-variant)]">
                              {formatBytes(updateProgress.received)} /{' '}
                              {formatBytes(updateProgress.total)}
                            </Text>
                          )}
                      </div>
                      {/* 进度条 */}
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--md-sys-color-surface-container-lowest)]">
                        {updateProgress.stage === 'downloading' ? (
                          updateProgress.total > 0 ? (
                            <div
                              className="h-full rounded-full bg-[var(--md-sys-color-primary)] transition-all duration-150"
                              style={{
                                width: `${Math.min(
                                  100,
                                  (updateProgress.received /
                                    updateProgress.total) *
                                    100
                                )}%`,
                              }}
                            />
                          ) : (
                            // 总大小未知时显示不确定进度动画
                            <div className="zen-indeterminate-bar h-full w-1/3 rounded-full bg-[var(--md-sys-color-primary)]" />
                          )
                        ) : (
                          <div
                            className={cn(
                              'h-full rounded-full transition-all duration-300',
                              updateProgress.stage === 'done' &&
                                'w-full bg-[var(--md-sys-color-primary)]',
                              updateProgress.stage === 'error' &&
                                'w-full bg-[var(--md-sys-color-error)]',
                              (updateProgress.stage === 'extracting' ||
                                updateProgress.stage === 'starting') &&
                                'w-1/2 bg-[var(--md-sys-color-primary)] zen-indeterminate-bar'
                            )}
                          />
                        )}
                      </div>
                    </div>
                  )}
                  {updateLoading ? (
                    <div className="py-4">
                      <Spinner tip="检查更新中..." size={24} />
                    </div>
                  ) : updateInfo ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Text className="text-sm">
                          当前版本：
                          <span className="font-mono text-[var(--md-sys-color-on-surface-variant)]">
                            {updateInfo.currentVersion}
                          </span>
                        </Text>
                        <Text className="text-sm">
                          远程版本：
                          <span className="font-mono text-[var(--md-sys-color-on-surface-variant)]">
                            {updateInfo.remoteVersion}
                          </span>
                        </Text>
                      </div>
                      {updateInfo.isPrerelease && (
                        <div className="inline-flex rounded-full bg-[var(--md-sys-color-tertiary-container)] px-2 py-0.5">
                          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--md-sys-color-on-tertiary-container)]">
                            预发布版本
                          </span>
                        </div>
                      )}
                      {updateInfo.publishedAt && (
                        <Text type="secondary" className="text-xs">
                          发布时间：
                          {new Date(updateInfo.publishedAt).toLocaleString(
                            'zh-CN'
                          )}
                        </Text>
                      )}
                      {updateInfo.assetSize > 0 && (
                        <Text type="secondary" className="text-xs">
                          构建产物：{updateInfo.assetName} (
                          {(updateInfo.assetSize / (1024 * 1024)).toFixed(1)}
                          MB)
                        </Text>
                      )}
                      {updateInfo.releaseNotes && (
                        <div className="max-h-32 overflow-y-auto rounded-[var(--md-sys-radius-small)] bg-[var(--md-sys-color-surface-container-high)] p-2">
                          <Text className="whitespace-pre-wrap text-xs leading-relaxed">
                            {updateInfo.releaseNotes
                              .split('\n')
                              .slice(0, 10)
                              .join('\n')}
                          </Text>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
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
                        {updateInfo.releaseUrl && (
                          <a
                            href={updateInfo.releaseUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-[var(--md-sys-color-primary)] hover:underline"
                          >
                            查看发布
                          </a>
                        )}
                      </div>
                      {/* 分割线 */}
                      <div className="my-2 border-t border-[var(--md-sys-color-outline-variant)]" />
                      {/* 手动导入压缩包 */}
                      <div className="space-y-2">
                        <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                          手动导入更新包
                        </Text>
                        <div className="flex items-center gap-2">
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".zip,.tar.gz"
                            onChange={handleFileUpload}
                            className="hidden"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Upload className="h-4 w-4" />}
                            onClick={() => fileInputRef.current?.click()}
                            loading={uploadLoading}
                            disabled={uploadLoading}
                          >
                            选择压缩包
                          </Button>
                          <Text type="secondary" className="text-xs">
                            支持 .zip / .tar.gz 格式
                          </Text>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
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
                      <div className="my-2 border-t border-[var(--md-sys-color-outline-variant)]" />
                      <div className="space-y-2">
                        <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                          手动导入更新包
                        </Text>
                        <div className="flex items-center gap-2">
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".zip,.tar.gz"
                            onChange={handleFileUpload}
                            className="hidden"
                          />
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<Upload className="h-4 w-4" />}
                            onClick={() => fileInputRef.current?.click()}
                            loading={uploadLoading}
                            disabled={uploadLoading}
                          >
                            选择压缩包
                          </Button>
                          <Text type="secondary" className="text-xs">
                            支持 .zip / .tar.gz 格式
                          </Text>
                        </div>
                      </div>
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
        onClose={() => {
          if (!cleanupLoading) setCleanupConfirm(false)
        }}
        title="移除无人使用的房间"
        onOk={handleCleanupUnusedRooms}
        onCancel={() => setCleanupConfirm(false)}
        okText="确认"
        cancelText="取消"
        confirmLoading={cleanupLoading}
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
