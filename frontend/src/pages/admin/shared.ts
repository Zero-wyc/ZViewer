/**
 * AdminPage 拆分出的共享类型与工具（纯搬迁，无行为变更）。
 * 由 AdminPage 与 UsersTab/RoomsTab/SettingsTab 共同引用，
 * 避免子组件之间互相依赖形成循环。
 */

export interface AdminUser {
  id: number
  username: string
  role: 'root' | 'admin' | 'user' | 'guest'
  status: 'active' | 'pending'
  createdAt: string
}

export interface AdminRoom {
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

export interface UpdateInfo {
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
  /** 本次结果的来源：gitcode（镜像产物仓库 ZviewerRelease）或 github */
  source?: 'gitcode' | 'github'
}

/** 更新进度状态：由 SSE 流式接口推送 */
export interface UpdateProgress {
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
export interface UpdateStageEventPayload {
  stage: 'downloading' | 'extracting' | 'starting' | 'done' | 'error'
  received?: number
  total?: number
  message?: string
}

export type RegistrationMode = 'open' | 'approval' | 'closed'
export type RoomCreationMode = 'admin-only' | 'all-users'

/** 房间权限矩阵角色字段 */
export type MatrixRoleField = 'moderator' | 'admin' | 'user'

/** 房间权限矩阵动作 key（与后端 MATRIX_ACTIONS 严格一致） */
export const MATRIX_ACTIONS = [
  { key: 'addMovie', label: '添加影片' },
  { key: 'manageMovie', label: '移除 / 切换影片' },
  { key: 'musicQueue', label: '音乐队列管理（加歌 / 删歌 / 清空 / 排序）' },
  { key: 'kickViewer', label: '踢出成员' },
  { key: 'muteViewer', label: '禁言 / 解禁成员' },
] as const

export const MATRIX_ROLES: Array<{
  key: MatrixRoleField
  label: string
}> = [
  { key: 'moderator', label: '房管' },
  { key: 'admin', label: '管理员' },
  { key: 'user', label: '普通用户' },
]

export type PermissionMatrix = Record<
  string,
  Partial<Record<MatrixRoleField, boolean>>
>

export interface AdminSettings {
  autoDeleteInactiveRooms: boolean
  autoDeleteAfterHours: number
  roomDefaultMusicVolume: number
  registrationMode: RegistrationMode
  roomCreationMode: RoomCreationMode
  roomPermissionMatrix: PermissionMatrix | null
  betaFeaturesEnabled: boolean
  dashDisabled: boolean
  /** 添加 B站影片时的默认解析模式（普通视频，未显式配置影片的运行时兜底） */
  bilibiliDefaultParseMode: 'mp4' | 'dash'
  /** 番剧/影视（PGC）添加影片时的默认模式：cliOnly=物化 Movie.cliOnly 强制成员本机 CLI */
  bilibiliPgcDefaultMode: 'mp4' | 'dash' | 'cliOnly'
  playsvideoEnabled: boolean
  cdnAccelerate: boolean
  cdnProxyUrl: string
  /** 更新源开关：true=镜像产物仓库（Gitee，默认），false=GitHub */
  updateUseGitCode: boolean
  /** 允许单用户在多个页面同时登录同一房间（仅供测试，服务端门控） */
  roomMultiInstanceLogin: boolean
  /** 自定义 LiveKit 服务器地址（客户端连接；空=按页面域名自动推导） */
  livekitExternalUrl: string
  /** 版本更新后是否自动弹出公告（首次启动强制弹出不受此开关限制） */
  announceAutoPopupOnUpdate: boolean
  dataSourceConfig?: {
    aniSubsSubscriptions?: string[]
    kazumiRules?: string[]
    cmsSources?: string[]
    rssSources?: Array<{ id: string; name?: string; url: string }>
    thirdPartySources?: Array<{
      id: string
      name?: string
      baseUrl?: string
      endpoints?: Record<string, unknown>
    }>
  }
}

/** 将字节数格式化为人类可读的文件大小 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 用户列表/最后访问：精确时间（管理审计需要） */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN')
}

/**
 * 常用 TVBox 配置接口快捷填充项（点击仅填入输入框，仍需「检测并添加」
 * 确认拉取与入列）。仅为管理端录入便利，不在运行时默认启用任何源。
 */
export const CMS_SOURCE_PRESETS: { label: string; url: string }[] = [
  {
    label: 'qist/tvbox · 电视合集',
    url: 'https://raw.githubusercontent.com/qist/tvbox/master/jsm.json',
  },
  {
    label: 'qist/tvbox · CF 镜像',
    url: 'https://qist.wyfc.qzz.io/jsm.json',
  },
  {
    label: 'qist/tvbox · 饭太硬',
    url: 'https://raw.githubusercontent.com/qist/tvbox/master/fty.json',
  },
  {
    label: 'qist/tvbox · drpy 混合',
    url: 'https://raw.githubusercontent.com/qist/tvbox/master/js.json',
  },
]
