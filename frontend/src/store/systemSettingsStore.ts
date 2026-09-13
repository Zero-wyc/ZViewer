import { create } from 'zustand'
import { apiFetch, safeJson } from '@/lib/api'

export type RegistrationMode = 'open' | 'approval' | 'closed'
export type RoomCreationMode = 'admin-only' | 'all-users'

/** 房间权限矩阵角色字段（与后端一致） */
export type MatrixRoleField = 'moderator' | 'admin' | 'user'
/** 房间权限矩阵动作 key（与后端 MATRIX_ACTIONS 一致） */
export type MatrixActionKey =
  'addMovie' | 'manageMovie' | 'musicQueue' | 'kickViewer' | 'muteViewer'
export type PermissionMatrix = Record<
  string,
  Partial<Record<MatrixRoleField, boolean>>
>

export interface SystemSettings {
  autoDeleteInactiveRooms: boolean
  autoDeleteAfterHours: number
  registrationMode: RegistrationMode
  /** 房间创建权限模式：admin-only=仅管理员，all-users=所有登录用户（不含 guest） */
  roomCreationMode: RoomCreationMode
  /** 房间可执行动作权限矩阵（null/缺省=按兼容默认：房管+管理员允许、普通用户禁止） */
  roomPermissionMatrix: PermissionMatrix | null
  betaFeaturesEnabled: boolean
  /** 禁用服务器端 DASH 模式，强制 MP4（仅服务器端，不影响 CLI） */
  dashDisabled: boolean
  /** 浏览器播放引擎（playsvideo）全局开关：关闭后全部原生直连播放 */
  playsvideoEnabled: boolean
  /** 更新 CDN 加速开关：true 时更新检测和下载走 CDN 代理 */
  cdnAccelerate: boolean
  /** CDN 代理地址（如 https://gh-proxy.com），对所有 GitHub 请求使用前缀代理 */
  cdnProxyUrl: string
  dataSourceConfig?: Record<string, unknown> | null
}

interface SystemSettingsState extends SystemSettings {
  loading: boolean
  fetched: boolean
  /**
   * 拉取公开设置（无需鉴权）：仅包含 registrationMode / roomCreationMode / betaFeaturesEnabled。
   * App 启动时调用，用于 HomePage 决定是否显示「开始共享」按钮。
   */
  fetchSettings: () => Promise<void>
  /**
   * 拉取完整设置（需管理员鉴权）：包含 autoDelete / dataSourceConfig 等敏感字段。
   * AdminPage 设置页调用。
   */
  fetchAdminSettings: () => Promise<void>
  invalidate: () => void
}

const DEFAULT_SETTINGS: SystemSettings = {
  autoDeleteInactiveRooms: true,
  autoDeleteAfterHours: 24,
  registrationMode: 'approval',
  roomCreationMode: 'admin-only',
  roomPermissionMatrix: null,
  betaFeaturesEnabled: false,
  dashDisabled: true,
  playsvideoEnabled: true,
  cdnAccelerate: false,
  cdnProxyUrl: 'https://gh-proxy.com',
  dataSourceConfig: null,
}

export const useSystemSettingsStore = create<SystemSettingsState>(
  (set, get) => ({
    ...DEFAULT_SETTINGS,
    loading: false,
    fetched: false,
    fetchSettings: async () => {
      if (get().loading || get().fetched) return
      set({ loading: true })
      try {
        // 公开接口：所有用户（含 guest）均可访问，仅返回非敏感字段。
        // 用于 HomePage 决定是否显示「开始共享」按钮。
        const res = await apiFetch('/api/auth/public-settings')
        const data = await safeJson<{
          success: boolean
          settings?: Partial<SystemSettings>
          message?: string
        }>(res, { success: false })
        if (data.success && data.settings) {
          set({
            ...DEFAULT_SETTINGS,
            ...data.settings,
            fetched: true,
          })
        }
      } catch (err) {
        console.error('[systemSettingsStore] fetch settings error:', err)
      } finally {
        set({ loading: false })
      }
    },
    fetchAdminSettings: async () => {
      set({ loading: true })
      try {
        const res = await apiFetch('/api/admin/settings')
        const data = await safeJson<{
          success: boolean
          settings?: Partial<SystemSettings>
          message?: string
        }>(res, { success: false })
        if (data.success && data.settings) {
          set({
            ...DEFAULT_SETTINGS,
            ...data.settings,
            fetched: true,
          })
        }
      } catch (err) {
        console.error('[systemSettingsStore] fetch admin settings error:', err)
      } finally {
        set({ loading: false })
      }
    },
    invalidate: () => set({ fetched: false }),
  })
)

/**
 * 前端侧房间动作矩阵判定（与后端 canViewerPerform 的矩阵部分同语义，
 * 仅用于「是否显示按钮」的 UI 门控；真正的权限校验仍在后端）。
 *
 * @param isHost 当前用户是否房主
 * @param isModerator 当前用户是否房管
 * @param role 系统角色（root/admin/user）
 * @param action 动作 key
 */
export function canRoomViewerPerform(
  matrix: PermissionMatrix | null | undefined,
  action: MatrixActionKey,
  opts: { isHost: boolean; isModerator: boolean; role?: string }
): boolean {
  if (opts.isHost) return true
  if (opts.role === 'root') return true
  if (opts.isModerator) return matrix?.[action]?.moderator !== false
  if (opts.role === 'admin') return matrix?.[action]?.admin !== false
  if (opts.role === 'user') return matrix?.[action]?.user === true
  return false
}
