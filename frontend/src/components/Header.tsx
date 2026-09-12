import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Palette,
  LogOut,
  LogIn,
  Sun,
  Moon,
  Check,
  SlidersHorizontal,
  Shield,
  ShieldAlert,
  Info,
  UserCircle,
  LayoutDashboard,
  ChevronDown,
  Image,
  Sparkles,
  MousePointerClick,
  Download,
  Server,
} from 'lucide-react'
// lucide-react 没有导出 Github，使用自定义 SVG
const GithubIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
    <path d="M9 18c-4.51 2-5-2-7-2" />
  </svg>
)
import { useAuthStore } from '@/store/authStore'
import { useRoomStore } from '@/store/roomStore'
import {
  apiFetch,
  getCustomApiUrl,
  setCustomApiUrl,
  getCustomSocketUrl,
  setCustomSocketUrl,
  getCustomFlvBaseUrl,
  setCustomFlvBaseUrl,
  getCustomRtmpPort,
  setCustomRtmpPort,
  getApiUrl,
  getSocketUrl,
  getFlvBaseUrl,
  getRtmpPort,
  clearAuthTokens,
  resetSessionExpired,
} from '@/lib/api'
import { resetSocket, reconnectSocket } from '@/hooks/useSocket'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { message } from '@/components/ui/message'
import {
  useThemeStore,
  RADIUS_PRESETS,
  type RadiusPreset,
} from '@/store/themeStore'
import { Avatar } from '@/components/ui/Avatar'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { BackgroundSettingsPanel } from '@/components/BackgroundSettingsPanel'
import { PRESET_SEEDS } from '@/lib/themes'
import { cn } from '@/lib/utils'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'

export function Header() {
  const {
    guardNavigate,
    confirmModal: exitGuardModal,
    needsGuard,
  } = useRoomExitGuard()
  const roomMode = useRoomStore((s) => s.mode)
  /** 一起听模式（沉浸）：全局顶栏默认隐藏，顶部中间横条触发显示 */
  const immersive = roomMode === 'listen-together'
  /** 鼠标悬停触发的显示状态 */
  const [hoverVisible, setHoverVisible] = useState(false)
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
    glassBlur,
    setGlassBlur,
    reducedMotion,
    setReducedMotion,
    disableHoverTransform,
    setDisableHoverTransform,
  } = useThemeStore()
  const [themeOpen, setThemeOpen] = useState(false)
  const [themeClosing, setThemeClosing] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [userClosing, setUserClosing] = useState(false)
  const [backgroundModalOpen, setBackgroundModalOpen] = useState(false)
  const [serverModalOpen, setServerModalOpen] = useState(false)

  // 任一菜单/弹窗打开时锁定顶栏（鼠标移动到 portal 内容会触发根元素
  // mouseleave，不锁定会把还开着的菜单连顶栏一起收走）
  const menuLocked =
    themeOpen ||
    themeClosing ||
    userOpen ||
    userClosing ||
    backgroundModalOpen ||
    serverModalOpen
  const headerShown = !immersive || hoverVisible || menuLocked

  // 菜单/弹窗全部关闭后复位悬停显隐：菜单开启期间根元素 mouseleave 被抑制，
  // 用户在屏幕中部用外部点击关闭菜单（或菜单内向 portal 区域外移动鼠标）时
  // 不会产生 mouseleave 事件，hoverVisible 会残留 true，导致顶栏在二级菜单
  // 收回后不再自动隐藏。因此 menuLocked 从 true → false 时强制收起一次。
  const wasMenuLockedRef = useRef(false)
  useEffect(() => {
    if (menuLocked) {
      wasMenuLockedRef.current = true
      return
    }
    if (wasMenuLockedRef.current) {
      wasMenuLockedRef.current = false
      setHoverVisible(false)
    }
  }, [menuLocked])

  const [customApiUrl, setCustomApiUrlState] = useState(getCustomApiUrl())
  const [customSocketUrl, setCustomSocketUrlState] =
    useState(getCustomSocketUrl())
  const [customFlvBaseUrl, setCustomFlvBaseUrlState] = useState(
    getCustomFlvBaseUrl()
  )
  const [customRtmpPort, setCustomRtmpPortState] = useState(getCustomRtmpPort())

  // 打开「自定义后端地址」弹窗时从 localStorage 重新同步，
  // 避免同一页面会话中保存后再次打开仍显示旧值。
  const openServerModal = useCallback(() => {
    setCustomApiUrlState(getCustomApiUrl())
    setCustomSocketUrlState(getCustomSocketUrl())
    setCustomFlvBaseUrlState(getCustomFlvBaseUrl())
    setCustomRtmpPortState(getCustomRtmpPort())
    setServerModalOpen(true)
  }, [])

  // 混合内容检测：HTTPS 页面 → HTTP 后端（浏览器会阻止此类请求）
  const isApiHttp = customApiUrl.startsWith('http://')
  const isSocketHttp = customSocketUrl.startsWith('http://')
  const isHttpsPage =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
  const hasMixedContent = isHttpsPage && (isApiHttp || isSocketHttp)

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
      await apiFetch('/api/auth/logout', {
        method: 'POST',
      })
    } catch (err) {
      // 后端调用失败也继续登出前端状态，避免用户卡在已登录状态
      console.warn('[Header] logout API failed:', err)
      message.error('退出登录请求失败，已强制清除本地状态')
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

  const handleDownloadCli = useCallback(() => {
    const ua = navigator.userAgent.toLowerCase()
    const isWindows = /windows nt|win32|win64/.test(ua)
    const isMac = /macintosh|mac os x/.test(ua)
    const isLinux = /linux/.test(ua)
    if (isWindows) {
      const a = document.createElement('a')
      a.href = '/zviewer-cli-windows-amd64.exe'
      a.download = 'zviewer-cli-windows-amd64.exe'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } else if (isMac || isLinux) {
      window.open(
        'https://github.com/Zero-wyc/ZViewerCLI',
        '_blank',
        'noopener,noreferrer'
      )
    } else {
      message.info(
        '请前往 https://github.com/Zero-wyc/ZViewerCLI 下载对应版本 CLI'
      )
    }
  }, [])

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

  /** 房间内点击这些页面入口时改为新标签页打开（不打断房间会话，无需离开确认） */
  const NEW_TAB_NAV_PATHS = new Set(['/profile', '/rooms', '/admin'])

  return (
    <>
      {/* 一起听模式触发横条：顶栏隐藏时常驻顶部中间，hover / 点击展开顶栏；
          顶栏显示后隐藏（避免色块压在顶栏上）。z-[39] 低于完整播放器覆盖层
          （MusicAppShell z-40）：播放器页打开时横条被盖住，不再悬浮其上 */}
      {immersive && !headerShown && (
        <button
          type="button"
          aria-label="显示顶栏"
          className="fixed left-1/2 top-0 z-[39] h-1.5 w-36 -translate-x-1/2 rounded-b-[4px] transition-all duration-300 hover:h-2"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 25%, transparent)',
          }}
          onMouseEnter={() => setHoverVisible(true)}
          onClick={() => setHoverVisible(true)}
        />
      )}
      <header
        className={cn(
          'glass fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-3 transition-transform duration-300 ease-[cubic-bezier(0.14,0.91,0.58,1)]',
          immersive && !headerShown && '-translate-y-full'
        )}
        onMouseEnter={() => setHoverVisible(true)}
        onMouseLeave={() => {
          if (!menuLocked) setHoverVisible(false)
        }}
      >
        <button
          onClick={() => guardNavigate('/')}
          className="relative z-50 flex items-center gap-2 cursor-pointer"
        >
          <img
            src="/favicon.jpg"
            alt="ZViewer"
            className="w-8 h-8 rounded-[var(--md-sys-shape-corner)] object-cover"
          />
          <span className="font-semibold text-base text-[var(--md-sys-color-on-surface)]">
            ZViewer
          </span>
        </button>

        <div className="flex items-center gap-1.5">
          <a
            href="https://github.com/Zero-wyc/ZViewer"
            target="_blank"
            rel="noopener noreferrer"
            className="p-2 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]"
            style={{
              border: '1px solid var(--md-sys-color-outline)',
            }}
            title="GitHub 仓库"
          >
            <GithubIcon className="w-4 h-4" />
          </a>
          <button
            type="button"
            onClick={handleDownloadCli}
            className="p-2 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]"
            style={{
              border: '1px solid var(--md-sys-color-outline)',
            }}
            title="下载 CLI 高画质代理"
          >
            <Download className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={openServerModal}
            className="p-2 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]"
            style={{
              border: '1px solid var(--md-sys-color-outline)',
            }}
            title="自定义后端地址"
          >
            <Server className="w-4 h-4" />
          </button>

          <div className="relative">
            <button
              ref={themeBtnRef}
              onClick={() => {
                if (themeOpen) {
                  closeTheme()
                } else {
                  setThemeOpen(true)
                  setThemeClosing(false)
                  // 默认显示主面板，不保留上次打开的自定义背景侧面板
                  setBackgroundModalOpen(false)
                }
              }}
              className={cn(
                'p-2 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]',
                themeOpen
                  ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                  : 'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)]'
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
                    'glass fixed flex overflow-hidden rounded-[var(--md-sys-shape-corner)] shadow-lg',
                    themeClosing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
                  )}
                  style={{
                    top: `${themeMenuPos.top}px`,
                    right: `${themeMenuPos.right}px`,
                    zIndex: 50,
                    height: 'min(590px, calc(100vh - 32px))',
                    // 容器宽度由子元素决定，不单独动画 width，避免与侧面板的 width 动画不同步导致抖动
                    backdropFilter: 'blur(var(--glass-blur-strong))',
                    WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
                    boxShadow:
                      '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
                  }}
                >
                  <BackgroundSettingsPanel
                    open={backgroundModalOpen}
                    onClose={() => setBackgroundModalOpen(false)}
                  />
                  <div className="h-full w-72 flex-shrink-0 overflow-y-auto px-4 pt-4 pb-2">
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
                            backgroundColor: 'var(--glass-bg)',
                            border: '1px solid var(--md-sys-color-outline)',
                          }}
                        >
                          {isDark ? (
                            <Moon
                              className="w-4 h-4"
                              style={{
                                color: 'var(--md-sys-color-on-surface)',
                              }}
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
                                className="h-5 w-8 border-2 border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)]"
                                style={{ borderRadius: `${preset.px}px` }}
                              />
                              <span>{preset.label}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    {/* 玻璃透明度 + 模糊度滑块 */}
                    <div
                      className="zen-dropdown-item space-y-2 mt-3"
                      style={{ '--item-delay': '180ms' } as React.CSSProperties}
                    >
                      <Slider
                        label="玻璃透明度"
                        value={Math.round(glassStrength * 100)}
                        min={0}
                        max={100}
                        step={1}
                        valueFormatter={(v) => `${v}%`}
                        onChange={(v) => setGlassStrength(v / 100)}
                        disabled={reducedMotion}
                      />
                      <Slider
                        label="卡片模糊度"
                        value={glassBlur}
                        min={0}
                        max={40}
                        step={1}
                        valueFormatter={(v) => `${v}px`}
                        onChange={(v) => setGlassBlur(v)}
                        disabled={reducedMotion}
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

                    {/* 禁用全局 hover 位移开关 */}
                    <div
                      className="zen-dropdown-item mt-3 flex items-center justify-between gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)]"
                      style={
                        {
                          border: '1px solid var(--md-sys-color-outline)',
                          '--item-delay': '260ms',
                        } as React.CSSProperties
                      }
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <MousePointerClick className="w-4 h-4 text-[var(--md-sys-color-primary)] shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm text-[var(--md-sys-color-on-surface)] truncate">
                            禁用 hover 位移
                          </p>
                          <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)] truncate">
                            关闭悬浮上浮/缩放效果
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={disableHoverTransform}
                        onChange={(e) =>
                          setDisableHoverTransform(e.target.checked)
                        }
                      />
                    </div>

                    {/* 自定义背景入口 */}
                    <button
                      ref={backgroundBtnRef}
                      onClick={() => setBackgroundModalOpen((v) => !v)}
                      className={cn(
                        'zen-dropdown-item mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)] text-sm transition-all hover:translate-x-0.5',
                        backgroundModalOpen
                          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-[var(--md-sys-color-primary)]'
                          : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                      )}
                      style={
                        {
                          border: '1px solid var(--md-sys-color-outline)',
                          '--item-delay': '300ms',
                        } as React.CSSProperties
                      }
                    >
                      <Image className="w-4 h-4 text-[var(--md-sys-color-primary)]" />
                      <span className="flex-1 text-left">自定义背景</span>
                    </button>
                  </div>
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
                    : 'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)]'
                )}
                style={{
                  border: '1px solid var(--md-sys-color-outline)',
                }}
                title="账户菜单"
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
                      'glass-strong fixed w-56 rounded-[20px] p-2',
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
                      className="zen-dropdown-item flex items-center gap-3 px-3 py-3 rounded-[14px]"
                      style={
                        {
                          backgroundColor:
                            'var(--md-sys-color-surface-container-highest)',
                          border:
                            '1px solid color-mix(in srgb, var(--md-sys-color-outline) 25%, transparent)',
                          boxShadow:
                            '0 2px 10px -4px color-mix(in srgb, var(--md-sys-color-primary) 20%, transparent)',
                          '--item-delay': '0ms',
                        } as React.CSSProperties
                      }
                    >
                      <Avatar
                        size="lg"
                        className="ring-2 ring-[color-mix(in_srgb,var(--md-sys-color-surface-bright)_80%,transparent)] ring-offset-1 ring-offset-[var(--md-sys-color-surface-container-highest)]"
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
                        <p className="text-sm font-semibold text-[var(--md-sys-color-on-surface)] truncate">
                          {user.username}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                          {user.role === 'root'
                            ? '超级管理员'
                            : user.role === 'admin'
                              ? '管理员'
                              : '普通用户'}
                        </p>
                      </div>
                    </div>

                    <div
                      className="h-px mx-2 my-2"
                      style={{
                        backgroundColor:
                          'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                      }}
                    />

                    {menuItems.map((item, idx) => {
                      const content = (
                        <>
                          <span className="text-[var(--md-sys-color-primary)]">
                            {item.icon}
                          </span>
                          {item.label}
                        </>
                      )
                      const className =
                        'zen-dropdown-item flex items-center gap-3 w-full px-3 py-2.5 rounded-[12px] text-sm text-[var(--md-sys-color-on-surface)] transition-all hover:bg-[var(--md-sys-color-surface-container-highest)] hover:translate-x-0.5'
                      const itemStyle = {
                        '--item-delay': `${(idx + 1) * 50}ms`,
                      } as React.CSSProperties
                      return (
                        <button
                          key={item.label}
                          onClick={() => {
                            setUserOpen(false)
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
                      className="h-px mx-2 my-2"
                      style={{
                        backgroundColor:
                          'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                      }}
                    />

                    {user.role === 'guest' ? (
                      <button
                        onClick={() => {
                          setUserOpen(false)
                          guardNavigate('/login')
                        }}
                        className="zen-dropdown-item flex items-center gap-3 w-full px-3 py-2.5 rounded-[12px] text-sm text-[var(--md-sys-color-primary)] transition-all hover:bg-[var(--md-sys-color-primary-container)] hover:translate-x-0.5"
                        style={
                          {
                            '--item-delay': `${(menuItems.length + 1) * 50}ms`,
                          } as React.CSSProperties
                        }
                      >
                        <LogIn className="w-4 h-4" />
                        登录
                      </button>
                    ) : (
                      <button
                        onClick={handleLogout}
                        className="zen-dropdown-item flex items-center gap-3 w-full px-3 py-2.5 rounded-[12px] text-sm text-[var(--md-sys-color-error)] transition-all hover:bg-[var(--md-sys-color-error-container)] hover:translate-x-0.5"
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

      {/* 顶部占位，避免内容被 fixed header 遮挡。听模式沉浸不占位：顶栏
          悬浮显示不推挤内容（translate 动画），取消占位让 h-screen 底板
          （含播放器覆盖层）真正从视口顶部开始 */}
      {!immersive && <div style={{ height: '64px' }} />}

      <Modal
        open={serverModalOpen}
        onClose={() => setServerModalOpen(false)}
        title="自定义后端地址"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setServerModalOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setCustomApiUrl(customApiUrl)
                setCustomSocketUrl(customSocketUrl)
                setCustomFlvBaseUrl(customFlvBaseUrl)
                setCustomRtmpPort(customRtmpPort)
                // 地址变化后，旧的 socket 实例仍指向原 SOCKET_URL，强制重建。
                resetSocket()
                if (hasMixedContent) {
                  message.warning(
                    '已保存，但 HTTPS 页面无法访问 HTTP 后端。请配置反向代理或后端 HTTPS。'
                  )
                } else {
                  message.success('后端地址已保存，即将刷新页面生效')
                }
                setServerModalOpen(false)
                // 刷新页面确保所有模块级 API_URL 缓存重新计算
                setTimeout(() => window.location.reload(), 600)
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div
            className="rounded-lg p-3"
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
            }}
          >
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--md-sys-color-primary)]" />
              <div className="space-y-1.5 text-xs leading-relaxed text-[var(--md-sys-color-on-surface-variant)]">
                <p className="font-medium text-[var(--md-sys-color-on-surface)]">
                  只需填写一个域名即可
                </p>
                <p>
                  填写你的服务器域名（例如{' '}
                  <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                    example.com
                  </code>
                  ），其余三项留空将自动跟随。请确保已在服务器上配置反向代理（Nginx
                  / Caddy），将以下路径统一转发到后端服务：
                </p>
                <ul className="ml-1 list-inside list-disc space-y-0.5">
                  <li>
                    <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                      /api/*
                    </code>{' '}
                    → REST API（端口 3333）
                  </li>
                  <li>
                    <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                      /socket.io/*
                    </code>{' '}
                    → WebSocket 信令（端口 3333）
                  </li>
                  <li>
                    <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                      /live/*
                    </code>{' '}
                    → HTTP-FLV 拉流（端口 3335）
                  </li>
                </ul>
                <p>
                  反向代理需启用 HTTPS（SSL 证书），否则 HTTPS
                  页面下的连接会被浏览器阻止。
                </p>
              </div>
            </div>
          </div>

          <Input
            label="服务器域名"
            value={customApiUrl}
            onChange={(e) => setCustomApiUrlState(e.target.value)}
            placeholder="例如: example.com"
            size="md"
          />
          <details className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <summary className="cursor-pointer select-none font-medium">
              高级设置（通常无需修改）
            </summary>
            <div className="mt-3 space-y-3">
              <Input
                label="WebSocket / 信令地址（留空则跟随上方域名）"
                value={customSocketUrl}
                onChange={(e) => setCustomSocketUrlState(e.target.value)}
                placeholder="留空即可"
                size="md"
              />
              <Input
                label="HTTP-FLV 拉流基础地址（留空则自动推断）"
                value={customFlvBaseUrl}
                onChange={(e) => setCustomFlvBaseUrlState(e.target.value)}
                placeholder="留空即可"
                size="md"
              />
              <Input
                label="RTMP 推流端口（留空则使用默认 3334）"
                value={customRtmpPort}
                onChange={(e) => setCustomRtmpPortState(e.target.value)}
                placeholder="留空即可"
                size="md"
              />
            </div>
          </details>
          <div className="space-y-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <p>
              当前 API 地址:{' '}
              <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
                {getApiUrl()}
              </code>
            </p>
            <p>
              当前 WebSocket 地址:{' '}
              <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
                {getSocketUrl()}
              </code>
            </p>
            <p>
              当前 FLV 基础地址:{' '}
              <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
                {getFlvBaseUrl() || '(相对路径 /live)'}
              </code>
            </p>
            <p>
              当前 RTMP 端口:{' '}
              <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
                {getRtmpPort()}
              </code>
            </p>
          </div>

          {hasMixedContent && (
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: 'var(--md-sys-color-error)',
                backgroundColor:
                  'rgba(var(--md-sys-color-error-container-rgb, 249, 233, 232), 0.95)',
                color: 'var(--md-sys-color-on-error-container)',
              }}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>检测到混合内容（HTTPS → HTTP）</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed">
                当前页面为 HTTPS，但后端地址为 HTTP。浏览器会阻止 HTTPS
                页面发起的 HTTP 请求，API 和 WebSocket 连接均无法正常工作。
              </p>
              <p className="mt-2 text-xs font-medium">推荐方案：</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
                <li>
                  使用反向代理（Nginx / Caddy）统一提供
                  HTTPS，后端通过反向代理访问
                </li>
                <li>或为后端 Express 服务直接配置 HTTPS 证书</li>
                <li>
                  或使用 Docker 部署，前端 Nginx 自动代理 /api 和 /socket.io
                  到后端
                </li>
              </ul>
            </div>
          )}

          <div className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            提示：留空将使用环境变量或页面默认值，保存后会自动刷新页面使配置生效。
          </div>
        </div>
      </Modal>

      {/* 离开房间确认对话框 */}
      {exitGuardModal}
    </>
  )
}
