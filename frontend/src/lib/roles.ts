/**
 * 用户角色共享常量。
 * 统一此前散落在 AdminPage / RoomInfoPanel 等处的角色文案与配色映射
 * （此前三处各自定义且语义漂移）。
 */
export type UserRole = 'root' | 'admin' | 'user' | 'guest'

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  root: '超级管理员',
  admin: '管理员',
  user: '普通用户',
  guest: '游客',
}

/** 角色 → ui/Tag color 枚举（管理后台用户卡片等） */
export type RoleTagColor =
  'default' | 'primary' | 'success' | 'warning' | 'danger' | 'cyan' | 'purple'

export const USER_ROLE_TAG_COLORS: Record<UserRole, RoleTagColor> = {
  root: 'primary',
  admin: 'cyan',
  user: 'default',
  guest: 'default',
}

/** 角色 → 主题 CSS 变量色（自定义染色徽章,如房间成员列表） */
export const USER_ROLE_CSS_COLORS: Record<UserRole, string> = {
  root: 'var(--md-sys-color-error)',
  admin: 'var(--md-sys-color-primary)',
  user: 'var(--md-sys-color-tertiary)',
  guest: 'var(--md-sys-color-outline)',
}
