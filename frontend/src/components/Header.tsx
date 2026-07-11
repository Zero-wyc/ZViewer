import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  Palette,
  LogOut,
  Sun,
  Moon,
  Check,
  SlidersHorizontal,
  Shield,
  UserCircle,
  LayoutDashboard,
  ChevronDown,
} from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import {
  useThemeStore,
  RADIUS_PRESETS,
  type RadiusPreset,
} from '@/store/themeStore'
import { Avatar } from '@/components/ui/Avatar'
import { Slider } from '@/components/ui/Slider'
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
  } = useThemeStore()
  const [themeOpen, setThemeOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const themeRef = useRef<HTMLDivElement>(null)
  const userRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!themeOpen) return
    const handleClick = (e: MouseEvent) => {
      if (themeRef.current && !themeRef.current.contains(e.target as Node)) {
        setThemeOpen(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [themeOpen])

  useEffect(() => {
    if (!userOpen) return
    const handleClick = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserOpen(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [userOpen])

  const handleLogout = () => {
    setUserOpen(false)
    logout()
  }

  const menuItems: {
    icon: React.ReactNode
    label: string
    to?: string
    onClick?: () => void
  }[] = [
    {
      icon: <UserCircle className="w-4 h-4" />,
      label: '个人中心',
      to: '/profile',
    },
    {
      icon: <LayoutDashboard className="w-4 h-4" />,
      label: '房间列表',
      to: '/rooms',
    },
    ...(user?.role === 'admin'
      ? [
          {
            icon: <Shield className="w-4 h-4" />,
            label: '管理后台',
            to: '/admin',
          },
        ]
      : []),
  ]

  return (
    <>
      <header className="glass fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-3">
        <Link to="/" className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-[var(--md-sys-shape-corner)] flex items-center justify-center font-bold text-lg"
            style={{
              backgroundColor: 'var(--md-sys-color-primary)',
              color: 'var(--md-sys-color-on-primary)',
            }}
          >
            Z
          </div>
          <span className="font-semibold text-base text-[var(--md-sys-color-on-surface)]">
            ZViewer
          </span>
        </Link>

        <div className="flex items-center gap-1.5">
          <div className="relative" ref={themeRef}>
            <button
              onClick={() => setThemeOpen((v) => !v)}
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

            {themeOpen && (
              <div
                className="glass-strong absolute right-0 top-full mt-2 w-72 rounded-[var(--md-sys-shape-corner)] p-4 shadow-lg"
                style={{
                  boxShadow:
                    '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
                }}
              >
                {/* 深浅色切换 */}
                <button
                  onClick={() => setDark(!isDark)}
                  className="w-full flex items-center justify-between p-3 rounded-[var(--md-sys-shape-corner)] text-left transition-all hover:bg-[var(--md-sys-color-surface-container-highest)]"
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
                <div className="space-y-2">
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
                <div className="space-y-2">
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
                <div className="space-y-2 mt-3">
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
              </div>
            )}
          </div>

          {isAuthenticated && user && (
            <div className="relative" ref={userRef}>
              <button
                onClick={() => setUserOpen((v) => !v)}
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
                <Avatar size="sm" alt={user.username} />
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

              {userOpen && (
                <div
                  className="glass-strong absolute right-0 top-full mt-2 w-52 rounded-[var(--md-sys-shape-corner)] p-1.5 shadow-lg"
                  style={{
                    boxShadow:
                      '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
                  }}
                >
                  <div
                    className="flex items-center gap-2 px-2.5 py-2 rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      backgroundColor:
                        'var(--md-sys-color-surface-container-high)',
                    }}
                  >
                    <Avatar size="md" alt={user.username} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-[var(--md-sys-color-on-surface)] truncate">
                        {user.username}
                      </p>
                      <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                        {user.role === 'admin' ? '管理员' : '普通用户'}
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

                  {menuItems.map((item) => {
                    const content = (
                      <>
                        <span className="text-[var(--md-sys-color-on-surface-variant)]">
                          {item.icon}
                        </span>
                        {item.label}
                      </>
                    )
                    const className =
                      'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-on-surface)] transition-all hover:bg-[var(--md-sys-color-surface-container-highest)]'
                    return item.to ? (
                      <Link
                        key={item.label}
                        to={item.to}
                        onClick={() => setUserOpen(false)}
                        className={className}
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

                  <button
                    onClick={handleLogout}
                    className="flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-error)] transition-all hover:bg-[var(--md-sys-color-error-container)]"
                  >
                    <LogOut className="w-4 h-4" />
                    退出登录
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* 顶部占位，避免内容被 fixed header 遮挡 */}
      <div style={{ height: '64px' }} />
    </>
  )
}
