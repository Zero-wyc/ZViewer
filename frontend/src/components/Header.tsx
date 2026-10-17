import { useState, useRef, useEffect, useCallback } from 'react'
import { Download, Server } from 'lucide-react'
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
import { useIsMobile } from '@/hooks/useMediaQuery'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'
import { AnnouncementButton } from '@/components/Announcement'
import { ServerUrlModal } from '@/components/header/ServerUrlModal'
import { ThemeMenu } from '@/components/header/ThemeMenu'
import { UserMenu } from '@/components/header/UserMenu'
import { usePortalDropdown } from '@/components/header/usePortalDropdown'

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
  const { user, isAuthenticated } = useAuthStore()
  const isMobile = useIsMobile()
  // 两个下拉菜单共用同一套 portal 行为（定位 / 开合动画 / 外部点击收起）
  const {
    buttonRef: themeBtnRef,
    menuRef: themeMenuRef,
    open: themeOpen,
    closing: themeClosing,
    position: themeMenuPos,
    show: showThemeMenu,
    hide: hideThemeMenu,
  } = usePortalDropdown()
  const {
    buttonRef: userBtnRef,
    menuRef: userMenuRef,
    open: userOpen,
    closing: userClosing,
    position: userMenuPos,
    show: showUserMenu,
    hide: hideUserMenu,
    hideNow: closeUserMenuNow,
  } = usePortalDropdown()
  /** 自定义主题色编辑栏：默认收起，点主面板「自定义主题」按钮展开，
      仅当自定义背景面板展开时暂时收起（二者互斥防宽度溢出） */
  const [customColorOpen, setCustomColorOpen] = useState(false)
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

  /** 主题菜单开合：打开时同时收起两个侧栏，不保留上次打开的自定义面板 */
  const toggleThemeMenu = () => {
    if (themeOpen) {
      hideThemeMenu()
      return
    }
    showThemeMenu()
    setCustomColorOpen(false)
    setBackgroundModalOpen(false)
  }

  const toggleUserMenu = () => {
    if (userOpen) hideUserMenu()
    else showUserMenu()
  }

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

          <ThemeMenu
            open={themeOpen}
            closing={themeClosing}
            position={themeMenuPos}
            buttonRef={themeBtnRef}
            menuRef={themeMenuRef}
            onToggle={toggleThemeMenu}
            customColorOpen={customColorOpen}
            setCustomColorOpen={setCustomColorOpen}
            backgroundOpen={backgroundModalOpen}
            setBackgroundOpen={setBackgroundModalOpen}
          />
          {isAuthenticated && user && (
            <UserMenu
              user={user}
              open={userOpen}
              closing={userClosing}
              position={userMenuPos}
              buttonRef={userBtnRef}
              menuRef={userMenuRef}
              onToggle={toggleUserMenu}
              onCloseNow={closeUserMenuNow}
              needsGuard={needsGuard}
              guardNavigate={guardNavigate}
            />
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
