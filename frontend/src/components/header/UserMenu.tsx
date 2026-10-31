import { createPortal } from 'react-dom'
import type { CSSProperties, RefObject } from 'react'
import {
  LogOut,
  LogIn,
  Shield,
  UserCircle,
  LayoutDashboard,
  ChevronDown,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useAuthStore, type User } from '@/store/authStore'
import { apiFetch, clearAuthTokens, resetSessionExpired } from '@/lib/api'
import { reconnectSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import { Avatar } from '@/components/ui/Avatar'
import { cn } from '@/lib/utils'
import type { DropdownPosition } from './usePortalDropdown'
import { t } from '@/i18n'

interface UserMenuProps {
  user: User
  open: boolean
  closing: boolean
  position: DropdownPosition | null
  buttonRef: RefObject<HTMLButtonElement>
  menuRef: RefObject<HTMLDivElement>
  onToggle: () => void
  /** 立即收起（点击菜单项 / 退出登录时不需要收起动画） */
  onCloseNow: () => void
  /** 房间内导航需拦截确认 */
  needsGuard: boolean
  guardNavigate: (path: string) => void
}

/** 房间内点击这些页面入口时改为新标签页打开（不打断房间会话，无需离开确认） */
const NEW_TAB_NAV_PATHS = new Set(['/profile', '/rooms', '/admin'])

/**
 * 顶栏「账户菜单」下拉：头像/用户名/角色、页面入口、登录或退出登录。
 * 菜单 portal 到 body，定位与开合动画由 usePortalDropdown 统一处理。
 */
export function UserMenu({
  user,
  open,
  closing,
  position,
  buttonRef,
  menuRef,
  onToggle,
  onCloseNow,
  needsGuard,
  guardNavigate,
}: UserMenuProps) {
  const logout = useAuthStore((s) => s.logout)

  const handleLogout = async () => {
    onCloseNow()
    try {
      // 调用后端清除 httpOnly cookie（access_token / refresh_token）
      await apiFetch('/api/auth/logout', {
        method: 'POST',
      })
    } catch (err) {
      // 后端调用失败也继续登出前端状态，避免用户卡在已登录状态
      console.warn('[Header] logout API failed:', err)
      message.error(t('退出登录请求失败，已强制清除本地状态'))
    } finally {
      // 清除本地 Bearer token（跨站 HTTP fallback）
      clearAuthTokens()
      // 重置 session 过期标志，允许后续 onConnectError 中的 refresh 尝试
      resetSessionExpired()
      logout()
      // 登出后必须重连 socket：旧连接仍持有已失效的 root 凭据，
      // 重连后 buildSocketAuth() 返回空载荷 → 服务端拒绝 →
      // onConnectError 处理器自动降级为 guest token
      reconnectSocket()
    }
  }

  const menuItems: {
    icon: ReactNode
    label: string
    to?: string
    onClick?: () => void
  }[] = [
    ...(user.role !== 'guest'
      ? [
          {
            icon: <UserCircle className="w-4 h-4" />,
            label: t('个人中心'),
            to: '/profile',
          },
        ]
      : []),
    {
      icon: <LayoutDashboard className="w-4 h-4" />,
      label: t('房间列表'),
      to: '/rooms',
    },
    ...(user.role === 'admin' || user.role === 'root'
      ? [
          {
            icon: <Shield className="w-4 h-4" />,
            label: t('管理页面'),
            to: '/admin',
          },
        ]
      : []),
  ]

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={onToggle}
        className={cn(
          'flex items-center gap-2 pl-2 pr-2.5 py-1.5 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]',
          open
            ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
            : 'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)]'
        )}
        style={{
          border: '1px solid var(--md-sys-color-outline)',
        }}
        title={t('账户菜单')}
      >
        <Avatar
          size="sm"
          alt={user.username}
          src={
            user.avatar
              ? user.avatar
              : user.role === 'root'
                ? '/root-avatar.jpg'
                : undefined
          }
        />
        <span className="hidden sm:inline text-xs font-medium max-w-[8rem] truncate">
          {user.username}
        </span>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            className={cn(
              'glass-strong fixed w-52 rounded-[var(--md-sys-shape-corner)] p-1.5 shadow-lg',
              closing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
            )}
            style={{
              top: `${position.top}px`,
              right: `${position.right}px`,
              zIndex: 50,
              boxShadow:
                '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
            }}
          >
            <div
              className="zen-dropdown-item flex items-center gap-2 px-2.5 py-2 rounded-[var(--md-sys-shape-corner)]"
              style={
                {
                  backgroundColor: 'var(--glass-bg)',
                  '--item-delay': '0ms',
                } as CSSProperties
              }
            >
              <Avatar
                size="md"
                alt={user.username}
                src={
                  user.avatar
                    ? user.avatar
                    : user.role === 'root'
                      ? '/root-avatar.jpg'
                      : undefined
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[var(--md-sys-color-on-surface)] truncate">
                  {user.username}
                </p>
                <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  {user.role === 'root'
                    ? t('超级管理员')
                    : user.role === 'admin'
                      ? t('管理员')
                      : t('普通用户')}
                </p>
              </div>
            </div>

            <div
              className="h-px mx-1 my-1.5"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
              }}
            />

            {menuItems.map((item, idx) => {
              const content = (
                <>
                  <span className="text-[var(--md-sys-color-on-surface-variant)]">
                    {item.icon}
                  </span>
                  {item.label}
                </>
              )
              const className =
                'zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-on-surface)] transition-all hover:bg-[var(--md-sys-color-surface-container-highest)] hover:translate-x-0.5'
              const itemStyle = {
                '--item-delay': `${(idx + 1) * 50}ms`,
              } as CSSProperties
              return (
                <button
                  key={item.label}
                  onClick={() => {
                    onCloseNow()
                    if (!item.to) {
                      item.onClick?.()
                      return
                    }
                    // 房间内点击页面入口 → 新标签页打开：
                    // 不打断当前房间会话，也无需「离开房间」确认；
                    // 非房间页时保持常规应用内导航
                    if (needsGuard && NEW_TAB_NAV_PATHS.has(item.to)) {
                      window.open(item.to, '_blank')
                      return
                    }
                    guardNavigate(item.to)
                  }}
                  className={className}
                  style={itemStyle}
                >
                  {content}
                </button>
              )
            })}

            <div
              className="h-px mx-1 my-1.5"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
              }}
            />

            {user.role === 'guest' ? (
              <button
                onClick={() => {
                  onCloseNow()
                  guardNavigate('/login')
                }}
                className="zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-primary)] transition-all hover:bg-[var(--md-sys-color-primary-container)] hover:translate-x-0.5"
                style={
                  {
                    '--item-delay': `${(menuItems.length + 1) * 50}ms`,
                  } as CSSProperties
                }
              >
                <LogIn className="w-4 h-4" />
                登录
              </button>
            ) : (
              <button
                onClick={handleLogout}
                className="zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-error)] transition-all hover:bg-[var(--md-sys-color-error-container)] hover:translate-x-0.5"
                style={
                  {
                    '--item-delay': `${(menuItems.length + 1) * 50}ms`,
                  } as CSSProperties
                }
              >
                <LogOut className="w-4 h-4" />
                退出登录
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
