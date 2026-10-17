import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Palette,
  LogOut,
  LogIn,
  Sun,
  Moon,
  SlidersHorizontal,
  Shield,
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
import { apiFetch, clearAuthTokens, resetSessionExpired } from '@/lib/api'
import { reconnectSocket } from '@/hooks/useSocket'
import { useIsMobile } from '@/hooks/useMediaQuery'
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
import { CustomColorPanel } from '@/components/CustomColorPanel'
import { cn } from '@/lib/utils'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'
import { AnnouncementButton } from '@/components/Announcement'
import { ServerUrlModal } from '@/components/header/ServerUrlModal'

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
  const isMobile = useIsMobile()
  const {
    isDark,
    setDark,
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
  /** 自定义主题色编辑栏：默认收起，点主面板「自定义主题」按钮展开，
      仅当自定义背景面板展开时暂时收起（二者互斥防宽度溢出） */
  const [themeOpen, setThemeOpen] = useState(false)
  const [themeClosing, setThemeClosing] = useState(false)
  const [customColorOpen, setCustomColorOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [userClosing, setUserClosing] = useState(false)
  const [backgroundModalOpen, setBackgroundModalOpen] = useState(false)
  const [serverModalOpen, setServerModalOpen] = useState(false)
  /** 公告面板开闭（AnnouncementButton 回传）：沉浸模式下锁定顶栏显隐 */
  const [announceOpen, setAnnounceOpen] = useState(false)

  // 任一菜单/弹窗打开时锁定顶栏（鼠标移动到 portal 内容会触发根元素
  // mouseleave，不锁定会把还开着的菜单连顶栏一起收走）
  const menuLocked =
    themeOpen ||
    themeClosing ||
    userOpen ||
    userClosing ||
    backgroundModalOpen ||
    serverModalOpen ||
    announceOpen
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

  // 混合内容检测与草稿状态已随弹窗迁入 ServerUrlModal

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
            label: '管理页面',
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
        style={
          {
            // 玻璃作用域文字色：顶栏是主题驱动的玻璃面（glass），文字/图标
            // 用按「含玻璃层背景」判定的 scheme 文字色（ThemeProvider 注入
            // --lt-glass-*），不跟随壁纸级切换——深色模式亮壁纸下玻璃菜单/
            // 顶栏若跟随切深字会深字配深面不可读
            '--md-sys-color-on-surface': 'var(--lt-glass-on-surface)',
            '--md-sys-color-on-surface-variant':
              'var(--lt-glass-on-surface-variant)',
            '--md-sys-color-outline': 'var(--lt-glass-outline)',
            '--md-sys-color-outline-variant': 'var(--lt-glass-outline-variant)',
          } as React.CSSProperties
        }
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
          {/* 公告按钮（含首次启动/版本更新自动弹出逻辑） */}
          <AnnouncementButton onOpenChange={setAnnounceOpen} />
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
          {/* 手机端隐藏 CLI 下载入口（移动端不支持 CLI 代理，无下载意义） */}
          {!isMobile && (
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
          )}

          <button
            type="button"
            onClick={() => setServerModalOpen(true)}
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
                  // 默认只显示主面板，不保留上次打开的自定义主题/背景侧面板
                  setCustomColorOpen(false)
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
                  {/* 侧面板位槽：宽度承载「自定义背景/自定义主题」任一展开
                      （二者互斥），0↔300px 动画并裁剪内部。两个面板绝对
                      定位叠加于槽内右缘，各自 translateX 滑动（收起右移藏
                      到主面板后方）——切换时新旧面板同步左移、在槽内无缝
                      推挤：新面板从主面板一侧向左滑入，旧面板向左滑出被
                      裁剪，无淡入淡出 */}
                  <div
                    className="relative h-full flex-shrink-0 overflow-hidden"
                    style={{
                      width: backgroundModalOpen || customColorOpen ? 300 : 0,
                      transition: 'width 240ms var(--ease-out-expo)',
                      willChange: 'width',
                    }}
                  >
                    <BackgroundSettingsPanel
                      open={backgroundModalOpen}
                      onClose={() => setBackgroundModalOpen(false)}
                    />
                    <CustomColorPanel open={customColorOpen} />
                  </div>
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

                    {/* 自定义主题入口：展开/收起左侧主题色编辑栏 */}
                    <button
                      onClick={() => {
                        const next = !customColorOpen
                        setCustomColorOpen(next)
                        // 显式互斥：展开主题色栏时收起自定义背景面板
                        if (next) setBackgroundModalOpen(false)
                      }}
                      className={cn(
                        'zen-dropdown-item mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-[var(--md-sys-shape-corner)] text-sm transition-all hover:translate-x-0.5',
                        customColorOpen
                          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-[var(--md-sys-color-primary)]'
                          : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                      )}
                      style={
                        {
                          border: '1px solid var(--md-sys-color-outline)',
                          '--item-delay': '280ms',
                        } as React.CSSProperties
                      }
                    >
                      <Palette className="w-4 h-4 text-[var(--md-sys-color-primary)]" />
                      <span className="flex-1 text-left">自定义主题</span>
                    </button>

                    {/* 自定义背景入口 */}
                    <button
                      ref={backgroundBtnRef}
                      onClick={() => {
                        const next = !backgroundModalOpen
                        setBackgroundModalOpen(next)
                        // 显式互斥：展开背景面板时收起主题色栏
                        if (next) setCustomColorOpen(false)
                      }}
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
                          backgroundColor: 'var(--glass-bg)',
                          '--item-delay': '0ms',
                        } as React.CSSProperties
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
                      className="h-px mx-1 my-1.5"
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
                        className="zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-primary)] transition-all hover:bg-[var(--md-sys-color-primary-container)] hover:translate-x-0.5"
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

      {/* 顶部占位，避免内容被 fixed header 遮挡。听模式沉浸不占位：顶栏
          悬浮显示不推挤内容（translate 动画），取消占位让 h-screen 底板
          （含播放器覆盖层）真正从视口顶部开始 */}
      {!immersive && <div style={{ height: '64px' }} />}

      {serverModalOpen && (
        <ServerUrlModal onClose={() => setServerModalOpen(false)} />
      )}

      {/* 离开房间确认对话框 */}
      {exitGuardModal}
    </>
  )
}
