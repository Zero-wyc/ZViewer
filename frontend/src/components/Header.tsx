import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import {
  Palette,
  LogOut,
  LogIn,
  Sun,
  Moon,
  Check,
  SlidersHorizontal,
  Shield,
  UserCircle,
  LayoutDashboard,
  ChevronDown,
  Image,
  Sparkles,
} from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import {
  useThemeStore,
  RADIUS_PRESETS,
  type RadiusPreset,
} from '@/store/themeStore'
import { Avatar } from '@/components/ui/Avatar'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { BackgroundSettingsPanel } from '@/components/BackgroundSettingsPanel'
import { message } from '@/components/ui/message'
import { apiFetch, API_URL } from '@/lib/api'
import { PRESET_SEEDS } from '@/lib/themes'
import { cn } from '@/lib/utils'

export function Header() {
  const { user, logout, isAuthenticated } = useAuthStore()
  const {
    isDark,
    setDark,
    sourceColor,
    setSourceColor,
    radius,
    setRadius,
    glassStrength,
    setGlassStrength,
    reducedMotion,
    setReducedMotion,
  } = useThemeStore()
  const [themeOpen, setThemeOpen] = useState(false)
  const [themeClosing, setThemeClosing] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [userClosing, setUserClosing] = useState(false)
  const [backgroundModalOpen, setBackgroundModalOpen] = useState(false)
  // 按钮与菜单分别 ref：菜单通过 createPortal 渲染到 document.body，
  // 脱离 Header(fixed + backdrop-filter) 的合成层，使二级菜单的 backdrop-filter 能看到真实页面内容。
  const themeBtnRef = useRef<HTMLButtonElement>(null)
  const themeMenuRef = useRef<HTMLDivElement>(null)
  const userBtnRef = useRef<HTMLButtonElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const backgroundBtnRef = useRef<HTMLButtonElement>(null)
  // 菜单 fixed 定位坐标（基于按钮 getBoundingClientRect 计算）
  const [themeMenuPos, setThemeMenuPos] = useState<{
    top: number
    right: number
  } | null>(null)
  const [userMenuPos, setUserMenuPos] = useState<{
    top: number
    right: number
  } | null>(null)

  const closeTheme = () => {
    setThemeClosing(true)
    const timer = setTimeout(() => {
      setThemeOpen(false)
      setThemeClosing(false)
      setThemeMenuPos(null)
    }, 200)
    return () => clearTimeout(timer)
  }

  const closeUser = () => {
    setUserClosing(true)
    const timer = setTimeout(() => {
      setUserOpen(false)
      setUserClosing(false)
      setUserMenuPos(null)
    }, 200)
    return () => clearTimeout(timer)
  }

  // 计算主题菜单位置：右边缘与按钮对齐，顶部在按钮下方 8px
  const computeThemePos = useCallback(() => {
    if (!themeBtnRef.current) return
    const rect = themeBtnRef.current.getBoundingClientRect()
    setThemeMenuPos({
      top: rect.bottom + 8,
      right: window.innerWidth - rect.right,
    })
  }, [])

  const computeUserPos = useCallback(() => {
    if (!userBtnRef.current) return
    const rect = userBtnRef.current.getBoundingClientRect()
    setUserMenuPos({
      top: rect.bottom + 8,
      right: window.innerWidth - rect.right,
    })
  }, [])

  // 菜单打开时计算位置，并监听 resize/scroll 保持对齐
  useEffect(() => {
    if (!themeOpen) return
    computeThemePos()
    const handler = () => computeThemePos()
    window.addEventListener('resize', handler)
    window.addEventListener('scroll', handler, true)
    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('scroll', handler, true)
    }
  }, [themeOpen, computeThemePos])

  useEffect(() => {
    if (!userOpen) return
    computeUserPos()
    const handler = () => computeUserPos()
    window.addEventListener('resize', handler)
    window.addEventListener('scroll', handler, true)
    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('scroll', handler, true)
    }
  }, [userOpen, computeUserPos])

  // 外部点击检测：按钮和菜单（portal 渲染）都不算外部
  useEffect(() => {
    if (!themeOpen) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        themeBtnRef.current?.contains(target) ||
        themeMenuRef.current?.contains(target)
      ) {
        return
      }
      closeTheme()
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [themeOpen])

  useEffect(() => {
    if (!userOpen) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        userBtnRef.current?.contains(target) ||
        userMenuRef.current?.contains(target)
      ) {
        return
      }
      closeUser()
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [userOpen])

  const handleLogout = async () => {
    setUserOpen(false)
    try {
      // 调用后端清除 httpOnly cookie（access_token / refresh_token）
      await apiFetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
      })
    } catch (err) {
      // 后端调用失败也继续登出前端状态，避免用户卡在已登录状态
      console.warn('[Header] logout API failed:', err)
      message.error('退出登录请求失败，已强制清除本地状态')
    } finally {
      logout()
    }
  }

  const menuItems: {
    icon: React.ReactNode
    label: string
    to?: string
    onClick?: () => void
  }[] = [
    ...(user?.role !== 'guest'
      ? [
          {
            icon: <UserCircle className="w-4 h-4" />,
            label: '个人中心',
            to: '/profile',
          },
        ]
      : []),
    {
      icon: <LayoutDashboard className="w-4 h-4" />,
      label: '房间列表',
      to: '/rooms',
    },
    ...(user?.role === 'admin' || user?.role === 'root'
      ? [
          {
            icon: <Shield className="w-4 h-4" />,
            label: '权限管理',
            to: '/admin',
          },
        ]
      : []),
  ]

  return (
    <>
      <header className="glass fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-3">
        <Link to="/" className="relative z-50 flex items-center gap-2">
          <img
            src="/favicon.jpg"
            alt="ZViewer"
            className="w-8 h-8 rounded-[var(--md-sys-shape-corner)] object-cover"
          />
          <span className="font-semibold text-base text-[var(--md-sys-color-on-surface)]">
            ZViewer
          </span>
        </Link>

        <div className="flex items-center gap-1.5">
          <div className="relative">
            <button
              ref={themeBtnRef}
              onClick={() => {
                if (themeOpen) {
                  closeTheme()
                } else {
                  setThemeOpen(true)
                  setThemeClosing(false)
                }
              }}
              className={cn(
                'p-2 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]',
                themeOpen
                  ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                  : 'bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)]'
              )}
              style={{
                border: '1px solid var(--md-sys-color-outline)',
              }}
              title="主题设置"
            >
              <Palette className="w-4 h-4" />
            </button>

            {themeOpen &&
              themeMenuPos &&
              createPortal(
                <div
                  ref={themeMenuRef}
                  className={cn(
                    'glass-strong fixed w-72 rounded-[var(--md-sys-shape-corner)] p-4 shadow-lg',
                    themeClosing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
                  )}
                  style={{
                    top: `${themeMenuPos.top}px`,
                    right: `${themeMenuPos.right}px`,
                    zIndex: 50,
                    boxShadow:
                      '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
                  }}
                >
                  {/* 深浅色切换 */}
                  <button
                    onClick={() => setDark(!isDark)}
                    className="zen-dropdown-item w-full flex items-center justify-between p-3 rounded-[var(--md-sys-shape-corner)] text-left transition-all hover:bg-[var(--md-sys-color-surface-container-highest)] hover:translate-x-0.5"
                    style={{ '--item-delay': '0ms' } as React.CSSProperties}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm"
                        style={{
                          backgroundColor: isDark
                            ? 'var(--md-sys-color-surface-container-highest)'
                            : 'var(--md-sys-color-surface-container-high)',
                          border: '1px solid var(--md-sys-color-outline)',
                        }}
                      >
                        {isDark ? (
                          <Moon
                            className="w-4 h-4"
                            style={{ color: 'var(--md-sys-color-on-surface)' }}
                          />
                        ) : (
                          <Sun
                            className="w-4 h-4"
                            style={{ color: 'var(--md-sys-color-primary)' }}
                          />
                        )}
                      </span>
                      <div>
                        <span className="font-medium text-sm text-[var(--md-sys-color-on-surface)]">
                          {isDark ? '深色模式' : '浅色模式'}
                        </span>
                        <p className="text-xs mt-0.5 text-[var(--md-sys-color-on-surface-variant)]">
                          点击切换明暗主题
                        </p>
                      </div>
                    </div>
                    <div
                      className="w-9 h-5 rounded-full relative transition-colors"
                      style={{
                        backgroundColor: isDark
                          ? 'var(--md-sys-color-primary)'
                          : 'var(--md-sys-color-outline-variant)',
                      }}
                    >
                      <span
                        className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                        style={{
                          backgroundColor: 'var(--md-sys-color-surface)',
                          left: isDark ? '18px' : '2px',
                        }}
                      />
                    </div>
                  </button>

                  <div
                    className="h-px mx-1 my-3"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                    }}
                  />

                  {/* 种子色预设 */}
                  <div
                    className="zen-dropdown-item space-y-2"
                    style={{ '--item-delay': '60ms' } as React.CSSProperties}
                  >
                    <span className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] flex items-center gap-1.5">
                      <Palette className="w-3.5 h-3.5" />
                      主题色
                    </span>
                    <div className="grid grid-cols-4 gap-2">
                      {PRESET_SEEDS.map((seed) => {
                        const active = sourceColor === seed.color
                        return (
                          <button
                            key={seed.id}
                            onClick={() => setSourceColor(seed.color)}
                            className={cn(
                              'flex flex-col items-center gap-1 rounded-[var(--md-sys-shape-corner)] p-1.5 transition-all hover:bg-[var(--md-sys-color-surface-container-highest)]',
                              active &&
                                'bg-[var(--md-sys-color-primary-container)]'
                            )}
                            title={seed.name}
                          >
                            <span
                              className="w-6 h-6 rounded-full border"
                              style={{
                                backgroundColor: seed.color,
                                borderColor: active
                                  ? 'var(--md-sys-color-primary)'
                                  : 'var(--md-sys-color-outline)',
                              }}
                            >
                              {active && (
                                <Check
                                  className="w-3.5 h-3.5 mx-auto mt-1"
                                  style={{
                                    color: 'var(--md-sys-color-on-primary)',
                                  }}
                                />
                              )}
                            </span>
                            <span className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                              {seed.name}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div
                    className="h-px mx-1 my-3"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                    }}
                  />

                  {/* 圆角预设 */}
                  <div
                    className="zen-dropdown-item space-y-2"
                    style={{ '--item-delay': '120ms' } as React.CSSProperties}
                  >
                    <span className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] flex items-center gap-1.5">
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      圆角
                    </span>
                    <div className="grid grid-cols-4 gap-2">
                      {RADIUS_PRESETS.map((preset) => {
                        const active = radius === preset.value
                        return (
                          <button
                            key={preset.value}
                            onClick={() =>
                              setRadius(preset.value as RadiusPreset)
                            }
                            className={cn(
                              'flex flex-col items-center gap-1 rounded-[var(--md-sys-shape-corner)] p-1.5 text-xs transition-all hover:bg-[var(--md-sys-color-surface-container-highest)]',
                              active &&
                                'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                            )}
                          >
                            <span
                              className="h-5 w-8 border-2 border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)]"
                              style={{ borderRadius: `${preset.px}px` }}
                            />
                            <span>{preset.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* 玻璃强度滑块 */}
                  <div
                    className="zen-dropdown-item space-y-2 mt-3"
                    style={{ '--item-delay': '180ms' } as React.CSSProperties}
                  >
                    <Slider
                      label="玻璃浓度"
                      value={Math.round(glassStrength * 100)}
                      min={0}
                      max={100}
                      step={1}
                      valueFormatter={(v) => `${v}%`}
                      onChange={(v) => setGlassStrength(v / 100)}
                    />
                  </div>

                  {/* 精简动画开关 */}
                  <div
                    className="zen-dropdown-item mt-3 flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)]"
                    style={
                      {
                        border: '1px solid var(--md-sys-color-outline)',
                        '--item-delay': '220ms',
                      } as React.CSSProperties
                    }
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Sparkles className="w-4 h-4 text-[var(--md-sys-color-primary)] shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm text-[var(--md-sys-color-on-surface)] truncate">
                          精简动画
                        </p>
                        <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)] truncate">
                          关闭后启用华丽效果
                        </p>
                      </div>
                    </div>
                    <Switch
                      checked={reducedMotion}
                      onChange={(e) => setReducedMotion(e.target.checked)}
                    />
                  </div>

                  {/* 自定义背景入口 */}
                  <button
                    ref={backgroundBtnRef}
                    onClick={() => setBackgroundModalOpen(true)}
                    className="zen-dropdown-item mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-on-surface)] transition-all hover:bg-[var(--md-sys-color-surface-container-highest)] hover:translate-x-0.5"
                    style={
                      {
                        border: '1px solid var(--md-sys-color-outline)',
                        '--item-delay': '260ms',
                      } as React.CSSProperties
                    }
                  >
                    <Image className="w-4 h-4 text-[var(--md-sys-color-primary)]" />
                    <span className="flex-1 text-left">自定义背景</span>
                  </button>
                </div>,
                document.body
              )}
          </div>

          {isAuthenticated && user && (
            <div className="relative">
              <button
                ref={userBtnRef}
                onClick={() => {
                  if (userOpen) {
                    closeUser()
                  } else {
                    setUserOpen(true)
                    setUserClosing(false)
                  }
                }}
                className={cn(
                  'flex items-center gap-2 pl-2 pr-2.5 py-1.5 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]',
                  userOpen
                    ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                    : 'bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)]'
                )}
                style={{
                  border: '1px solid var(--md-sys-color-outline)',
                }}
                title="账户菜单"
              >
                <Avatar
                  size="sm"
                  alt={user.username}
                  src={user.role === 'root' ? '/root-avatar.jpg' : undefined}
                />
                <span className="hidden sm:inline text-xs font-medium max-w-[8rem] truncate">
                  {user.username}
                </span>
                <ChevronDown
                  className={cn(
                    'w-3.5 h-3.5 transition-transform duration-200',
                    userOpen && 'rotate-180'
                  )}
                />
              </button>

              {userOpen &&
                userMenuPos &&
                createPortal(
                  <div
                    ref={userMenuRef}
                    className={cn(
                      'glass-strong fixed w-52 rounded-[var(--md-sys-shape-corner)] p-1.5 shadow-lg',
                      userClosing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
                    )}
                    style={{
                      top: `${userMenuPos.top}px`,
                      right: `${userMenuPos.right}px`,
                      zIndex: 50,
                      boxShadow:
                        '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
                    }}
                  >
                    <div
                      className="zen-dropdown-item flex items-center gap-2 px-2.5 py-2 rounded-[var(--md-sys-shape-corner)]"
                      style={
                        {
                          backgroundColor:
                            'var(--md-sys-color-surface-container-high)',
                          '--item-delay': '0ms',
                        } as React.CSSProperties
                      }
                    >
                      <Avatar
                        size="md"
                        alt={user.username}
                        src={
                          user.role === 'root' ? '/root-avatar.jpg' : undefined
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[var(--md-sys-color-on-surface)] truncate">
                          {user.username}
                        </p>
                        <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                          {user.role === 'root'
                            ? '超级管理员'
                            : user.role === 'admin'
                              ? '管理员'
                              : '普通用户'}
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
                      } as React.CSSProperties
                      return item.to ? (
                        <Link
                          key={item.label}
                          to={item.to}
                          onClick={() => setUserOpen(false)}
                          className={className}
                          style={itemStyle}
                        >
                          {content}
                        </Link>
                      ) : (
                        <button
                          key={item.label}
                          onClick={() => {
                            setUserOpen(false)
                            item.onClick?.()
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
                      <Link
                        to="/login"
                        onClick={() => setUserOpen(false)}
                        className="zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-primary)] transition-all hover:bg-[var(--md-sys-color-primary-container)] hover:translate-x-0.5"
                        style={
                          {
                            '--item-delay': `${(menuItems.length + 1) * 50}ms`,
                          } as React.CSSProperties
                        }
                      >
                        <LogIn className="w-4 h-4" />
                        登录
                      </Link>
                    ) : (
                      <button
                        onClick={handleLogout}
                        className="zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-error)] transition-all hover:bg-[var(--md-sys-color-error-container)] hover:translate-x-0.5"
                        style={
                          {
                            '--item-delay': `${(menuItems.length + 1) * 50}ms`,
                          } as React.CSSProperties
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
          )}
        </div>
      </header>

      {/* 顶部占位，避免内容被 fixed header 遮挡 */}
      <div style={{ height: '64px' }} />

      <BackgroundSettingsPanel
        open={backgroundModalOpen}
        onClose={() => setBackgroundModalOpen(false)}
        anchorRef={backgroundBtnRef}
      />
    </>
  )
}
